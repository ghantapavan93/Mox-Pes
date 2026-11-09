import { createPool, DEFAULT_DATABASE_URL } from "@/lib/db";
import { branchRows, channelRows, conversionBridge, totals } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { formatCents } from "@/lib/primitives";

/** Prints the headline numbers for a period: `npm run report -- oct` */
async function main() {
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const period = PERIODS[(process.argv[2] as keyof typeof PERIODS) ?? "oct"] ?? PERIODS.oct;
  const scope = { from: period.from, to: period.to, branchIds: null };
  const t0 = Date.now();
  const rows = await branchRows(pool, scope);
  const t = await totals(pool, scope, rows);
  const bridge = await conversionBridge(pool, scope);
  const channels = await channelRows(pool, scope);
  console.log(`${period.label}  (queries ${Date.now() - t0} ms)`);
  console.log({ ...t, paidSpend: formatCents(t.paidSpendCents), collected: formatCents(t.collectedCents), cac: t.paidCacCents && formatCents(t.paidCacCents) });
  console.log(bridge);
  console.table(channels.map((c) => ({ ch: c.channelCode, spend: formatCents(c.spendCents), prospects: c.prospects, acquired: c.acquired, cac: c.cacCents && formatCents(c.cacCents) })));
  const cacs = rows.map((r) => ({ id: r.branchId, cac: r.paidAcquired ? Math.round(r.paidSpendCents / r.paidAcquired / 100) : null, unk: r.acquired ? Math.round((100 * r.unknownAcquired) / r.acquired) : null, acq: r.acquired, exc: r.openExceptions, risk: Math.round(r.atRiskCents / 100) }));
  console.table(cacs.sort((a, b) => (b.cac ?? 0) - (a.cac ?? 0)).slice(0, 8));
  await pool.end();
}
main();
