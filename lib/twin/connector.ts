import type { Pool } from "pg";
import { createPool, getNow } from "@/lib/db";
import { getConnector, resolveCredentials } from "@/lib/connectors/config";
import { AuthError } from "@/lib/connectors/errors";
import { createFault } from "@/lib/connectors/faults";
import { FieldRoutesHttpClient } from "@/lib/connectors/fieldroutes-client";
import { createMockFieldRoutes, dbFaultStore } from "@/lib/connectors/mock-fieldroutes";
import type { ApiCallRecord, CrmConnector, CrmEntity } from "@/lib/connectors/types";
import { enqueueSync, retryJob, runPendingJobs, type SyncRuntime } from "@/lib/jobs/sync";
import { BRANCH_BY_OFFICE } from "@/lib/reference";
import type { SourceRecordVersion } from "@/lib/sim/world";
import type { BackfillPlan } from "./scenario";

/**
 * The stage's CRM backfill through the PRODUCTION sync worker (lib/jobs/sync.ts): enqueue, claim,
 * search, get, ingest per batch, checkpoint, retry by error type, re-queue a lost worker. Only the
 * far end is simulated: the mock FieldRoutes server (lib/connectors/mock-fieldroutes.ts) answers
 * in-process, from the synthetic world plus the scenario's new customers, with the stage's faults.
 *
 * The wall clock is simulated. Backoff and Retry-After waits move it forward instead of sleeping,
 * and the time waited is reported as retry overhead. A request timeout is real (the client's
 * abort), and short.
 *
 * A worker that "dies" stops at a deterministic point: it has committed `afterBatches` batches of
 * its job and is fetching the next. Its connection pool is closed there, so it can never write
 * again, and its unfinished work is left exactly as a crashed process leaves it: the job running,
 * its heartbeat ageing. The next worker re-queues it after the stale timeout and resumes it from
 * the last committed batch.
 */

/** Small batches, so a seven-day window spans several committed batches (production: 1,000). */
const GET_LIMIT = 20;
export const CLIENT_TIMEOUT_MS = 5_000;
const STALE_AFTER_MS = 5 * 60_000;
const MAX_ROUNDS = 200;

export interface BackfillReport {
  requestKey: string;
  offices: number[];
  entities: CrmEntity[];
  jobs: Array<{ id: number; officeId: number; entity: string; state: string; attempts: number; retryOf: number | null; lastErrorKind: string | null; stats: Record<string, number> }>;
  calls: { total: number; byStatus: Record<string, number> };
  retriesScheduled: number;
  simulatedWaitMs: number;
  workerDeath: null | { jobId: number; committedBatches: number; requeued: boolean; resumedAfterId: string | null };
  runbookRetries: number[];
  /** Expected new records (the scenario's) for these offices, and how many are stored once and projected. */
  expected: { records: number; stored: number; projected: number; storedTwice: number };
  wallMs: number;
}

function inProcessFetch(handler: (r: Request) => Promise<Response>): typeof fetch {
  return async (input, init) => handler(new Request(input as string, init));
}

export async function runBackfill(
  twin: Pool,
  args: { twinUrl: string; key: string; actor: string; officeIds: number[]; plan: BackfillPlan; world: () => SourceRecordVersion[]; overlay: SourceRecordVersion[] },
): Promise<BackfillReport> {
  const started = Date.now();
  const connectorId = Number((await twin.query<{ id: string }>("select id from connectors where slug = 'fieldroutes-demo'")).rows[0].id);
  const connector = (await getConnector(twin, connectorId))!;
  // Resume the simulated wall clock where this backfill's jobs left it.
  const clock = await twin.query<{ t: Date | null }>(
    "select greatest(max(next_attempt_at), max(heartbeat_at), max(finished_at), max(requested_at)) as t from sync_jobs where request_key like $1",
    [`${args.key}%`],
  );
  let wall = new Date(Math.max(clock.rows[0].t?.getTime() ?? 0, Date.parse("2026-11-01T09:00:00Z")));
  const businessAt = await getNow(twin);

  // The stage's faults, once: a resumed backfill finds them already there.
  const existing = await twin.query("select 1 from mock_fieldroutes_faults where created_by = $1 limit 1", [args.key]);
  if (existing.rowCount === 0) for (const input of args.plan.faults) await createFault(twin, { input, actor: args.key, now: wall, auditAt: businessAt });

  const records = [...args.world(), ...args.overlay];
  const mock = createMockFieldRoutes({ records: () => records, clock: () => getNow(twin), faults: dbFaultStore(twin), getLimit: GET_LIMIT, wallNow: () => wall.getTime() });
  const fetchImpl = inProcessFetch(mock);
  const client = (onCall: (c: ApiCallRecord) => void) =>
    new FieldRoutesHttpClient({
      baseUrl: "http://localhost:3000/api/mock/fieldroutes",
      credentials: (officeId) => {
        const r = resolveCredentials(connector, officeId, {});
        if (!r.credentials) throw new AuthError(`No credentials for office ${officeId}`);
        return r.credentials;
      },
      fetch: fetchImpl,
      // Long enough that the in-process mock, busy with four workers at once, never trips it by
      // accident (a 500 ms limit did, in the first run); the planned timeout fault outlasts it.
      timeoutMs: CLIENT_TIMEOUT_MS,
      wireTimeZone: "office",
      officeTimeZone: (officeId) => BRANCH_BY_OFFICE.get(officeId)?.timezone,
      getLimit: GET_LIMIT,
      onCall,
      now: () => wall,
    });
  const runtime = (pool: Pool, workerId: string, wrap?: (c: CrmConnector) => CrmConnector): SyncRuntime => ({
    pool,
    clientFor: (_c, onCall) => (wrap ? wrap(client(onCall)) : client(onCall)),
    now: () => wall,
    businessNow: () => getNow(twin),
    workerId,
    random: () => 0.5,
    staleAfterMs: STALE_AFTER_MS,
  });

  await enqueueSync(twin, { connectorId, officeIds: args.officeIds, entities: args.plan.entities, idempotencyKey: args.key, actor: args.actor, scope: null, now: wall, auditAt: businessAt });

  // ── The worker that dies ──
  let workerDeath: BackfillReport["workerDeath"] = null;
  const death = args.plan.workerDeath;
  const deathJob = death
    ? await twin.query<{ id: string; state: string }>("select id, state from sync_jobs where request_key = $1 and office_id = $2 and entity = $3", [args.key, death.officeId, death.entity])
    : null;
  if (death && deathJob?.rows[0] && deathJob.rows[0].state === "queued") {
    const doomedPool = createPool(args.twinUrl);
    let reached!: () => void;
    const atDeath = new Promise<void>((resolve) => (reached = resolve));
    let gets = 0;
    const wrap = (c: CrmConnector): CrmConnector => {
      const doomed: CrmConnector = Object.create(c);
      doomed.get = async (entity, request) => {
        if (request.officeId === death.officeId && entity === death.entity && ++gets > death.afterBatches) {
          reached();
          return new Promise<never>(() => undefined); // the process is gone: this call never returns
        }
        return c.get(entity, request);
      };
      return doomed;
    };
    // Only the doomed job is runnable for this worker: it claims by due time, so it runs first.
    await twin.query("update sync_jobs set next_attempt_at = $2 where request_key = $1 and id <> $3 and state = 'queued'", [args.key, new Date(wall.getTime() + 1), deathJob.rows[0].id]);
    // Worker names carry the evaluation, so their log lines say they are the twin's (SRE M1).
    void runPendingJobs(runtime(doomedPool, `${args.actor}:worker-lost`, wrap), { maxJobs: 1 }).catch(() => undefined);
    await atDeath;
    await doomedPool.end().catch(() => undefined);
    const after = await twin.query<{ resume_after_id: string | null; stats: { batches?: number } }>("select resume_after_id, stats from sync_jobs where id = $1", [deathJob.rows[0].id]);
    workerDeath = { jobId: Number(deathJob.rows[0].id), committedBatches: after.rows[0].stats.batches ?? 0, requeued: false, resumedAfterId: after.rows[0].resume_after_id };
    // The rest of the backfill becomes due again; the dead worker's job waits for the stale timeout.
    await twin.query("update sync_jobs set next_attempt_at = $2 where request_key = $1 and state = 'queued'", [args.key, wall]);
  }

  // ── Healthy workers, round after round, the simulated clock moving to the next due retry ──
  const runbookRetries: number[] = [];
  let simulatedWaitMs = 0;
  for (let round = 0; round < MAX_ROUNDS; round++) {
    await runPendingJobs(runtime(twin, `${args.actor}:worker`), { concurrency: 4, maxJobs: 500 });
    const open = await twin.query<{ next: Date | null; running: string; heartbeat: Date | null }>(
      `select min(next_attempt_at) filter (where state = 'queued') as next, count(*) filter (where state = 'running') as running,
              min(heartbeat_at) filter (where state = 'running') as heartbeat
       from sync_jobs where request_key like $1`,
      [`${args.key}%`],
    );
    const o = open.rows[0];
    if (o.next) {
      const wait = Math.max(0, o.next.getTime() - wall.getTime());
      simulatedWaitMs += wait;
      wall = new Date(wall.getTime() + wait + 1);
      continue;
    }
    if (Number(o.running) > 0 && o.heartbeat) {
      // A job is held by a worker that no longer answers: wait out the stale timeout.
      const wait = Math.max(0, o.heartbeat.getTime() + STALE_AFTER_MS - wall.getTime()) + 1;
      simulatedWaitMs += wait;
      wall = new Date(wall.getTime() + wait);
      if (workerDeath) workerDeath.requeued = true;
      continue;
    }
    // Everything has finished. The runbook: a job that used up its attempts is retried once.
    if (args.plan.runbookRetry) {
      const failed = await twin.query<{ id: string }>(
        `select j.id from sync_jobs j where j.request_key = $1 and j.state = 'failed'
           and not exists (select 1 from sync_jobs r where r.retry_of = j.id)`,
        [args.key],
      );
      if (failed.rows.length > 0) {
        for (const f of failed.rows) {
          const retried = await retryJob(twin, { jobId: Number(f.id), actor: `${args.actor}:runbook`, idempotencyKey: `${args.key}:runbook`, scope: null, now: wall, auditAt: businessAt });
          runbookRetries.push(retried.id);
        }
        continue;
      }
    }
    break;
  }

  const jobs = await twin.query<{ id: string; office_id: number; entity: string; state: string; attempts: number; retry_of: string | null; last_error_kind: string | null; stats: Record<string, number> }>(
    "select id, office_id, entity, state, attempts, retry_of, last_error_kind, stats from sync_jobs where request_key like $1 order by id",
    [`${args.key}%`],
  );
  const ids = jobs.rows.map((j) => Number(j.id));
  const calls = await twin.query<{ status: number | null; error_kind: string | null; n: string }>(
    "select status, error_kind, count(*) as n from sync_api_calls where job_id = any($1::bigint[]) group by 1, 2",
    [ids],
  );
  const byStatus: Record<string, number> = {};
  for (const c of calls.rows) {
    const label = c.status === null ? c.error_kind ?? "no response" : String(c.status);
    byStatus[label] = (byStatus[label] ?? 0) + Number(c.n);
  }
  const retries = await twin.query<{ n: string }>("select count(*) as n from audit_log where action = 'sync_job.retry_scheduled' and subject = any($1::text[])", [ids.map((id) => `sync_job:${id}`)]);

  // The scenario's new records for these offices: each stored exactly once, and projected.
  const expectedIds = args.overlay
    .filter((r) => args.officeIds.includes(Number(r.payload.officeID)) && args.plan.entities.includes(r.entity as CrmEntity))
    .map((r) => `${r.entity}:${String(r.payload[`${r.entity}ID`])}`);
  const stored = await twin.query<{ entity: string; entity_id: string; n: string; projected: string }>(
    `select entity, entity_id, count(*) as n, count(*) filter (where status = 'projected') as projected
     from raw_events where source = 'crm' and (entity || ':' || entity_id) = any($1::text[]) group by 1, 2`,
    [expectedIds],
  );
  return {
    requestKey: args.key,
    offices: args.officeIds,
    entities: args.plan.entities,
    jobs: jobs.rows.map((j) => ({ id: Number(j.id), officeId: j.office_id, entity: j.entity, state: j.state, attempts: j.attempts, retryOf: j.retry_of === null ? null : Number(j.retry_of), lastErrorKind: j.last_error_kind, stats: j.stats })),
    calls: { total: calls.rows.reduce((t, c) => t + Number(c.n), 0), byStatus },
    retriesScheduled: Number(retries.rows[0].n),
    simulatedWaitMs,
    workerDeath,
    runbookRetries,
    expected: {
      records: expectedIds.length,
      stored: stored.rows.length,
      projected: stored.rows.filter((r) => Number(r.projected) > 0).length,
      storedTwice: stored.rows.filter((r) => Number(r.n) > 1).length,
    },
    wallMs: Date.now() - started,
  };
}
