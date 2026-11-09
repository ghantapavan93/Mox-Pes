import type { Queryable } from "@/lib/db";
import { CONSUMERS, consumerBacklog } from "./consumers";

/** Read model for Audit & Health: is every consumer caught up, and what was published lately? */

export interface ConsumerHealth {
  consumer: string;
  triggers: string[];
  /** Trigger events the consumer's latest run did not see: work the next dispatch will do. */
  uncovered: number;
  /** Trigger events not yet marked delivered (covered or not). */
  undelivered: number;
  runs: number;
  eventsHandled: number;
  lastRunAt: Date | null;
  lastError: string | null;
  lastErrorAt: Date | null;
}

export interface RecentEvent {
  id: number;
  type: string;
  subject: string | null;
  occurredAt: Date;
}

export async function consumerHealth(db: Queryable): Promise<ConsumerHealth[]> {
  const out: ConsumerHealth[] = [];
  for (const c of CONSUMERS) {
    const { rows } = await db.query<{ runs: string | null; events_handled: string | null; last_run_at: Date | null; last_error: string | null; last_error_at: Date | null }>(
      `select ec.runs, ec.events_handled, ec.last_run_at, ec.last_error, ec.last_error_at
       from (select 1) one left join event_consumers ec on ec.consumer = $1`,
      [c.name],
    );
    const r = rows[0];
    const backlog = await consumerBacklog(db, c);
    out.push({
      consumer: c.name,
      triggers: c.triggers,
      ...backlog,
      runs: Number(r.runs ?? 0),
      eventsHandled: Number(r.events_handled ?? 0),
      lastRunAt: r.last_run_at,
      // An error older than the last successful run is history, not a current problem.
      lastError: r.last_error && (!r.last_run_at || (r.last_error_at && r.last_error_at > r.last_run_at)) ? r.last_error : null,
      lastErrorAt: r.last_error_at,
    });
  }
  return out;
}

export async function recentEvents(db: Queryable, limit = 12): Promise<RecentEvent[]> {
  const { rows } = await db.query<{ id: string; type: string; subject: string | null; occurred_at: Date }>(
    "select id, type, subject, occurred_at from domain_events order by id desc limit $1",
    [limit],
  );
  return rows.map((r) => ({ id: Number(r.id), type: r.type, subject: r.subject, occurredAt: r.occurred_at }));
}
