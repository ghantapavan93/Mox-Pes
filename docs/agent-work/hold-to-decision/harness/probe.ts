/**
 * Every readiness check for one branch and period, read straight from the product's functions
 * (HOLD-TO-DECISION.md §2-§3): the budget gate, the Overview's holds, Decision Lab readiness and
 * integrity, verified readiness, the scorecard's held-spend counts, and the ledger rows.
 *   ACCEPTANCE_DATABASE_URL=… npx tsx docs/agent-work/hold-to-decision/harness/probe.ts <out.json> [branch] [period]
 * Reads only.
 */
import { writeFileSync } from "node:fs";
import { acceptanceDatabaseUrl } from "@/tests/acceptance/b09/env";
import { createPool } from "@/lib/db";
import { decisionVerdicts } from "@/lib/decision/verdicts";
import { verifiedReadinessSnapshot } from "@/lib/decision/verified";
import { budgetSignal, decisionHolds } from "@/lib/metrics/decision";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS, type PeriodKey } from "@/lib/period";
import { gapStatusesAt } from "@/lib/reconcile/gap-status";
import { VIEWERS } from "@/lib/viewer";

async function main() {
  const [out, branchId = "B09", periodKey = "oct"] = process.argv.slice(2);
  const period = PERIODS[periodKey as PeriodKey];
  const pool = createPool(acceptanceDatabaseUrl());
  try {
    const viewer = VIEWERS.marketing;
    const signal = await budgetSignal(pool, branchId, { from: period.from, to: period.to });
    const holds = await decisionHolds(pool, null, 50);
    const verdicts = await decisionVerdicts(pool, viewer, { branchId, period });
    const verified = await verifiedReadinessSnapshot(pool, viewer, { branchId, period });
    const [row] = await branchRows(pool, { from: period.from, to: period.to, branchIds: [branchId] });
    const gaps = await gapStatusesAt(pool, branchId, { range: { from: period.from.toISOString().slice(0, 10), to: period.to.toISOString().slice(0, 10) } });
    const ledger = (
      await pool.query(
        `select c.external_campaign_id, s.spend_date::text as date, s.channel_code, s.cost_cents, s.raw_event_id, re.payload ->> 'fetchedAt' as fetched_at
         from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id join raw_events re on re.id = s.raw_event_id
         where s.spend_date in ('2026-10-20', '2026-10-22', '2026-09-20') and c.external_campaign_id in ('pmax-lsa-B09', 'gs-B10', 'gs-B09', 'lsa-B09')
         order by 1, 2`,
      )
    ).rows;
    const held = (
      await pool.query(
        `select id, status, coalesce(error_code, exclusion_code) as code, entity_id, payload ->> 'fetchedAt' as fetched_at, ingestion_run_id
         from raw_events where source = 'ads' and status in ('quarantined', 'excluded') order by id`,
      )
    ).rows;
    const incidents = (await pool.query("select id, kind, branch_id, status, summary from exceptions where kind = 'quarantined_source_records' order by id")).rows;
    const result = {
      branchId,
      period: periodKey,
      gate: { trustworthy: signal.trustworthy, blockers: signal.blockers },
      overviewHolds: holds.filter((h) => h.branchId === branchId || h.kind === "quarantined_source_records"),
      decisionLab: verdicts.channels.map((c) => ({
        channel: c.label,
        integrity: c.integrity.status,
        integrityFails: c.integrity.reasons.filter((r) => r.status === "fail").map((r) => r.text),
        readiness: c.readiness.status,
        readinessBlockers: c.readiness.blockers.map((r) => r.text),
      })),
      verified: verified.channels.map((c) => ({ channel: c.label, state: c.state, because: c.because, failed: c.rules.filter((r) => !r.passed).map((r) => `${r.code}: ${r.text}`) })),
      scorecard: { paidSpendCents: row.paidSpendCents, heldCampaignAcquired: row.heldCampaignAcquired, partlyHeldAcquired: row.partlyHeldAcquired },
      gaps: gaps.map((g) => ({ id: g.exceptionId, state: g.state, conclusion: g.conclusion, change: g.change })),
      ledger,
      held,
      incidents,
    };
    writeFileSync(out, JSON.stringify(result, null, 2));
    console.log(JSON.stringify({ gate: result.gate, decisionLab: result.decisionLab.map((c) => `${c.channel}: integrity ${c.integrity}, readiness ${c.readiness}`), verified: result.verified.map((v) => `${v.channel}: ${v.state}`), scorecard: result.scorecard }, null, 1));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
