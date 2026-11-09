import type { Pool } from "pg";
import { getNow, withTransaction, type Queryable } from "@/lib/db";
import { resolveIdentities } from "@/lib/identity/resolve";
import { reconcile } from "@/lib/reconcile/reconcile";
import type { DomainEventType } from "./outbox";

/**
 * Event consumers: the policies that keep one context's read model in step with facts another
 * context published ("when source records are stored, reconciliation must see them").
 *
 * Each consumer here is a COARSE, IDEMPOTENT recomputation (a full reconcile, a full identity
 * resolution), so it does not handle events one by one. It answers one question: has my latest
 * run already seen every change these events stand for? A run-completed event carries the
 * snapshot its run read; an event is covered when its transaction is visible in that snapshot
 * (or it was written earlier in the run's own transaction). Only uncovered events trigger a run,
 * and only covered events are marked delivered, so:
 *
 *   * nothing is lost: an event whose transaction committed after the run started stays
 *     pending and triggers the next dispatch;
 *   * nothing is redone: a seed that reconciles after every batch leaves nothing uncovered,
 *     and a burst of fifty synced batches costs one reconcile, not fifty.
 *
 * Dispatch runs wherever work finishes outside a request (the sync drain, the worker, a route's
 * after()) and is safe to run concurrently: each consumer holds a session advisory lock.
 */

export interface Consumer {
  name: string;
  /** Events that can make this consumer's read model stale. */
  triggers: DomainEventType[];
  /** The event this consumer's own run publishes, stamped with the snapshot it read. */
  covers: DomainEventType;
  run(pool: Pool): Promise<void>;
}

export const CONSUMERS: Consumer[] = [
  {
    name: "reconciliation",
    triggers: ["intake.records_stored", "intake.records_reprojected"],
    covers: "reconciliation.run_completed",
    run: (pool) => withTransaction(pool, async (tx) => void (await reconcile(tx, await getNow(tx)))),
  },
  {
    // After reconciliation: a run there can change nothing identity reads, but ordering the
    // cheap, decision-critical consumer first gets exceptions current soonest.
    name: "identity",
    triggers: ["intake.records_stored", "intake.records_reprojected", "action_center.proposal_executed"],
    covers: "identity.resolution_completed",
    run: async (pool) => void (await resolveIdentities(pool, await getNow(pool))),
  },
];

export interface DispatchResult {
  consumer: string;
  /** "busy": another dispatcher holds this consumer; it will cover these events. */
  status: "idle" | "ran" | "caught_up" | "busy" | "failed";
  delivered: number;
  error?: string;
}

/** SQL for "covered by the consumer's latest run": shared by the check and the delivery. */
const COVERED = `
  (pg_visible_in_snapshot(e.txid, (r.payload->>'snapshot')::pg_snapshot)
   or (e.txid = (r.payload->>'txid')::xid8 and e.id < r.id))`;

const LATEST_RUN = `
  latest as (select id, payload from domain_events where type = $2 order by id desc limit 1)`;

/**
 * A consumer's backlog: events not yet delivered, and of those, the ones its latest run did not
 * see. Only `uncovered` is work; the rest are already reflected and wait to be marked.
 */
export async function consumerBacklog(db: Queryable, consumer: Consumer): Promise<{ undelivered: number; uncovered: number }> {
  const { rows } = await db.query<{ undelivered: string; uncovered: string }>(
    `with ${LATEST_RUN},
     p as (select e.* from domain_events e
           where e.type = any($1::text[])
             and not exists (select 1 from event_deliveries d where d.consumer = $3 and d.event_id = e.id))
     select (select count(*) from p) as undelivered,
            (select count(*) from p e where not exists (select 1 from latest r where ${COVERED})) as uncovered`,
    [consumer.triggers, consumer.covers, consumer.name],
  );
  return { undelivered: Number(rows[0].undelivered), uncovered: Number(rows[0].uncovered) };
}

export async function dispatchEvents(pool: Pool, opts: { only?: string[] } = {}): Promise<DispatchResult[]> {
  const results: DispatchResult[] = [];
  for (const consumer of CONSUMERS) {
    if (opts.only && !opts.only.includes(consumer.name)) continue;
    results.push(await dispatchOne(pool, consumer));
  }
  return results;
}

async function dispatchOne(pool: Pool, consumer: Consumer): Promise<DispatchResult> {
  const lockClient = await pool.connect();
  try {
    const lock = await lockClient.query<{ ok: boolean }>("select pg_try_advisory_lock(hashtext($1)) as ok", [`events:${consumer.name}`]);
    if (!lock.rows[0].ok) return { consumer: consumer.name, status: "busy", delivered: 0 };
    try {
      const params = [consumer.triggers, consumer.covers, consumer.name];
      const pending = await pool.query<{ pending: boolean; uncovered: boolean }>(
        `with ${LATEST_RUN},
         p as (select e.* from domain_events e
               where e.type = any($1::text[])
                 and not exists (select 1 from event_deliveries d where d.consumer = $3 and d.event_id = e.id))
         select exists (select 1 from p) as pending,
                exists (select 1 from p e where not exists (select 1 from latest r where ${COVERED})) as uncovered`,
        params,
      );
      if (!pending.rows[0].pending) return { consumer: consumer.name, status: "idle", delivered: 0 };

      const ran = pending.rows[0].uncovered;
      if (ran) await consumer.run(pool);

      const delivered = await pool.query(
        `with ${LATEST_RUN}
         insert into event_deliveries (consumer, event_id)
         select $3, e.id from domain_events e, latest r
         where e.type = any($1::text[])
           and not exists (select 1 from event_deliveries d where d.consumer = $3 and d.event_id = e.id)
           and ${COVERED}
         on conflict do nothing`,
        params,
      );
      const count = delivered.rowCount ?? 0;
      await pool.query(
        `insert into event_consumers (consumer, runs, events_handled, last_run_at) values ($1, $2, $3, clock_timestamp())
         on conflict (consumer) do update set runs = event_consumers.runs + excluded.runs,
           events_handled = event_consumers.events_handled + excluded.events_handled, last_run_at = excluded.last_run_at`,
        [consumer.name, ran ? 1 : 0, count],
      );
      if (ran) console.log(JSON.stringify({ level: "info", msg: "event consumer ran", consumer: consumer.name, delivered: count }));
      return { consumer: consumer.name, status: ran ? "ran" : "caught_up", delivered: count };
    } catch (error) {
      // Pending events stay pending: the next dispatch retries. The failure is visible on the
      // Audit & Health page through event_consumers.
      const message = (error as Error).message;
      await pool
        .query(
          `insert into event_consumers (consumer, last_error, last_error_at) values ($1, $2, clock_timestamp())
           on conflict (consumer) do update set last_error = excluded.last_error, last_error_at = excluded.last_error_at`,
          [consumer.name, message.slice(0, 500)],
        )
        .catch(() => undefined);
      console.error(JSON.stringify({ level: "error", msg: "event consumer failed", consumer: consumer.name, error: message }));
      return { consumer: consumer.name, status: "failed", delivered: 0, error: message };
    } finally {
      await lockClient.query("select pg_advisory_unlock(hashtext($1))", [`events:${consumer.name}`]);
    }
  } finally {
    lockClient.release();
  }
}
