import type { Queryable } from "@/lib/db";

/**
 * Domain events: facts one bounded context publishes for the others (docs/domain-model.md).
 *
 * Written through a TRANSACTIONAL OUTBOX: recordEvent() inserts into domain_events inside the
 * caller's transaction, so an event exists exactly when its change committed — a rolled-back
 * dry run publishes nothing, and a crash between "change" and "publish" cannot happen.
 *
 * Contexts never call each other to keep read models fresh; they publish, and consumers
 * (lib/events/consumers.ts) react later. Inside one aggregate's transaction, consistency stays
 * synchronous: an Action Center execution still reconciles in its own transaction because its
 * verification needs the result before it commits.
 *
 * This module is the publishing side only and imports nothing from any context, so every
 * context can depend on it without cycles.
 */

export type DomainEventType =
  /** Intake stored new source record versions (any source, any write path). */
  | "intake.records_stored"
  /** Intake re-mapped stored records through another mapper version (a committed replay). */
  | "intake.records_reprojected"
  /** Reconciliation finished a full run. Carries the snapshot the detectors read. */
  | "reconciliation.run_completed"
  /** Identity finished a full resolution. Carries the snapshot it read. */
  | "identity.resolution_completed"
  /** CRM Sync finished a job: its window is stored and its checkpoint moved. */
  | "crm_sync.job_succeeded"
  /** Action Center applied and verified a proposal. */
  | "action_center.proposal_executed";

export interface DomainEventInput {
  type: DomainEventType;
  /** The aggregate the fact is about, e.g. "sync_job:12", "exception:40". */
  subject?: string | null;
  payload?: Record<string, unknown>;
  /** Business clock. */
  occurredAt: Date;
}

export async function recordEvent(db: Queryable, event: DomainEventInput): Promise<void> {
  await db.query("insert into domain_events (type, subject, payload, occurred_at) values ($1, $2, $3, $4)", [
    event.type,
    event.subject ?? null,
    event.payload ?? {},
    event.occurredAt,
  ]);
}

/**
 * The transaction snapshot to stamp on a run-completed event. Take it at the START of the run
 * (after the run's lock): every statement the run executes afterwards sees at least this much,
 * so "visible in this snapshot" is a safe under-approximation of "the run saw it".
 */
export async function currentSnapshot(db: Queryable): Promise<string> {
  const { rows } = await db.query<{ s: string }>("select pg_current_snapshot()::text as s");
  return rows[0].s;
}

/**
 * The run's own transaction id. A snapshot says nothing reliable about the transaction that
 * took it, so events written EARLIER in the run's own transaction are matched by txid + id.
 * Invariant for publishers: record an event before the reconcile that should cover it.
 */
export async function currentTxid(db: Queryable): Promise<string> {
  const { rows } = await db.query<{ x: string }>("select pg_current_xact_id()::text as x");
  return rows[0].x;
}
