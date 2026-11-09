import type { Pool } from "pg";
import { dispatchEvents } from "@/lib/events/consumers";
import { defaultRuntime } from "./runtime";
import { runPendingJobs, type SyncRuntime } from "./sync";

/**
 * The demo's in-process job drain, scheduled with Next's after() so a sync request returns as
 * soon as its jobs are queued. Production runs scripts/worker.ts instead; both claim with
 * SKIP LOCKED, so running them together is safe.
 *
 * One drain per server process: a kick that arrives while a drain is running only flags it to
 * go round once more. The drain also waits out short backoffs (a Retry-After of a few seconds),
 * so a rate-limited job recovers without a separate worker; anything scheduled further out is
 * left for the next kick or the worker.
 *
 * When the drain ends it dispatches domain events once: the batches it stored published
 * intake.records_stored, so reconciliation and identity catch up (one run each, however many
 * batches there were). The drain never calls those contexts itself.
 */

const MAX_WAIT_FOR_RETRY_MS = 60_000;
const MAX_DRAIN_MS = 10 * 60_000;

const state = ((globalThis as unknown as { __rsSyncDrain?: { running: boolean; again: boolean } }).__rsSyncDrain ??= { running: false, again: false });

export async function drainJobs(pool: Pool, runtime: SyncRuntime = defaultRuntime(pool, `web:${process.pid}`)): Promise<void> {
  if (state.running) {
    state.again = true;
    return;
  }
  state.running = true;
  const started = Date.now();
  try {
    for (;;) {
      state.again = false;
      await runPendingJobs(runtime, { maxJobs: 1_000, concurrency: 4 });
      if (state.again) continue;
      const next = await pool.query<{ at: Date | null }>("select min(next_attempt_at) as at from sync_jobs where state = 'queued'");
      const at = next.rows[0]?.at;
      if (!at) break;
      const wait = new Date(at).getTime() - Date.now();
      if (wait > MAX_WAIT_FOR_RETRY_MS || Date.now() - started + wait > MAX_DRAIN_MS) break;
      await new Promise((resolve) => setTimeout(resolve, Math.max(0, wait) + 50));
    }
    await dispatchEvents(pool);
  } catch (error) {
    console.error(JSON.stringify({ level: "error", msg: "sync drain failed", error: (error as Error).message }));
  } finally {
    state.running = false;
  }
}
