/**
 * B20's reported paid CAC, September against October, from the scorecard every view uses (the
 * optional opening line of the walkthrough, HOLD-TO-DECISION.md §8). Reads only.
 *   ACCEPTANCE_DATABASE_URL=… npx tsx docs/agent-work/hold-to-decision/harness/b20-cac.ts
 */
import { acceptanceDatabaseUrl } from "@/tests/acceptance/b09/env";
import { createPool } from "@/lib/db";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";

async function main() {
  const pool = createPool(acceptanceDatabaseUrl());
  try {
    const out: Record<string, unknown> = {};
    for (const key of ["sep", "oct"] as const) {
      const [r] = await branchRows(pool, { from: PERIODS[key].from, to: PERIODS[key].to, branchIds: ["B20"] });
      out[key] = { period: PERIODS[key].label, paidSpendCents: r.paidSpendCents, paidAcquired: r.paidAcquired, paidCacCents: r.paidAcquired ? Math.round(r.paidSpendCents / r.paidAcquired) : null };
    }
    console.log(JSON.stringify(out, null, 1));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
