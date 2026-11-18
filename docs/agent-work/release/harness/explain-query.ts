/**
 * Prints the plan of one read model's slowest query, for WP-G step 2 (RELEASE-DESIGN.md §5.10):
 *
 *   DATABASE_URL=… npx tsx docs/agent-work/release/harness/explain-query.ts [branchRows|evidenceHolds|decisionHolds|conversionBridge|weeklySeries]
 *
 * It runs the read model once with October's scope over every branch, captures each SQL statement
 * it sends, and runs EXPLAIN (ANALYZE, BUFFERS) on the slowest one with the same parameters.
 * Read-only: EXPLAIN ANALYZE of a SELECT executes it and changes nothing.
 */
import { createPool } from "@/lib/db";
import { branchRows, conversionBridge } from "@/lib/metrics/scorecard";
import { decisionHolds, evidenceHolds } from "@/lib/metrics/decision";
import { weeklySeries } from "@/lib/queries";
import { PERIODS } from "@/lib/period";

type Captured = { text: string; values: unknown[]; ms: number };

async function main() {
  const which = process.argv[2] ?? "branchRows";
  const pool = createPool(process.env.DATABASE_URL!);
  const captured: Captured[] = [];
  const original = pool.query.bind(pool) as (...args: unknown[]) => Promise<unknown>;
  (pool as unknown as { query: (...args: unknown[]) => Promise<unknown> }).query = async (...args: unknown[]) => {
    const text = typeof args[0] === "string" ? args[0] : (args[0] as { text: string }).text;
    const values = (Array.isArray(args[1]) ? args[1] : []) as unknown[];
    const t0 = performance.now();
    const out = await original(...args);
    captured.push({ text, values, ms: performance.now() - t0 });
    return out;
  };
  const p = PERIODS.oct;
  const scope = { from: p.from, to: p.to, branchIds: null };
  const run: Record<string, () => Promise<unknown>> = {
    branchRows: () => branchRows(pool, scope),
    conversionBridge: () => conversionBridge(pool, scope),
    decisionHolds: () => decisionHolds(pool, null, 8, p),
    evidenceHolds: () => evidenceHolds(pool, null, p),
    weeklySeries: () => weeklySeries(pool, null),
  };
  if (!run[which]) throw new Error(`unknown read model ${which}`);
  await run[which]();
  const slowest = [...captured].sort((a, b) => b.ms - a.ms)[0];
  console.log(`${which}: ${captured.length} statement(s); slowest ${Math.round(slowest.ms)} ms`);
  const plan = await original(`explain (analyze, buffers, format text) ${slowest.text}`, slowest.values);
  for (const row of (plan as { rows: Array<Record<string, string>> }).rows) console.log(row["QUERY PLAN"]);
  await pool.end();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
