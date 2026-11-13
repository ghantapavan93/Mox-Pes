import { createPool, DEFAULT_DATABASE_URL } from "@/lib/db";
import { defaultRuntime } from "@/lib/jobs/runtime";
import { workerTick } from "@/lib/jobs/tick";

/**
 * The worker: `npm run worker`. Each loop (lib/jobs/tick.ts) claims ready sync jobs (FOR UPDATE
 * SKIP LOCKED) and runs them, dispatches domain events, purges onboarding uploads past retention
 * and runs the post-release checks whose slot is due. It sleeps briefly when nothing was done and
 * stops cleanly on SIGINT/SIGTERM after the work in hand. Several workers (and the web app's
 * after() drain) can run at once safely.
 *
 * `npm run worker -- --once`: one loop, then exit (a scheduler, or a test, drives it).
 *
 * Environment: DATABASE_URL; per-office credentials named by each connector's config
 * (FIELDROUTES_KEY_<office> / FIELDROUTES_TOKEN_<office> for the demo connector);
 * FIELDROUTES_MOCK_BASE_URL to point the demo connector at another mock host;
 * WORKER_CONCURRENCY (default 4); WORKER_IDLE_MS (default 2000).
 */

const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 4);
const idleMs = Number(process.env.WORKER_IDLE_MS ?? 2_000);
const once = process.argv.includes("--once");

async function main() {
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const runtime = defaultRuntime(pool);
  let stopping = false;
  const stop = () => {
    if (!stopping) console.log(JSON.stringify({ level: "info", msg: "worker stopping after current jobs" }));
    stopping = true;
  };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);
  console.log(JSON.stringify({ level: "info", msg: "worker started", workerId: runtime.workerId, concurrency, once }));

  if (once) {
    const result = await workerTick(runtime, { concurrency });
    console.log(JSON.stringify({ level: "info", msg: "worker loop done", jobs: result.jobs, purged: result.purged, checks: result.checks.map((c) => ({ changeId: c.changeId, runId: c.runId, outcome: c.outcome })) }));
    await pool.end();
    return;
  }

  while (!stopping) {
    try {
      const result = await workerTick(runtime, { concurrency });
      const worked = result.jobs + result.checks.filter((c) => c.outcome !== "skipped").length;
      if (worked === 0) await new Promise((resolve) => setTimeout(resolve, idleMs));
    } catch (error) {
      // A database blip must not kill the worker; jobs it held are re-queued by heartbeat expiry,
      // and a check slot it did not conclude stays due.
      console.error(JSON.stringify({ level: "error", msg: "worker loop error", error: (error as Error).message }));
      await new Promise((resolve) => setTimeout(resolve, idleMs * 5));
    }
  }
  await pool.end();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
