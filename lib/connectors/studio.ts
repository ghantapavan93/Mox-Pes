import type { Queryable } from "@/lib/db";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { redactValue } from "@/lib/adapters/redact";
import { toJob, type SyncJob } from "@/lib/jobs/sync";
import { connectorOffices, credentialStatus, listConnectorRows, type ConnectorRow, type CredentialSource } from "./config";
import { isConnectorError } from "./errors";
import { CRM_ENTITIES, type ApiCallRecord, type CrmConnector, type CrmEntity } from "./types";

/**
 * Read models for the CRM Integration Studio. Every function takes the viewer's branch scope
 * (null = all) and filters office-keyed rows through branches.crm_office_id, so an API or page
 * built on them cannot leak another branch's sync state.
 */

const HOUR = 3_600_000;

export type HealthStatus = "healthy" | "degraded" | "failing" | "idle";

export interface ConnectorHealth {
  status: HealthStatus;
  reason: string;
  lastSuccessAt: Date | null;
  lastActivityAt: Date | null;
  jobs: { queued: number; running: number; retrying: number; failed: number; succeeded: number; cancelled: number };
  records: { read: number; changed: number; duplicates: number; quarantined: number; rejected: number };
  apiCalls: { total: number; errors: number; lastErrorAt: Date | null; lastError: string | null };
  rateLimit: { last429At: Date | null; count: number; nextRetryAt: Date | null };
  freshness: { offices: number; streams: number; streamsWithCheckpoint: number; oldestCursor: Date | null; newestCursor: Date | null; worstLagMs: number | null };
}

export interface ConnectorSummary {
  connector: Pick<ConnectorRow, "id" | "slug" | "displayName" | "baseUrl" | "baseUrlSource" | "baseUrlEnv" | "synthetic" | "enabled"> & {
    timeoutMs: number;
    wireTimeZone: string;
    initialLookbackHours: number;
    maxAttempts: number;
    keyEnvTemplate: string;
    tokenEnvTemplate: string;
  };
  credentialSources: Record<CredentialSource, number>;
  health: ConnectorHealth;
}

const scopeJoin = `join branches b on b.crm_office_id = j.office_id and ($2::text[] is null or b.id = any($2::text[]))`;

export async function connectorHealth(db: Queryable, connector: ConnectorRow, scope: string[] | null, businessNow: Date, wallNow: Date): Promise<ConnectorHealth> {
  const offices = (await connectorOffices(db, connector)).filter((o) => scope === null || scope.includes(o.branchId));
  const [jobs, latest, calls, limits, checkpoints] = await Promise.all([
    db.query<Record<string, string | null>>(
      `select count(*) filter (where state = 'queued') as queued,
              count(*) filter (where state = 'running') as running,
              count(*) filter (where state = 'queued' and last_error_kind is not null) as retrying,
              count(*) filter (where state = 'failed') as failed,
              count(*) filter (where state = 'succeeded') as succeeded,
              count(*) filter (where state = 'cancelled') as cancelled,
              max(finished_at) filter (where state = 'succeeded') as last_success,
              greatest(max(finished_at), max(heartbeat_at), max(requested_at)) as last_activity,
              coalesce(sum((stats->>'fetched')::bigint), 0) as read,
              coalesce(sum((stats->>'inserted')::bigint), 0) as changed,
              coalesce(sum((stats->>'duplicates')::bigint), 0) as duplicates,
              coalesce(sum((stats->>'quarantined')::bigint), 0) as quarantined,
              coalesce(sum((stats->>'rejected')::bigint), 0) as rejected
       from sync_jobs j ${scopeJoin} where j.connector_id = $1`,
      [connector.id, scope],
    ),
    // The most recent job per stream decides whether a stream is currently broken.
    db.query<{ state: string; n: string }>(
      `select state, count(*) as n from (
         select distinct on (j.office_id, j.entity) j.state from sync_jobs j ${scopeJoin}
         where j.connector_id = $1 and j.state in ('succeeded', 'failed', 'cancelled')
         order by j.office_id, j.entity, j.finished_at desc, j.id desc) t group by state`,
      [connector.id, scope],
    ),
    db.query<{ total: string; errors: string; last_error_at: Date | null; last_error: string | null }>(
      `select count(*) as total, count(*) filter (where j.error is not null) as errors,
              max(j.at) filter (where j.error is not null) as last_error_at,
              (array_agg(j.error order by j.at desc, j.id desc) filter (where j.error is not null))[1] as last_error
       from sync_api_calls j ${scopeJoin} where j.connector_id = $1`,
      [connector.id, scope],
    ),
    db.query<{ last429: Date | null; n: string; next_retry: Date | null }>(
      `select max(c.at) as last429, count(*) as n,
              (select min(q.next_attempt_at) from sync_jobs q
                 join branches qb on qb.crm_office_id = q.office_id and ($2::text[] is null or qb.id = any($2::text[]))
                where q.connector_id = $1 and q.state = 'queued' and q.last_error_kind = 'rate_limit') as next_retry
       from sync_api_calls c join branches b on b.crm_office_id = c.office_id and ($2::text[] is null or b.id = any($2::text[]))
       where c.connector_id = $1 and c.status = 429`,
      [connector.id, scope],
    ),
    db.query<{ n: string; oldest: Date | null; newest: Date | null }>(
      `select count(*) as n, min(cursor_at) as oldest, max(cursor_at) as newest
       from sync_checkpoints j ${scopeJoin} where j.connector_id = $1`,
      [connector.id, scope],
    ),
  ]);
  const j = jobs.rows[0];
  const n = (v: string | null | undefined) => Number(v ?? 0);
  const latestFailed = n(latest.rows.find((r) => r.state === "failed")?.n);
  const last429 = limits.rows[0].last429;
  const recent429 = last429 !== null && wallNow.getTime() - new Date(last429).getTime() < HOUR;
  const streams = offices.length * CRM_ENTITIES.length;
  const oldest = checkpoints.rows[0].oldest;

  const health: ConnectorHealth = {
    status: "healthy",
    reason: "",
    lastSuccessAt: j.last_success ? new Date(j.last_success) : null,
    lastActivityAt: j.last_activity ? new Date(j.last_activity) : null,
    jobs: { queued: n(j.queued), running: n(j.running), retrying: n(j.retrying), failed: n(j.failed), succeeded: n(j.succeeded), cancelled: n(j.cancelled) },
    records: { read: n(j.read), changed: n(j.changed), duplicates: n(j.duplicates), quarantined: n(j.quarantined), rejected: n(j.rejected) },
    apiCalls: { total: n(calls.rows[0].total), errors: n(calls.rows[0].errors), lastErrorAt: calls.rows[0].last_error_at, lastError: calls.rows[0].last_error },
    rateLimit: { last429At: last429, count: n(limits.rows[0].n), nextRetryAt: limits.rows[0].next_retry },
    freshness: {
      offices: offices.length,
      streams,
      streamsWithCheckpoint: n(checkpoints.rows[0].n),
      oldestCursor: oldest,
      newestCursor: checkpoints.rows[0].newest,
      worstLagMs: oldest ? businessNow.getTime() - new Date(oldest).getTime() : null,
    },
  };
  if (n(j.queued) + n(j.running) + n(j.succeeded) + n(j.failed) + n(j.cancelled) === 0) {
    Object.assign(health, { status: "idle", reason: "No sync has run yet." });
  } else if (latestFailed > 0) {
    Object.assign(health, { status: "failing", reason: `${latestFailed} stream${latestFailed === 1 ? "" : "s"} failed on the latest run and need${latestFailed === 1 ? "s" : ""} a person.` });
  } else if (n(j.retrying) > 0 || recent429) {
    Object.assign(health, { status: "degraded", reason: n(j.retrying) > 0 ? `${n(j.retrying)} job(s) backing off before a retry.` : "Rate limited in the last hour." });
  } else {
    Object.assign(health, { status: "healthy", reason: "Every stream's latest run succeeded." });
  }
  return health;
}

export async function connectorSummaries(db: Queryable, scope: string[] | null, businessNow: Date, wallNow: Date): Promise<ConnectorSummary[]> {
  const connectors = await listConnectorRows(db);
  return Promise.all(
    connectors.map(async (c) => {
      const offices = (await connectorOffices(db, c)).filter((o) => scope === null || scope.includes(o.branchId));
      const credentialSources: Record<CredentialSource, number> = { env: 0, demo: 0, missing: 0 };
      for (const o of offices) credentialSources[credentialStatus(c, o.officeId).source] += 1;
      return {
        connector: {
          id: c.id, slug: c.slug, displayName: c.displayName, baseUrl: c.baseUrl, baseUrlSource: c.baseUrlSource, baseUrlEnv: c.baseUrlEnv,
          synthetic: c.synthetic, enabled: c.enabled, timeoutMs: c.config.timeoutMs, wireTimeZone: c.config.wireTimeZone,
          initialLookbackHours: c.config.initialLookbackHours, maxAttempts: c.config.maxAttempts,
          keyEnvTemplate: c.config.credentials.keyEnv, tokenEnvTemplate: c.config.credentials.tokenEnv,
        },
        credentialSources,
        health: await connectorHealth(db, c, scope, businessNow, wallNow),
      };
    }),
  );
}

export interface JobListRow extends SyncJob {
  branchId: string;
}

export async function listJobs(db: Queryable, args: { connectorId: number; scope: string[] | null; limit: number; state?: string | null }): Promise<JobListRow[]> {
  const { rows } = await db.query(
    `select j.*, b.id as branch_id from sync_jobs j ${scopeJoin}
     where j.connector_id = $1 and ($4::text is null or j.state = $4)
     order by j.id desc limit $3`,
    [args.connectorId, args.scope, args.limit, args.state ?? null],
  );
  return rows.map((r) => ({ ...toJob(r as Parameters<typeof toJob>[0]), branchId: r.branch_id as string }));
}

export interface OfficeStream {
  entity: CrmEntity;
  cursorAt: Date | null;
  recordsSynced: number;
  lagMs: number | null;
  latestJob: { id: number; state: string; lastError: string | null; lastErrorKind: string | null } | null;
}

export interface OfficeRow {
  officeId: number;
  branchId: string;
  branchName: string;
  credentialSource: CredentialSource;
  keyEnv: string;
  streams: OfficeStream[];
}

export async function officeGrid(db: Queryable, connector: ConnectorRow, scope: string[] | null, businessNow: Date): Promise<OfficeRow[]> {
  const offices = (await connectorOffices(db, connector)).filter((o) => scope === null || scope.includes(o.branchId));
  const [checkpoints, latest] = await Promise.all([
    db.query<{ office_id: number; entity: CrmEntity; cursor_at: Date; records_synced: string }>(
      "select office_id, entity, cursor_at, records_synced from sync_checkpoints where connector_id = $1",
      [connector.id],
    ),
    db.query<{ office_id: number; entity: CrmEntity; id: string; state: string; last_error: string | null; last_error_kind: string | null }>(
      `select distinct on (office_id, entity) office_id, entity, id, state, last_error, last_error_kind
       from sync_jobs where connector_id = $1 order by office_id, entity, id desc`,
      [connector.id],
    ),
  ]);
  const key = (o: number, e: string) => `${o}:${e}`;
  const cp = new Map(checkpoints.rows.map((r) => [key(r.office_id, r.entity), r]));
  const lj = new Map(latest.rows.map((r) => [key(r.office_id, r.entity), r]));
  return offices.map((o) => {
    const cred = credentialStatus(connector, o.officeId);
    return {
      officeId: o.officeId,
      branchId: o.branchId,
      branchName: o.branchName,
      credentialSource: cred.source,
      keyEnv: cred.keyEnv,
      streams: CRM_ENTITIES.map((entity) => {
        const c = cp.get(key(o.officeId, entity));
        const j = lj.get(key(o.officeId, entity));
        return {
          entity,
          cursorAt: c?.cursor_at ?? null,
          recordsSynced: Number(c?.records_synced ?? 0),
          lagMs: c ? businessNow.getTime() - new Date(c.cursor_at).getTime() : null,
          latestJob: j ? { id: Number(j.id), state: j.state, lastError: j.last_error, lastErrorKind: j.last_error_kind } : null,
        };
      }),
    };
  });
}

export interface ApiCallRow {
  id: number;
  attempt: number;
  officeId: number;
  entity: string;
  action: string;
  method: string;
  path: string;
  status: number | null;
  ms: number;
  ids: number[];
  idCount: number;
  errorKind: string | null;
  error: string | null;
  at: Date;
}

export interface JobDetail {
  job: SyncJob;
  branchId: string;
  branchName: string;
  connectorSlug: string;
  calls: ApiCallRow[];
  audit: Array<{ id: number; at: Date; actor: string; action: string; detail: Record<string, unknown> }>;
  retries: Array<{ id: number; state: string }>;
}

export async function getJobDetail(db: Queryable, jobId: number, scope: string[] | null): Promise<JobDetail | null> {
  const { rows } = await db.query(
    `select j.*, b.id as branch_id, b.name as branch_name, c.slug as connector_slug
     from sync_jobs j ${scopeJoin} join connectors c on c.id = j.connector_id where j.id = $1`,
    [jobId, scope],
  );
  if (!rows[0]) return null;
  const [calls, audit, retries] = await Promise.all([
    db.query(`select * from sync_api_calls where job_id = $1 order by id`, [jobId]),
    db.query(`select id, at, actor, action, detail from audit_log where subject = $1 order by id`, [`sync_job:${jobId}`]),
    db.query(`select id, state from sync_jobs where retry_of = $1 order by id`, [jobId]),
  ]);
  return {
    job: toJob(rows[0] as Parameters<typeof toJob>[0]),
    branchId: rows[0].branch_id,
    branchName: rows[0].branch_name,
    connectorSlug: rows[0].connector_slug,
    calls: calls.rows.map((c) => ({
      id: Number(c.id), attempt: c.attempt, officeId: c.office_id, entity: c.entity, action: c.action, method: c.method, path: c.path,
      status: c.status, ms: c.ms, ids: (c.ids as string[]).map(Number), idCount: c.id_count, errorKind: c.error_kind, error: c.error, at: c.at,
    })),
    audit: audit.rows.map((a) => ({ id: Number(a.id), at: a.at, actor: a.actor, action: a.action, detail: a.detail })),
    retries: retries.rows.map((r) => ({ id: Number(r.id), state: r.state })),
  };
}

/** Raw events per CRM mapper version: which code mapped what is stored now. */
export async function mapperUsage(db: Queryable): Promise<Array<{ adapterVersion: string; events: number; quarantined: number }>> {
  const { rows } = await db.query<{ adapter_version: string; events: string; quarantined: string }>(
    `select adapter_version, count(*) as events, count(*) filter (where status = 'quarantined') as quarantined
     from raw_events where source = 'crm' group by adapter_version order by adapter_version`,
  );
  return rows.map((r) => ({ adapterVersion: r.adapter_version, events: Number(r.events), quarantined: Number(r.quarantined) }));
}

// ── Source vs destination compare ───────────────────────────────────────────

const PROJECTION: Record<CrmEntity, { table: string; key: string }> = {
  customer: { table: "crm_customers", key: "crm_customer_id" },
  subscription: { table: "crm_subscriptions", key: "crm_subscription_id" },
  appointment: { table: "crm_appointments", key: "crm_appointment_id" },
  ticket: { table: "crm_tickets", key: "crm_ticket_id" },
  payment: { table: "crm_payments", key: "crm_payment_id" },
};

const snake = (s: string) => s.replace(/[A-Z]/g, (c) => `_${c.toLowerCase()}`);
const comparable = (v: unknown): string | null => {
  if (v === null || v === undefined) return null;
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "string" && /^\d{4}-\d{2}-\d{2}T/.test(v)) return new Date(v).toISOString();
  return String(v).trim();
};

export interface CompareResult {
  entity: CrmEntity;
  recordId: number;
  officeId: number | null;
  branchId: string | null;
  /** What the source says now, redacted exactly as the pipeline redacts it. */
  source: { found: boolean; payload: Record<string, unknown> | null; error: string | null };
  /** What the deployed mapper would make of the source record. */
  mapped: { ok: boolean; row: Record<string, unknown> | null; error: string | null; mapperVersion: string };
  /** What the projection holds. */
  stored: Record<string, unknown> | null;
  fields: Array<{ column: string; mapped: string | null; stored: string | null; match: boolean }>;
  versions: Array<{ rawEventId: number; externalId: string; status: string; errorCode: string | null; receivedAt: Date; deliveryCount: number; live: boolean }>;
  verdict: "in_sync" | "differs" | "missing_downstream" | "missing_at_source" | "unmappable";
}

/**
 * One record, three views: the source (fetched through the connector client, i.e. real HTTP
 * against the mock), the deployed mapper's projection of it, and the stored projection row,
 * plus every raw version received. Scope is checked against the record's office.
 */
export async function compareRecord(
  db: Queryable,
  args: { connector: CrmConnector; entity: CrmEntity; recordId: number; officeId: number | null; scope: string[] | null },
): Promise<CompareResult | null> {
  const { entity, recordId } = args;
  const proj = PROJECTION[entity];
  const stored = (await db.query(`select * from ${proj.table} where ${proj.key} = $1`, [recordId])).rows[0] ?? null;
  const officeId = args.officeId ?? (stored ? Number(stored.office_id) : null);
  if (officeId === null) return null;
  const branch = (await db.query<{ id: string }>("select id from branches where crm_office_id = $1", [officeId])).rows[0]?.id ?? null;
  // Out of scope is indistinguishable from not found.
  if (args.scope !== null && (!branch || !args.scope.includes(branch))) return null;
  if (stored && Number(stored.office_id) !== officeId) return null;

  let source: CompareResult["source"];
  try {
    const got = await args.connector.get(entity, { officeId, ids: [recordId] });
    const payload = got.records[0]?.payload as Record<string, unknown> | undefined;
    source = { found: Boolean(payload), payload: payload ? (redactValue(payload) as Record<string, unknown>) : null, error: got.rejected[0]?.message ?? null };
  } catch (error) {
    source = { found: false, payload: null, error: isConnectorError(error) ? `${error.kind}: ${error.message}` : (error as Error).message };
  }

  const mapper = mapperFor("crm");
  let mapped: CompareResult["mapped"] = { ok: false, row: null, error: null, mapperVersion: mapper.version };
  if (source.payload) {
    const result = mapper.map({ entity, payload: source.payload }, referenceContext);
    mapped = result.ok
      ? { ok: true, row: result.projection.row as unknown as Record<string, unknown>, error: null, mapperVersion: mapper.version }
      : { ok: false, row: null, error: `${result.code}: ${result.detail}`, mapperVersion: mapper.version };
  }

  const fields = mapped.row
    ? Object.entries(mapped.row)
        .filter(([k]) => k !== "sourceUpdatedAt" || entity !== "payment") // payments: receipt-ordered, not comparable
        .map(([k, v]) => {
          const column = snake(k);
          const m = comparable(v);
          const s = stored ? comparable(stored[column]) : null;
          return { column, mapped: m, stored: s, match: stored !== null && m === s };
        })
    : [];

  const versions = await db.query<{ id: string; external_id: string; status: string; error_code: string | null; received_at: Date; delivery_count: number }>(
    `select id, external_id, status, error_code, received_at, delivery_count from raw_events
     where source = 'crm' and entity = $1 and entity_id = $2 order by received_at, id`,
    [entity, String(recordId)],
  );
  const liveId = stored ? String(stored.raw_event_id) : null;

  const verdict: CompareResult["verdict"] = !source.found
    ? "missing_at_source"
    : !mapped.ok
      ? "unmappable"
      : !stored
        ? "missing_downstream"
        : fields.every((f) => f.match)
          ? "in_sync"
          : "differs";

  return {
    entity,
    recordId,
    officeId,
    branchId: branch,
    source,
    mapped,
    stored: stored ? Object.fromEntries(Object.entries(stored).map(([k, v]) => [k, comparable(v)])) : null,
    fields,
    versions: versions.rows.map((v) => ({
      rawEventId: Number(v.id), externalId: v.external_id, status: v.status, errorCode: v.error_code, receivedAt: v.received_at,
      deliveryCount: v.delivery_count, live: v.id === liveId,
    })),
    verdict,
  };
}

/** Records calls made outside a job (compare, connection checks) into the trace. */
export async function recordAdHocCalls(db: Queryable, connectorId: number, calls: ApiCallRecord[]): Promise<void> {
  if (calls.length === 0) return;
  await db.query(
    `insert into sync_api_calls (job_id, connector_id, attempt, office_id, entity, action, method, path, status, ms, ids, id_count, error_kind, error, at)
     select null, $1, 0, r."officeId", r."entity", r."action", r."method", r."path", r."status", r."ms",
       coalesce((select array_agg(x::bigint) from jsonb_array_elements_text(r."ids") x), '{}'), r."idCount", r."errorKind", r."error", r."at"
     from jsonb_to_recordset($2::jsonb) as r("officeId" int, "entity" text, "action" text, "method" text, "path" text, "status" int,
       "ms" int, "ids" jsonb, "idCount" int, "errorKind" text, "error" text, "at" timestamptz)`,
    [connectorId, JSON.stringify(calls)],
  );
}
