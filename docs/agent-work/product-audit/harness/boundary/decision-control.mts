// Read-only control for the decision boundary (2026-11-17), on a seeded database:
//   1. the accepted ledger (counted spend, campaign-days, collected cash) as a fingerprint;
//   2. for every branch × period, the gate's legacy outputs (signal, ratio, from, to, trustworthy,
//      blockers) recomputed by a frozen copy of the rule as it stood before the boundary, compared
//      with what `budgetSignal` returns now: they must be equal everywhere;
//   3. every branch × period where the boundary now says something the raw rule did not: a basis
//      other than "branch", a held recommendation, a left-out channel, a limitation, or a channel
//      readiness that changed. Run it on the pristine seed to see the whole blast radius.
// Usage (from the repo): npx tsx docs/agent-work/product-audit/harness/boundary/decision-control.mts <database>
import { createHash } from "node:crypto";
import { fileURLToPath, pathToFileURL } from "node:url";

const repo = fileURLToPath(new URL("../../../../../", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
const imp = (p: string) => import(pathToFileURL(`${repo}/${p}`).href);
const db = process.argv[2];
if (!db || db === "revenue_signal") throw new Error("name an isolated database, never the demo one");
const { createPool } = await imp("lib/db.ts");
const { channelRows } = await imp("lib/metrics/scorecard.ts");
const { budgetSignal, SIGNAL_MIN_CUSTOMERS, SIGNAL_RATIO } = await imp("lib/metrics/decision.ts");
const { decisionVerdicts } = await imp("lib/decision/verdicts.ts");
const { PERIODS } = await imp("lib/period.ts");
const { VIEWERS } = await imp("lib/viewer.ts");
const pool = createPool(`postgres://postgres@127.0.0.1:54333/${db}`);

const ledger = (
  await pool.query(
    `select (select coalesce(sum(cost_cents), 0) from ad_spend_daily) as spend, (select count(*) from ad_spend_daily) as days,
            (select coalesce(sum(amount_cents), 0) from crm_payments where status = 'successful') as collected,
            (select count(*) from raw_events) as raw_events, (select count(*) from exceptions where status = 'open') as open_exceptions`,
  )
).rows[0];
console.log(`${db} ledger: ${JSON.stringify(ledger)}`);

/** The comparison exactly as `budgetSignal` computed it before the boundary (lib/metrics/decision.ts, v4). */
function frozen(channels: Array<{ channelCode: string; cacCents: number | null; acquired: number }>) {
  const comparable = channels.filter((c) => c.cacCents !== null && c.acquired >= SIGNAL_MIN_CUSTOMERS);
  const sorted = [...comparable].sort((a, b) => (b.cacCents ?? 0) - (a.cacCents ?? 0));
  const from = sorted[0] ?? null;
  const to = sorted[sorted.length - 1] ?? null;
  const ratio = from && to && to.cacCents ? from.cacCents! / to.cacCents : null;
  const signal = ratio !== null && ratio >= SIGNAL_RATIO && from !== to ? "shift" : "none";
  return { signal, ratio, from: signal === "shift" ? from!.channelCode : null, to: signal === "shift" ? to!.channelCode : null };
}

const legacy: string[] = [];
const changed: string[] = [];
let mismatches = 0;
const branches = (await pool.query("select id from branches order by id")).rows.map((r: { id: string }) => r.id);
for (const key of ["sep", "oct", "all"]) {
  const period = PERIODS[key];
  for (const b of branches) {
    const media = (await channelRows(pool, { from: period.from, to: period.to, branchIds: [b] })).filter((c: { costBasis: string }) => c.costBasis === "media");
    const old = frozen(media);
    const s = await budgetSignal(pool, b, { from: period.from, to: period.to });
    const now = { signal: s.signal, ratio: s.ratio, from: s.from?.channelCode ?? null, to: s.to?.channelCode ?? null };
    if (JSON.stringify(old) !== JSON.stringify(now)) {
      mismatches++;
      console.log(`LEGACY MISMATCH ${key} ${b}: before ${JSON.stringify(old)} now ${JSON.stringify(now)}`);
    }
    legacy.push(`${key} ${b} ${JSON.stringify(now)} ${s.trustworthy} ${s.blockers.map((x: { exceptionId: number }) => x.exceptionId).join(",")}`);
    const v = await decisionVerdicts(pool, VIEWERS.marketing, { branchId: b, period });
    const costFails = v.channels.flatMap((c: any) => c.readiness.blockers.filter((r: any) => String(r.code).startsWith("cost_")).map((r: any) => `${c.channelCode}:${r.code}`));
    const notes = [
      s.comparison.basis !== "branch" ? `basis ${s.comparison.basis}` : "",
      s.recommendation.status !== s.signal ? `recommendation ${s.recommendation.status} (raw ${s.signal})` : "",
      s.excluded.length ? `left out ${s.excluded.map((x: any) => `${x.channelCode}[${x.reasons.map((r: any) => r.code).join(",")}]`).join(" ")}` : "",
      s.eligibility.some((e: any) => e.limitations.length) ? `limitations ${s.eligibility.filter((e: any) => e.limitations.length).map((e: any) => e.channelCode).join(",")}` : "",
      costFails.length ? `readiness now fails ${costFails.join(" ")}` : "",
    ].filter(Boolean);
    if (notes.length) changed.push(`${key} ${b}: ${notes.join("; ")}`);
  }
}
await pool.end();
console.log(`legacy outputs: ${legacy.length} branch-periods, ${mismatches} mismatches, fingerprint ${createHash("sha256").update(legacy.join("\n")).digest("hex").slice(0, 16)}`);
console.log(changed.length ? `WHERE THE BOUNDARY SAYS MORE (${changed.length}):\n${changed.join("\n")}` : "the boundary says nothing new anywhere");
