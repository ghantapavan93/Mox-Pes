import { createPool, DEFAULT_DATABASE_URL } from "@/lib/db";
import { dispatchEvents } from "@/lib/events/consumers";
import { defaultRuntime } from "@/lib/jobs/runtime";
import { runPendingJobs } from "@/lib/jobs/sync";

/**
 * The sync worker: `npm run worker`. Claims ready jobs (FOR UPDATE SKIP LOCKED), runs them,
 * sleeps briefly when the queue is empty, and stops cleanly on SIGINT/SIGTERM after the job in
 * hand. Several workers (and the web app's after() drain) can run at once safely.
 *
 * Environment: DATABASE_URL; per-office credentials named by each connector's config
 * (FIELDROUTES_KEY_<office> / FIELDROUTES_TOKEN_<office> for the demo connector);
 * FIELDROUTES_MOCK_BASE_URL to point the demo connector at another mock host;
 * WORKER_CONCURRENCY (default 4); WORKER_IDLE_MS (default 2000).
 */

const concurrency = Number(process.env.WORKER_CONCURRENCY ?? 4);
const idleMs = Number(process.env.WORKER_IDLE_MS ?? 2_000);

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
  console.log(JSON.stringify({ level: "info", msg: "worker started", workerId: runtime.workerId, concurrency }));

  while (!stopping) {
    try {
      const outcomes = await runPendingJobs(runtime, { maxJobs: 50, concurrency });
      // Stored batches published intake.records_stored: reconciliation and identity catch up,
      // once per loop however many batches there were.
      await dispatchEvents(pool);
      if (outcomes.length === 0) await new Promise((resolve) => setTimeout(resolve, idleMs));
    } catch (error) {
      // A database blip must not kill the worker; jobs it held are re-queued by heartbeat expiry.
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
