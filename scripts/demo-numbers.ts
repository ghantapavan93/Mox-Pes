import { createPool, DEFAULT_DATABASE_URL } from "@/lib/db";
import { quarantineGroupIds, replay } from "@/lib/ingest/replay";
import { branchRows, conversionBridge, totals } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { formatCents } from "@/lib/primitives";
import { SCENARIO } from "@/lib/reference";
import { DEMO_NOW } from "@/lib/sim/world";

/**
 * Prints the numbers the demo script quotes, straight from the database, including a
 * DRY-RUN replay (rolled back): `npm run demo:numbers`. Run on a freshly seeded database.
 */
async function main() {
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const oct = { from: PERIODS.oct.from, to: PERIODS.oct.to, branchIds: null };
  const rows = await branchRows(pool, oct);
  const company = await totals(pool, oct, rows);
  const bridge = await conversionBridge(pool, oct);
  const b = rows.find((r) => r.branchId === SCENARIO.callFeedDriftBranch)!;
  const ids = await quarantineGroupIds(pool, { source: "calls", errorCode: "MISSING_FIELD", branchId: SCENARIO.callFeedDriftBranch });
  const ex = await pool.query("select id, evidence, first_detected_at from exceptions where kind = 'quarantined_source_records' and branch_id = $1", [SCENARIO.callFeedDriftBranch]);
  const dry = await replay(pool, {
    source: "calls", rawEventIds: ids, mapperVersion: "1.1", actor: "demo-numbers", idempotencyKey: `dry-${Date.now()}`, dryRun: true, now: DEMO_NOW,
    scope: { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: [SCENARIO.callFeedDriftBranch] },
    exceptionId: ex.rows[0] ? Number(ex.rows[0].id) : undefined,
  });
  const pct = (n: number, d: number) => `${Math.round((100 * n) / d)}%`;
  console.log(JSON.stringify({
    october: {
      platformClaimed: bridge.platformClaimed, paidLeadRecords: bridge.paidLeadRecords, paidProspects: bridge.paidProspects, serviced: bridge.serviced,
      companyPaidCac: company.paidCacCents && formatCents(company.paidCacCents), companyUnknown: pct(company.unknownAcquired, company.acquired),
      openExceptions: company.openExceptions, atRisk: formatCents(company.atRiskCents), unallocatedSpend: formatCents(company.unallocatedSpendCents),
    },
    incidentBranchOctober: { branch: b.branchId, name: b.name, paidCac: formatCents(Math.round(b.paidSpendCents / b.paidAcquired)), unknown: pct(b.unknownAcquired, b.acquired), acquired: b.acquired },
    quarantine: { records: ids.length, exceptionId: ex.rows[0]?.id, firstDetectedAt: ex.rows[0]?.first_detected_at, evidence: ex.rows[0]?.evidence },
    dryRunWholePeriod: { before: dry.before, after: dry.after, claimed: dry.claimed, projected: dry.projected },
  }, null, 2));
  await pool.end();
}
main();
