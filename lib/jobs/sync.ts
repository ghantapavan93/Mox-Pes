import type { Pool, PoolClient } from "pg";
import { ActionError } from "@/lib/actions";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { withTransaction, type Queryable } from "@/lib/db";
import { recordEvent } from "@/lib/events/outbox";
import { ingestRecords, type IngestStats } from "@/lib/ingest/ingest";
import { canonicalJson, sha256 } from "@/lib/primitives";
import { ForbiddenError } from "@/lib/viewer";
import { connectorOffices, credentialStatus, getConnector, type ConnectorRow } from "@/lib/connectors/config";
import { ConnectorError, RateLimitError, type ConnectorErrorKind } from "@/lib/connectors/errors";
import { CRM_ENTITIES, type ApiCallRecord, type CrmConnector, type CrmEntity } from "@/lib/connectors/types";

/**
 * Sync jobs: one job = one connector × office × entity × window.
 *
 * Why this shape
 *   * Office-scoped credentials mean office-scoped failure. A job never spans offices, so an
 *     expired key in one office fails one job and the other offices sync normally.
 *   * Long work stays out of request transactions. A request only ENQUEUES; a worker (npm run
 *     worker, or an after() kick from the API) claims jobs with FOR UPDATE SKIP LOCKED, and the
 *     partial unique index sync_jobs_one_running allows one running job per stream.
 *   * Records go through the existing ingestRecords + FieldRoutesMapper — the same write path
 *     as every other source, so duplicates are absorbed, bad records quarantined and payload
 *     conflicts detected exactly as for the in-memory pipeline.
 *   * Each get batch commits on its own, recording resume_after_id with it. The checkpoint
 *     moves to the window end only in the transaction of the LAST batch, so a failure anywhere
 *     leaves the checkpoint where it was, and a retry re-reads the same window from the last
 *     committed id: nothing is skipped and nothing is fetched twice.
 *   * Retry is decided by the error's type: rate limits, timeouts and outages back off
 *     exponentially (honouring Retry-After); auth and contract errors fail at once with a
 *     message saying what a person must do.
 *
 *   * Every write a worker makes after its claim is FENCED by (claimed_by, attempts): the pair
 *     is the claim's fencing token. A worker presumed dead (stale heartbeat) whose job was
 *     re-claimed can wake up later, but none of its writes match any more: its in-flight batch
 *     rolls back, it never moves the checkpoint, and it records no outcome.
 *
 * Clocks: scheduling columns use the wall clock (runtime.now); windows, checkpoints, receipt
 * times and audit entries use the business clock (app_clock), like the rest of the system.
 */

export type JobState = "queued" | "running" | "succeeded" | "failed" | "cancelled";

export interface JobStats {
  searched: number;
  fetched: number;
  inserted: number;
  duplicates: number;
  conflicts: number;
  projected: number;
  quarantined: number;
  rejected: number;
  missing: number;
  batches: number;
}

export const EMPTY_STATS: JobStats = { searched: 0, fetched: 0, inserted: 0, duplicates: 0, conflicts: 0, projected: 0, quarantined: 0, rejected: 0, missing: 0, batches: 0 };

export interface SyncJob {
  id: number;
  connectorId: number;
  officeId: number;
  entity: CrmEntity;
  state: JobState;
  requestKey: string;
  retryOf: number | null;
  requestedBy: string;
  requestedAt: Date;
  attempts: number;
  maxAttempts: number;
  nextAttemptAt: Date;
  startedAt: Date | null;
  heartbeatAt: Date | null;
  finishedAt: Date | null;
  cancelRequested: boolean;
  windowStart: Date | null;
  windowEnd: Date | null;
  resumeAfterId: number | null;
  stats: JobStats;
  lastError: string | null;
  lastErrorKind: string | null;
}

interface JobDbRow {
  id: string;
  connector_id: string;
  office_id: number;
  entity: CrmEntity;
  state: JobState;
  request_key: string;
  retry_of: string | null;
  requested_by: string;
  requested_at: Date;
  attempts: number;
  max_attempts: number;
  next_attempt_at: Date;
  started_at: Date | null;
  heartbeat_at: Date | null;
  finished_at: Date | null;
  cancel_requested: boolean;
  window_start: Date | null;
  window_end: Date | null;
  resume_after_id: string | null;
  stats: Partial<JobStats> | null;
  last_error: string | null;
  last_error_kind: string | null;
}

export function toJob(r: JobDbRow): SyncJob {
  return {
    id: Number(r.id),
    connectorId: Number(r.connector_id),
    officeId: r.office_id,
    entity: r.entity,
    state: r.state,
    requestKey: r.request_key,
    retryOf: r.retry_of === null ? null : Number(r.retry_of),
    requestedBy: r.requested_by,
    requestedAt: r.requested_at,
    attempts: r.attempts,
    maxAttempts: r.max_attempts,
    nextAttemptAt: r.next_attempt_at,
    startedAt: r.started_at,
    heartbeatAt: r.heartbeat_at,
    finishedAt: r.finished_at,
    cancelRequested: r.cancel_requested,
    windowStart: r.window_start,
    windowEnd: r.window_end,
    resumeAfterId: r.resume_after_id === null ? null : Number(r.resume_after_id),
    stats: { ...EMPTY_STATS, ...(r.stats ?? {}) },
    lastError: r.last_error,
    lastErrorKind: r.last_error_kind,
  };
}

export interface SyncRuntime {
  pool: Pool;
  /** Builds the client for one job attempt; `onCall` receives every HTTP exchange. */
  clientFor(connector: ConnectorRow, onCall: (call: ApiCallRecord) => void): CrmConnector;
  /** Wall clock: scheduling, backoff, heartbeats. */
  now(): Date;
  /** Business clock (app_clock): windows, receipt times, audit. */
  businessNow(): Promise<Date>;
  workerId: string;
  random?: () => number;
  /** First retry delay; doubles per attempt up to backoffCapMs. */
  backoffBaseMs?: number;
  backoffCapMs?: number;
  /** A running job whose heartbeat is older than this is presumed abandoned and re-queued. */
  staleAfterMs?: number;
}

const HOUR = 3_600_000;

async function audit(db: Queryable, at: Date, actor: string, action: string, subject: string, detail: Record<string, unknown>): Promise<void> {
  await db.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, $3, $4, $5)", [at, actor, action, subject, detail]);
}

/** Branches an office belongs to; used for viewer scope checks on office-keyed rows. */
async function branchOfOffice(db: Queryable, officeId: number): Promise<string | null> {
  const { rows } = await db.query<{ id: string }>("select id from branches where crm_office_id = $1", [officeId]);
  return rows[0]?.id ?? null;
}

// ── Enqueue ──────────────────────────────────────────────────────────────────

export interface EnqueueResult {
  requestKey: string;
  /** The same key was used before for the same request: nothing new was queued. */
  alreadyRequested: boolean;
  created: number[];
  /** Stream already had a queued job; it was reused instead of queueing a duplicate. */
  reusedQueued: number[];
  jobs: SyncJob[];
}

/**
 * Queues one job per office × entity. Idempotent by key: the same key with the same request
 * returns the original jobs; the same key with a different request is refused (409).
 * `scope` is the viewer's branch scope (null = all); asking for an office outside it is 403.
 */
export async function enqueueSync(
  pool: Pool,
  args: {
    connectorId: number;
    officeIds?: number[] | null;
    entities?: CrmEntity[] | null;
    idempotencyKey: string;
    actor: string;
    scope: string[] | null;
    now: Date;
    auditAt: Date;
  },
): Promise<EnqueueResult> {
  return withTransaction(pool, async (tx) => {
    const connector = await getConnector(tx, args.connectorId);
    if (!connector) throw new ActionError(`Connector ${args.connectorId} not found`, 404);
    if (!connector.enabled) throw new ActionError(`Connector ${connector.slug} is disabled`, 409);

    const all = await connectorOffices(tx, connector);
    const requested = args.officeIds && args.officeIds.length > 0 ? [...new Set(args.officeIds)].sort((a, b) => a - b) : null;
    if (requested) {
      const unknown = requested.filter((id) => !all.some((o) => o.officeId === id));
      if (unknown.length > 0) throw new ActionError(`Office(s) ${unknown.join(", ")} are not synced by ${connector.slug}`, 400);
    }
    const chosen = requested ? all.filter((o) => requested.includes(o.officeId)) : all;
    const outOfScope = chosen.filter((o) => args.scope !== null && !args.scope.includes(o.branchId));
    if (requested && outOfScope.length > 0) throw new ForbiddenError(`Cannot sync office(s) outside your branch scope: ${outOfScope.map((o) => o.officeId).join(", ")}`);
    const offices = chosen.filter((o) => args.scope === null || args.scope.includes(o.branchId));
    if (offices.length === 0) throw new ActionError("No offices in scope to sync", 400);
    const entities = args.entities && args.entities.length > 0 ? CRM_ENTITIES.filter((e) => args.entities!.includes(e)) : [...CRM_ENTITIES];

    const fingerprint = sha256(canonicalJson({ connectorId: connector.id, officeIds: offices.map((o) => o.officeId), entities }));
    // Serialise requests that share a key so two clicks cannot both create jobs.
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`sync-request:${args.idempotencyKey}`]);
    const prior = await tx.query<JobDbRow & { request_fingerprint: string }>("select * from sync_jobs where request_key = $1 order by id", [args.idempotencyKey]);
    if (prior.rows.length > 0) {
      if (prior.rows.some((r) => r.request_fingerprint !== fingerprint)) {
        throw new ActionError("This idempotency key was already used for a different sync request", 409);
      }
      return { requestKey: args.idempotencyKey, alreadyRequested: true, created: [], reusedQueued: [], jobs: prior.rows.map(toJob) };
    }

    const created: number[] = [];
    const reusedQueued: number[] = [];
    const jobs: SyncJob[] = [];
    for (const office of offices) {
      for (const entity of entities) {
        const queued = await tx.query<JobDbRow>(
          "select * from sync_jobs where connector_id = $1 and office_id = $2 and entity = $3 and state = 'queued' order by id limit 1",
          [connector.id, office.officeId, entity],
        );
        if (queued.rows[0]) {
          reusedQueued.push(Number(queued.rows[0].id));
          jobs.push(toJob(queued.rows[0]));
          continue;
        }
        const inserted = await tx.query<JobDbRow>(
          `insert into sync_jobs (connector_id, office_id, entity, idempotency_key, request_key, request_fingerprint,
             requested_by, requested_at, max_attempts, next_attempt_at)
           values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $8) returning *`,
          [connector.id, office.officeId, entity, `${args.idempotencyKey}/${office.officeId}/${entity}`, args.idempotencyKey, fingerprint,
            args.actor, args.now, connector.config.maxAttempts],
        );
        created.push(Number(inserted.rows[0].id));
        jobs.push(toJob(inserted.rows[0]));
      }
    }
    await audit(tx, args.auditAt, args.actor, "sync.requested", `connector:${connector.id}`, {
      idempotencyKey: args.idempotencyKey,
      offices: offices.length,
      entities,
      created: created.length,
      reusedQueued: reusedQueued.length,
    });
    return { requestKey: args.idempotencyKey, alreadyRequested: false, created, reusedQueued, jobs };
  });
}

// ── Cancel / retry ───────────────────────────────────────────────────────────

/**
 * A queued job is cancelled at once. A running job is asked to stop: the worker checks between
 * batches, so a committed batch stays committed (and is absorbed as duplicates next time) and
 * the checkpoint never moves for a cancelled window.
 */
export async function cancelJob(
  pool: Pool,
  args: { jobId: number; actor: string; scope: string[] | null; now: Date; auditAt: Date },
): Promise<SyncJob> {
  return withTransaction(pool, async (tx) => {
    const job = await lockJob(tx, args.jobId, args.scope);
    if (job.state === "queued") {
      const { rows } = await tx.query<JobDbRow>(
        "update sync_jobs set state = 'cancelled', finished_at = $2, last_error = $3, last_error_kind = 'cancelled' where id = $1 returning *",
        [job.id, args.now, `Cancelled by ${args.actor} before it ran`],
      );
      await audit(tx, args.auditAt, args.actor, "sync_job.cancelled", `sync_job:${job.id}`, { from: "queued" });
      return toJob(rows[0]);
    }
    if (job.state === "running") {
      const { rows } = await tx.query<JobDbRow>("update sync_jobs set cancel_requested = true where id = $1 returning *", [job.id]);
      await audit(tx, args.auditAt, args.actor, "sync_job.cancel_requested", `sync_job:${job.id}`, { from: "running" });
      return toJob(rows[0]);
    }
    throw new ActionError(`Job ${job.id} is ${job.state}; only queued or running jobs can be cancelled`, 409);
  });
}

/**
 * Re-runs a failed or cancelled job as a NEW job (history is never rewritten). It starts from
 * the stream's checkpoint, which the failed job never moved. Idempotent by key.
 */
export async function retryJob(
  pool: Pool,
  args: { jobId: number; actor: string; idempotencyKey: string; scope: string[] | null; now: Date; auditAt: Date },
): Promise<SyncJob> {
  return withTransaction(pool, async (tx) => {
    const job = await lockJob(tx, args.jobId, args.scope);
    const key = `${args.idempotencyKey}/${job.officeId}/${job.entity}`;
    const existing = await tx.query<JobDbRow>("select * from sync_jobs where idempotency_key = $1", [key]);
    if (existing.rows[0]) {
      if (existing.rows[0].retry_of !== String(job.id)) throw new ActionError("This idempotency key was already used for a different request", 409);
      return toJob(existing.rows[0]);
    }
    if (job.state !== "failed" && job.state !== "cancelled") {
      throw new ActionError(`Job ${job.id} is ${job.state}; only failed or cancelled jobs can be retried`, 409);
    }
    const connector = await getConnector(tx, job.connectorId);
    if (!connector?.enabled) throw new ActionError("The job's connector is missing or disabled", 409);
    const { rows } = await tx.query<JobDbRow>(
      `insert into sync_jobs (connector_id, office_id, entity, idempotency_key, request_key, request_fingerprint, retry_of,
         requested_by, requested_at, max_attempts, next_attempt_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $9) returning *`,
      [job.connectorId, job.officeId, job.entity, key, args.idempotencyKey, sha256(`retry:${job.id}`), job.id, args.actor, args.now, connector.config.maxAttempts],
    );
    await audit(tx, args.auditAt, args.actor, "sync_job.retried", `sync_job:${job.id}`, { newJobId: Number(rows[0].id) });
    return toJob(rows[0]);
  });
}

async function lockJob(tx: Queryable, jobId: number, scope: string[] | null): Promise<SyncJob> {
  const { rows } = await tx.query<JobDbRow>("select * from sync_jobs where id = $1 for update", [jobId]);
  if (!rows[0]) throw new ActionError(`Job ${jobId} not found`, 404);
  const job = toJob(rows[0]);
  if (scope !== null) {
    const branch = await branchOfOffice(tx, job.officeId);
    // Out of scope looks exactly like missing: no existence oracle across branches.
    if (!branch || !scope.includes(branch)) throw new ActionError(`Job ${jobId} not found`, 404);
  }
  return job;
}

// ── Run ──────────────────────────────────────────────────────────────────────

export interface JobOutcome {
  jobId: number;
  state: JobState;
  attempt: number;
  error?: string;
  errorKind?: string;
  /** This worker lost the job to another worker mid-attempt; `state` is the job's current state. */
  claimLost?: boolean;
}

/**
 * Claims and runs ready jobs until none are left or `maxJobs` ran. `concurrency` loops run in
 * parallel; each claim is a single-row FOR UPDATE SKIP LOCKED, so no job is claimed twice.
 */
export async function runPendingJobs(rt: SyncRuntime, opts: { maxJobs?: number; concurrency?: number } = {}): Promise<JobOutcome[]> {
  const maxJobs = opts.maxJobs ?? 100;
  const concurrency = Math.max(1, opts.concurrency ?? 1);
  await requeueStale(rt);
  const outcomes: JobOutcome[] = [];
  let budget = maxJobs;
  const loop = async () => {
    while (budget > 0) {
      budget -= 1;
      const job = await claimNext(rt);
      if (!job) return;
      outcomes.push(await processJob(rt, job));
    }
  };
  await Promise.all(Array.from({ length: concurrency }, loop));
  return outcomes;
}

/**
 * A worker that died mid-job leaves a running row behind; after staleAfterMs it is re-queued
 * while attempts remain. A lost worker uses up its attempt like any other failure, so a job
 * that keeps killing its worker fails at max_attempts instead of looping forever.
 */
async function requeueStale(rt: SyncRuntime): Promise<void> {
  const cutoff = new Date(rt.now().getTime() - (rt.staleAfterMs ?? 5 * 60_000));
  const { failed, requeued } = await withTransaction(rt.pool, async (tx) => {
    const failed = await tx.query<{ id: string; attempts: number; max_attempts: number; claimed_by: string | null }>(
      `update sync_jobs set state = 'failed', finished_at = $2, last_error_kind = 'worker_lost',
         last_error = format('Worker %s stopped responding during attempt %s of %s. Not re-queued: its attempts are used up. Find out why the worker died (memory, deploy, a hung call in the trace), then retry this job.',
                             coalesce(claimed_by, 'unknown'), attempts, max_attempts)
       where state = 'running' and heartbeat_at < $1 and attempts >= max_attempts
       returning id, attempts, max_attempts, claimed_by`,
      [cutoff, rt.now()],
    );
    const requeued = await tx.query<{ id: string }>(
      `update sync_jobs set state = 'queued', next_attempt_at = $2, last_error = 'Worker stopped responding; re-queued', last_error_kind = 'worker_lost'
       where state = 'running' and heartbeat_at < $1 returning id`,
      [cutoff, rt.now()],
    );
    return { failed: failed.rows, requeued: requeued.rows };
  });
  if (failed.length === 0 && requeued.length === 0) return;
  const at = await rt.businessNow();
  for (const r of requeued) await audit(rt.pool, at, rt.workerId, "sync_job.requeued", `sync_job:${r.id}`, { reason: "stale heartbeat" });
  for (const r of failed) {
    await audit(rt.pool, at, rt.workerId, "sync_job.failed", `sync_job:${r.id}`, { reason: "stale heartbeat", attempt: r.attempts, maxAttempts: r.max_attempts, lostWorker: r.claimed_by, errorKind: "worker_lost" });
  }
}

/** This worker's claim was taken over: stop, write nothing, record no outcome. */
class ClaimLostSignal extends Error {}

/**
 * True while `job` is still this worker's claim. Inside a transaction, `lock` holds the row so
 * a stale-heartbeat re-queue cannot slip in between the check and the batch commit.
 */
async function holdsClaim(db: Queryable, job: SyncJob, workerId: string, lock = false): Promise<boolean> {
  const { rows } = await db.query(
    `select 1 from sync_jobs where id = $1 and state = 'running' and claimed_by = $2 and attempts = $3${lock ? " for update" : ""}`,
    [job.id, workerId, job.attempts],
  );
  return rows.length > 0;
}

async function claimLostOutcome(rt: SyncRuntime, job: SyncJob): Promise<JobOutcome> {
  const current = await rt.pool.query<{ state: JobState }>("select state from sync_jobs where id = $1", [job.id]);
  console.warn(JSON.stringify({ level: "warn", msg: "sync job claim lost", jobId: job.id, attempt: job.attempts, workerId: rt.workerId }));
  return { jobId: job.id, state: current.rows[0]?.state ?? "queued", attempt: job.attempts, claimLost: true };
}

async function claimNext(rt: SyncRuntime): Promise<SyncJob | null> {
  for (let tries = 0; tries < 5; tries++) {
    try {
      const { rows } = await rt.pool.query<JobDbRow>(
        `update sync_jobs j set state = 'running', attempts = j.attempts + 1, started_at = coalesce(j.started_at, $1),
           heartbeat_at = $1, claimed_by = $2
         where j.id = (
           select q.id from sync_jobs q
           where q.state = 'queued' and q.next_attempt_at <= $1
             and not exists (select 1 from sync_jobs r where r.state = 'running' and r.connector_id = q.connector_id
                               and r.office_id = q.office_id and r.entity = q.entity)
           order by q.next_attempt_at, q.id
           for update skip locked
           limit 1)
         returning j.*`,
        [rt.now(), rt.workerId],
      );
      if (!rows[0]) return null;
      const job = toJob(rows[0]);
      await audit(rt.pool, await rt.businessNow(), rt.workerId, "sync_job.started", `sync_job:${job.id}`, { attempt: job.attempts, office: job.officeId, entity: job.entity });
      return job;
    } catch (error) {
      // Two workers raced for two queued jobs of the same stream; the unique index let one win.
      if ((error as { code?: string }).code === "23505") continue;
      throw error;
    }
  }
  return null;
}

class CancelledSignal extends Error {}

async function processJob(rt: SyncRuntime, job: SyncJob): Promise<JobOutcome> {
  const calls: ApiCallRecord[] = [];
  const flush = () => flushCalls(rt.pool, job, calls.splice(0));
  const stats: JobStats = { ...job.stats };
  const businessNow = await rt.businessNow();
  let connector: ConnectorRow | null = null;
  try {
    connector = await getConnector(rt.pool, job.connectorId);
    if (!connector || !connector.enabled) throw new ActionError("Connector missing or disabled", 409);
    const client = rt.clientFor(connector, (call) => calls.push(call));
    const tracking = client.capabilities().entities[job.entity];
    const getLimit = client.capabilities().getLimit;
    const mapper = mapperFor("crm");

    if (await cancelRequested(rt.pool, job.id)) throw new CancelledSignal();

    // The window is fixed on the first attempt so a retry resumes the SAME window.
    let windowStart = job.windowStart;
    let windowEnd = job.windowEnd;
    if (!windowStart || !windowEnd) {
      const cp = await rt.pool.query<{ cursor_at: Date }>(
        "select cursor_at from sync_checkpoints where connector_id = $1 and office_id = $2 and entity = $3",
        [job.connectorId, job.officeId, job.entity],
      );
      const base = cp.rows[0]?.cursor_at ?? new Date(businessNow.getTime() - connector.config.initialLookbackHours * HOUR);
      windowStart = new Date(base.getTime() - tracking.overlapMs);
      windowEnd = businessNow;
      const fixed = await rt.pool.query(
        "update sync_jobs set window_start = $2, window_end = $3 where id = $1 and state = 'running' and claimed_by = $4 and attempts = $5",
        [job.id, windowStart, windowEnd, rt.workerId, job.attempts],
      );
      if (fixed.rowCount === 0) throw new ClaimLostSignal();
    }

    const ids = await client.search(job.entity, { officeId: job.officeId, updatedFrom: windowStart, updatedTo: windowEnd, idsAfter: job.resumeAfterId });
    stats.searched += ids.length;
    await flush();

    const chunks: number[][] = [];
    for (let i = 0; i < ids.length; i += getLimit) chunks.push(ids.slice(i, i + getLimit));
    if (chunks.length === 0) {
      await withTransaction(rt.pool, async (tx) => {
        if (!(await holdsClaim(tx, job, rt.workerId, true))) throw new ClaimLostSignal();
        await saveProgress(tx, job.id, null, stats, rt.now());
        await advanceCheckpoint(tx, job, windowEnd!, 0, rt.now());
      });
    }
    for (const [index, chunk] of chunks.entries()) {
      if (await cancelRequested(rt.pool, job.id)) throw new CancelledSignal();
      const got = await client.get(job.entity, { officeId: job.officeId, ids: chunk });
      const isLast = index === chunks.length - 1;
      await withTransaction(rt.pool, async (tx) => {
        // Fence first, holding the row: a batch fetched under a lost claim rolls back whole.
        if (!(await holdsClaim(tx, job, rt.workerId, true))) throw new ClaimLostSignal();
        const s = await ingestRecords(tx, { source: "crm", records: got.records, mapper, ctx: referenceContext, runId: null, now: businessNow });
        addStats(stats, s, got.rejected.length, got.missingIds.length);
        await saveProgress(tx, job.id, chunk[chunk.length - 1], stats, rt.now());
        // Atomic with the batch that completes the window — never before it commits.
        if (isLast) await advanceCheckpoint(tx, job, windowEnd!, stats.inserted, rt.now());
      });
      if (got.rejected.length > 0) {
        console.warn(JSON.stringify({ level: "warn", msg: "connector records rejected", jobId: job.id, office: job.officeId, entity: job.entity, rejected: got.rejected.map((r) => r.message).slice(0, 3) }));
      }
      await flush();
    }

    const succeeded = await withTransaction(rt.pool, async (tx) => {
      const { rows } = await tx.query<JobDbRow>(
        `update sync_jobs set state = 'succeeded', finished_at = $2, heartbeat_at = $2, stats = $3, last_error = null, last_error_kind = null
         where id = $1 and state = 'running' and claimed_by = $4 and attempts = $5 returning *`,
        [job.id, rt.now(), stats, rt.workerId, job.attempts],
      );
      // Another worker took the job over (stale-heartbeat re-queue): the state is theirs.
      if (!rows[0]) return false;
      await audit(tx, businessNow, rt.workerId, "sync_job.succeeded", `sync_job:${job.id}`, { attempt: job.attempts, ...stats });
      await recordEvent(tx, {
        type: "crm_sync.job_succeeded",
        subject: `sync_job:${job.id}`,
        occurredAt: businessNow,
        payload: { connectorId: job.connectorId, officeId: job.officeId, entity: job.entity, windowEnd: windowEnd!.toISOString(), attempt: job.attempts, inserted: stats.inserted, quarantined: stats.quarantined },
      });
      return true;
    });
    if (!succeeded) throw new ClaimLostSignal();
    console.log(JSON.stringify({ level: "info", msg: "sync job succeeded", jobId: job.id, office: job.officeId, entity: job.entity, attempt: job.attempts, ...stats }));
    return { jobId: job.id, state: "succeeded", attempt: job.attempts };
  } catch (error) {
    await flush().catch(() => undefined);
    if (error instanceof ClaimLostSignal) return claimLostOutcome(rt, job);
    if (error instanceof CancelledSignal) return finishCancelled(rt, job, stats, businessNow);
    return handleFailure(rt, job, connector, stats, error, businessNow);
  }
}

function addStats(stats: JobStats, s: IngestStats, rejected: number, missing: number): void {
  stats.fetched += s.fetched;
  stats.inserted += s.inserted;
  stats.duplicates += s.duplicates;
  stats.conflicts += s.conflicts;
  stats.projected += s.projected;
  stats.quarantined += s.quarantined;
  stats.rejected += rejected;
  stats.missing += missing;
  stats.batches += 1;
}

async function saveProgress(tx: PoolClient, jobId: number, resumeAfterId: number | null, stats: JobStats, now: Date): Promise<void> {
  await tx.query(
    "update sync_jobs set resume_after_id = coalesce($2, resume_after_id), stats = $3, heartbeat_at = $4 where id = $1",
    [jobId, resumeAfterId, stats, now],
  );
}

async function advanceCheckpoint(tx: PoolClient, job: SyncJob, cursorAt: Date, records: number, now: Date): Promise<void> {
  await tx.query(
    `insert into sync_checkpoints (connector_id, office_id, entity, cursor_at, last_job_id, records_synced, updated_at)
     values ($1, $2, $3, $4, $5, $6, $7)
     on conflict (connector_id, office_id, entity) do update set
       cursor_at = greatest(sync_checkpoints.cursor_at, excluded.cursor_at),
       last_job_id = excluded.last_job_id,
       records_synced = sync_checkpoints.records_synced + excluded.records_synced,
       updated_at = excluded.updated_at`,
    [job.connectorId, job.officeId, job.entity, cursorAt, job.id, records, now],
  );
}

async function cancelRequested(db: Queryable, jobId: number): Promise<boolean> {
  const { rows } = await db.query<{ cancel_requested: boolean }>("select cancel_requested from sync_jobs where id = $1", [jobId]);
  return rows[0]?.cancel_requested ?? false;
}

async function finishCancelled(rt: SyncRuntime, job: SyncJob, stats: JobStats, at: Date): Promise<JobOutcome> {
  const done = await rt.pool.query(
    `update sync_jobs set state = 'cancelled', finished_at = $2, stats = $3, last_error = 'Cancelled while running; checkpoint unchanged', last_error_kind = 'cancelled'
     where id = $1 and state = 'running' and claimed_by = $4 and attempts = $5`,
    [job.id, rt.now(), stats, rt.workerId, job.attempts],
  );
  if (done.rowCount === 0) return claimLostOutcome(rt, job);
  await audit(rt.pool, at, rt.workerId, "sync_job.cancelled", `sync_job:${job.id}`, { from: "running", attempt: job.attempts, ...stats });
  return { jobId: job.id, state: "cancelled", attempt: job.attempts };
}

/** Exponential backoff with jitter; a server's Retry-After wins when it sent one. */
export function backoffMs(attempt: number, retryAfterMs: number | null, rt: Pick<SyncRuntime, "random" | "backoffBaseMs" | "backoffCapMs">): number {
  if (retryAfterMs !== null) return retryAfterMs;
  const base = rt.backoffBaseMs ?? 2_000;
  const cap = rt.backoffCapMs ?? 5 * 60_000;
  const exp = Math.min(cap, base * 2 ** Math.max(0, attempt - 1));
  return Math.round(exp / 2 + (rt.random ?? Math.random)() * (exp / 2));
}

async function handleFailure(rt: SyncRuntime, job: SyncJob, connector: ConnectorRow | null, stats: JobStats, error: unknown, at: Date): Promise<JobOutcome> {
  const kind: ConnectorErrorKind | "internal" | "config" =
    error instanceof ConnectorError ? error.kind : error instanceof ActionError ? "config" : "internal";
  // Unknown errors (a lost DB connection, a deadlock) are presumed transient; config errors are not.
  const retryable = error instanceof ConnectorError ? error.retryable : !(error instanceof ActionError);
  const message = (error as Error).message;

  if (retryable && job.attempts < job.maxAttempts) {
    const delay = backoffMs(job.attempts, error instanceof RateLimitError ? error.retryAfterMs : null, rt);
    const next = new Date(rt.now().getTime() + delay);
    const queued = await rt.pool.query(
      `update sync_jobs set state = 'queued', next_attempt_at = $2, stats = $3, last_error = $4, last_error_kind = $5
       where id = $1 and state = 'running' and claimed_by = $6 and attempts = $7`,
      [job.id, next, stats, message, kind, rt.workerId, job.attempts],
    );
    if (queued.rowCount === 0) return claimLostOutcome(rt, job);
    await audit(rt.pool, at, rt.workerId, "sync_job.retry_scheduled", `sync_job:${job.id}`, { attempt: job.attempts, errorKind: kind, error: message, retryInMs: delay });
    console.warn(JSON.stringify({ level: "warn", msg: "sync job retry scheduled", jobId: job.id, attempt: job.attempts, errorKind: kind, retryInMs: delay }));
    return { jobId: job.id, state: "queued", attempt: job.attempts, error: message, errorKind: kind };
  }

  const actionable = actionableMessage(kind, message, job, connector);
  const failed = await rt.pool.query(
    `update sync_jobs set state = 'failed', finished_at = $2, stats = $3, last_error = $4, last_error_kind = $5
     where id = $1 and state = 'running' and claimed_by = $6 and attempts = $7`,
    [job.id, rt.now(), stats, actionable, kind, rt.workerId, job.attempts],
  );
  if (failed.rowCount === 0) return claimLostOutcome(rt, job);
  await audit(rt.pool, at, rt.workerId, "sync_job.failed", `sync_job:${job.id}`, { attempt: job.attempts, errorKind: kind, error: actionable });
  console.error(JSON.stringify({ level: "error", msg: "sync job failed", jobId: job.id, office: job.officeId, entity: job.entity, errorKind: kind }));
  return { jobId: job.id, state: "failed", attempt: job.attempts, error: actionable, errorKind: kind };
}

/** What a person must do, not just what happened. Never includes credential values. */
function actionableMessage(kind: string, message: string, job: SyncJob, connector: ConnectorRow | null): string {
  if (kind === "auth") {
    const names = connector ? credentialStatus(connector, job.officeId) : null;
    const where = names ? `${names.keyEnv} / ${names.tokenEnv}` : "the office's key and token";
    return `Credentials for office ${job.officeId} were rejected (${message}). Not retried automatically: a rejected key does not recover by itself and repeated attempts can lock it. Check or rotate ${where}, then retry this job.`;
  }
  if (kind === "protocol") return `${message}. Not retried: the response broke the API contract — inspect the call trace before retrying.`;
  if (kind === "config") return `${message}. Not retried: fix the connector configuration, then retry.`;
  return `${message} — gave up after ${job.attempts} attempt${job.attempts === 1 ? "" : "s"}. Retry the job once the source recovers.`;
}

async function flushCalls(pool: Pool, job: SyncJob, calls: ApiCallRecord[]): Promise<void> {
  if (calls.length === 0) return;
  await pool.query(
    `insert into sync_api_calls (job_id, connector_id, attempt, office_id, entity, action, method, path, status, ms, ids, id_count, error_kind, error, at)
     select $1, $2, $3, r."officeId", r."entity", r."action", r."method", r."path", r."status", r."ms",
       coalesce((select array_agg(x::bigint) from jsonb_array_elements_text(r."ids") x), '{}'), r."idCount", r."errorKind", r."error", r."at"
     from jsonb_to_recordset($4::jsonb) as r("officeId" int, "entity" text, "action" text, "method" text, "path" text, "status" int,
       "ms" int, "ids" jsonb, "idCount" int, "errorKind" text, "error" text, "at" timestamptz)`,
    [job.id, job.connectorId, job.attempts, JSON.stringify(calls)],
  );
}
