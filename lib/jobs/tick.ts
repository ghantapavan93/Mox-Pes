import { runDueChecks, type CheckResult, type MonitorHooks } from "@/lib/changeguard/monitor";
import { dispatchEvents } from "@/lib/events/consumers";
import { purgeExpired } from "@/lib/onboarding/service";
import { runPendingJobs, type SyncRuntime } from "./sync";

/**
 * One loop of the worker (scripts/worker.ts), in order:
 *
 *   1. sync jobs that are ready (FOR UPDATE SKIP LOCKED);
 *   2. domain events those batches published (reconciliation and identity catch up once);
 *   3. onboarding uploads past retention;
 *   4. post-release checks whose slot is due (lib/changeguard/monitor.ts). After the sync and the
 *      event dispatch, so a check sees what this loop stored.
 *
 * Scheduled work reads the business clock (runtime.businessNow), so a test or a demo moves one
 * clock and the worker follows it. Several workers may run this at once: each step is safe to run
 * concurrently (claims, advisory locks, one conclusion per check slot).
 */
export interface TickResult {
  jobs: number;
  purged: number;
  checks: CheckResult[];
}

export async function workerTick(runtime: SyncRuntime, opts: { maxJobs?: number; concurrency?: number; hooks?: MonitorHooks } = {}): Promise<TickResult> {
  const outcomes = await runPendingJobs(runtime, { maxJobs: opts.maxJobs ?? 50, concurrency: opts.concurrency ?? 4 });
  await dispatchEvents(runtime.pool);
  const now = await runtime.businessNow();
  const purged = await purgeExpired(runtime.pool, now);
  if (purged > 0) console.log(JSON.stringify({ level: "info", msg: "onboarding uploads past retention purged", uploads: purged }));
  const checks = await runDueChecks(runtime.pool, { ranBy: `worker:${runtime.workerId}`, now, hooks: opts.hooks });
  for (const c of checks) {
    if (c.outcome !== "skipped") console.log(JSON.stringify({ level: c.outcome === "error" ? "error" : "info", msg: "post-release check recorded", changeId: c.changeId, runId: c.runId, outcome: c.outcome, workerId: runtime.workerId }));
  }
  return { jobs: outcomes.length, purged, checks };
}
