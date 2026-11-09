import { createPool, DEFAULT_DATABASE_URL } from "@/lib/db";
import { branchRows, channelRows, conversionBridge, totals } from "@/lib/metrics/scorecard";
import { listExceptions, weeklySeries } from "@/lib/queries";
import { feedbackSummary } from "@/lib/feedback";
import { PERIODS } from "@/lib/period";

/** Times each read model on the current database: `npm run profile`. */
async function main() {
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const now = new Date("2026-10-31T13:00:00Z");
  for (const branchIds of [null, ["B20"]]) {
    const scope = { from: PERIODS.oct.from, to: PERIODS.oct.to, branchIds };
    const time = async (label: string, fn: () => Promise<unknown>) => {
      const t0 = performance.now();
      await fn();
      console.log(`${(branchIds ?? ["all"]).join(",").padEnd(4)} ${label.padEnd(16)} ${Math.round(performance.now() - t0)} ms`);
    };
    await time("branchRows", () => branchRows(pool, scope));
    await time("totals", () => totals(pool, scope));
    await time("bridge", () => conversionBridge(pool, scope));
    await time("channelRows", () => channelRows(pool, scope));
    await time("weeklySeries", () => weeklySeries(pool, branchIds));
    await time("exceptions", () => listExceptions(pool, { branchIds, status: "open" }));
    await time("feedback", () => feedbackSummary(pool, scope, now));
  }
  await pool.end();
}
main();
