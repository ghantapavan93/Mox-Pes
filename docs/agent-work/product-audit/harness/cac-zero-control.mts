// Read-only control for the "no mapped spend → $0.00 paid CAC" fix: on a seeded database, list
// every place the product would compute a paid CAC with zero spend and at least one paid customer
// (branch rows, channel rows per branch and company, weekly bars, brand totals). An empty list means
// the fix cannot change any seeded figure. Also prints the non-zero CACs as a fingerprint, so the
// same script run before and after the change proves those are unchanged.
// Usage (from the repo): npx tsx docs/agent-work/product-audit/harness/cac-zero-control.mts <database name>
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../../../../", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
const imp = (p: string) => import(pathToFileURL(`${repo}/${p}`).href);
const { createPool } = await imp("lib/db.ts");
const { branchRows, channelRows, totals, paidCac } = await imp("lib/metrics/scorecard.ts");
const { weeklySeries } = await imp("lib/queries.ts");
const { PERIODS } = await imp("lib/period.ts");
const { BRANDS, branchesOfBrands } = await imp("lib/reference.ts");

const db = process.argv[2];
if (!db || db === "revenue_signal") throw new Error("name an isolated database, never the demo one");
const pool = createPool(`postgres://postgres@127.0.0.1:54333/${db}`);
const zero: string[] = [];
const figures: string[] = [];

for (const period of Object.values(PERIODS) as { key: string; from: Date; to: Date }[]) {
  const scope = { from: period.from, to: period.to, branchIds: null };
  const rows = await branchRows(pool, scope);
  for (const r of rows) {
    if (r.paidSpendCents === 0 && r.paidAcquired > 0) zero.push(`${period.key} branch ${r.branchId}: $0 spend, ${r.paidAcquired} paid`);
    figures.push(`${period.key} ${r.branchId} ${paidCac(r.paidSpendCents, r.paidAcquired)}`);
    for (const c of await channelRows(pool, { ...scope, branchIds: [r.branchId] })) {
      if (c.costBasis === "media" && c.spendCents === 0 && c.acquired > 0) zero.push(`${period.key} ${r.branchId} channel ${c.channelCode}: $0 spend, ${c.acquired} customers`);
      figures.push(`${period.key} ${r.branchId} ${c.channelCode} ${c.cacCents}`);
    }
  }
  for (const c of await channelRows(pool, scope)) {
    if (c.costBasis === "media" && c.spendCents === 0 && c.acquired > 0) zero.push(`${period.key} company channel ${c.channelCode}: $0 spend, ${c.acquired} customers`);
    figures.push(`${period.key} company ${c.channelCode} ${c.cacCents}`);
  }
  const t = await totals(pool, scope, rows);
  figures.push(`${period.key} company ${t.paidCacCents}`);
  for (const brand of BRANDS as { id: string }[]) {
    const ids = branchesOfBrands([brand.id]);
    const own = rows.filter((r: { branchId: string }) => ids.includes(r.branchId));
    const spend = own.reduce((s: number, r: { paidSpendCents: number }) => s + r.paidSpendCents, 0);
    const paid = own.reduce((s: number, r: { paidAcquired: number }) => s + r.paidAcquired, 0);
    if (spend === 0 && paid > 0) zero.push(`${period.key} brand ${brand.id}: $0 spend, ${paid} paid`);
  }
}
const ids = (await branchRows(pool, { ...PERIODS.all, branchIds: null })).map((r: { branchId: string }) => r.branchId);
for (const scope of [null, ...ids.map((id: string) => [id])]) {
  for (const w of await weeklySeries(pool, scope)) {
    if (w.spendCents === 0 && w.paidAcquired > 0) zero.push(`week ${w.weekStart} ${scope?.[0] ?? "company"}: $0 spend, ${w.paidAcquired} paid`);
  }
}
await pool.end();
console.log(`${db}: ${figures.length} CAC figures, fingerprint ${createHash("sha256").update(figures.join("\n")).digest("hex").slice(0, 16)}`);
console.log(zero.length ? `ZERO-SPEND CASES (${zero.length}):\n${zero.join("\n")}` : "no zero-spend case with paid customers");
