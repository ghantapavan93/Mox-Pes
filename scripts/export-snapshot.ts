import { mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { createPool, DEFAULT_DATABASE_URL } from "@/lib/db";
import { feedbackSummary } from "@/lib/feedback";
import { quarantineGroupIds, replay } from "@/lib/ingest/replay";
import { branchRows, conversionBridge, totals } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { failedRunsWithRecovery, quarantineSamples, streamTotals, weeklySeries } from "@/lib/queries";
import { SCENARIO } from "@/lib/reference";
import { DEMO_NOW } from "@/lib/sim/world";

/**
 * Exports the numbers the public case-file page shows, computed by the app's own code:
 * `npm run export:snapshot -- <out.json>`. Run on a freshly seeded database.
 *
 * WARNING: this performs a REAL replay (and its repeat, to prove idempotency) so the
 * "after" weekly series comes from the database. Reseed afterwards (`npm run db:seed`).
 */
async function main() {
  const out = process.argv[2] ?? "docs/case-file/snapshot.json";
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const branch = SCENARIO.callFeedDriftBranch;
  const oct = { from: PERIODS.oct.from, to: PERIODS.oct.to, branchIds: null };
  const whole = { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: [branch] };

  const already = await pool.query("select count(*)::int as n from replays");
  if (already.rows[0].n > 0) throw new Error("Database already has replays; reseed first (npm run db:seed).");

  const rowsBefore = await branchRows(pool, oct);
  const companyBefore = await totals(pool, oct, rowsBefore);
  const bridge = await conversionBridge(pool, oct);
  const weeklyBefore = await weeklySeries(pool, [branch]);
  const weeklyCompany = await weeklySeries(pool, null);
  const streams = await streamTotals(pool);
  const failedRuns = await failedRunsWithRecovery(pool);
  const runs = await pool.query(
    "select count(*)::int as runs, count(*) filter (where status = 'failed')::int as failed, sum(duplicates)::int as duplicates from ingestion_runs",
  );
  const ids = await quarantineGroupIds(pool, { source: "calls", errorCode: "MISSING_FIELD", branchId: branch });
  const ex = await pool.query(
    "select id, evidence, first_detected_at from exceptions where kind = 'quarantined_source_records' and branch_id = $1",
    [branch],
  );
  const exceptionId = Number(ex.rows[0].id);
  const samples = (await quarantineSamples(pool, ids.slice(0, 2))).map((s) => ({
    id: Number(s.id),
    occurredAt: s.occurred_at,
    adapterVersion: s.adapter_version,
    errorCode: s.error_code,
    errorDetail: s.error_detail,
    payload: s.payload,
    customers: s.customers,
  }));
  const feedbackBefore = await feedbackSummary(pool, whole, DEMO_NOW);

  const request = {
    source: "calls" as const, rawEventIds: ids, mapperVersion: "1.1", actor: "export-snapshot",
    now: DEMO_NOW, scope: whole, exceptionId,
  };
  const dry = await replay(pool, { ...request, idempotencyKey: "snapshot-dry", dryRun: true });
  const real = await replay(pool, { ...request, idempotencyKey: "snapshot-replay", dryRun: false });
  const repeat = await replay(pool, { ...request, idempotencyKey: "snapshot-replay", dryRun: false });

  const rowsAfter = await branchRows(pool, oct);
  const weeklyAfter = await weeklySeries(pool, [branch]);
  const feedbackAfter = await feedbackSummary(pool, whole, DEMO_NOW);
  const branchExceptions = await pool.query(
    "select kind, status, count(*)::int as n from exceptions where branch_id = $1 group by kind, status order by kind, status",
    [branch],
  );

  const snapshot = {
    generatedBy: "scripts/export-snapshot.ts",
    demoNow: DEMO_NOW.toISOString(),
    branch,
    october: { bridge, company: companyBefore, rowsBefore, rowsAfter },
    weekly: { branchBefore: weeklyBefore, branchAfter: weeklyAfter, company: weeklyCompany },
    ingestion: { streams, failedRuns, ...runs.rows[0] },
    incident: {
      exceptionId,
      firstDetectedAt: ex.rows[0].first_detected_at,
      evidence: ex.rows[0].evidence,
      quarantinedRecords: ids.length,
      samples,
    },
    replay: {
      dryRun: { before: dry.before, after: dry.after, claimed: dry.claimed, projected: dry.projected },
      real: { claimed: real.claimed, projected: real.projected, stillQuarantined: real.stillQuarantined },
      repeat: { claimed: repeat.claimed, projected: repeat.projected, idempotencyKey: repeat.idempotencyKey },
    },
    feedback: { before: feedbackBefore, after: feedbackAfter },
    branchExceptionsAfter: branchExceptions.rows,
  };
  mkdirSync(dirname(out), { recursive: true });
  writeFileSync(out, JSON.stringify(snapshot, null, 2));
  console.log(`Wrote ${out}. Database now has a real replay; run npm run db:seed to restore the demo state.`);
  await pool.end();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
