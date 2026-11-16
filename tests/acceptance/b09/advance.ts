/**
 * Advance the isolated B09 fixture by simulated source deliveries (docs/agent-work/HOLD-TO-DECISION.md).
 * Each step re-sends the source's own records through the ads feed's polling path, as the
 * acceptance proof does: runStream with the active mapper, then the intake's consumers. Nothing is
 * written to the product's tables directly, and nothing here is a control the product offers.
 *
 * It runs only on an acceptance database (revenue_signal_acceptance or
 * revenue_signal_acceptance_<suffix>, from ACCEPTANCE_DATABASE_URL), never the demo's.
 *
 *   npx tsx tests/acceptance/b09/prepare.ts                       a fresh world (about a minute)
 *   npx tsx tests/acceptance/b09/advance.ts partial rest refused  deliveries, in order
 *   npx tsx tests/acceptance/b09/advance.ts --status              where B09's October decision stands
 *
 * Steps: partial, rest, duplicate, older, stale (deliveries.ts STEPS), then refused, refusedOther,
 * refusedAgain, olderWhileHeld, acceptedAgain, corrected, sharedAccount, september, unmapped,
 * unidentified, heldDay, regression (REVISION_STEPS).
 */
import { createPool } from "@/lib/db";
import { runOutcome } from "@/lib/ingest/run-outcome";
import { budgetSignal } from "@/lib/metrics/decision";
import { PERIODS } from "@/lib/period";
import { gapStatusesAt } from "@/lib/reconcile/gap-status";
import { deliver, REVISION_STEPS, STEPS, type AnyStep } from "./deliveries";
import { acceptanceDatabaseName, acceptanceDatabaseUrl } from "./env";

const KNOWN = new Set<string>([...Object.keys(STEPS), ...Object.keys(REVISION_STEPS)]);
const money = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

async function main() {
  const args = process.argv.slice(2);
  const unknown = args.filter((a) => a !== "--status" && !KNOWN.has(a));
  if (args.length === 0 || unknown.length > 0) {
    console.error(`usage: advance.ts <step...> | --status\nunknown: ${unknown.join(", ") || "(none given)"}\nsteps: ${[...KNOWN].join(", ")}`);
    process.exit(2);
  }
  const pool = createPool(acceptanceDatabaseUrl());
  try {
    console.log(`[advance] database ${acceptanceDatabaseName()}`);
    for (const step of args.filter((a) => a !== "--status") as AnyStep[]) {
      const d = await deliver(pool, step);
      const { rows } = await pool.query(
        "select status, fetched, inserted, duplicates, conflicts, projected, quarantined, rows_changed from ingestion_runs where id = $1",
        [d.runId],
      );
      const run = rows[0];
      const outcome = runOutcome({
        fetched: Number(run.fetched),
        inserted: Number(run.inserted),
        duplicates: Number(run.duplicates),
        projected: Number(run.projected),
        rowsChanged: run.rows_changed === null ? null : Number(run.rows_changed),
      });
      console.log(`\n${step}: run #${d.runId} ${d.status}`);
      for (const s of d.sent) console.log(`  sent ${s.date} ${money(s.cents)} fetched ${s.fetchedAt} (${s.campaignName})`);
      console.log(`  stored ${run.inserted}, duplicates ${run.duplicates}, accepted ${run.projected}, refused ${run.quarantined}: ${outcome.effect}${outcome.reason ? ` (${outcome.reason})` : ""}`);
    }
    if (args.includes("--status") || args.length > 0) {
      const signal = await budgetSignal(pool, "B09", PERIODS.oct);
      const gaps = await gapStatusesAt(pool, "B09", { range: { from: "2026-10-01", to: "2026-11-01" } });
      console.log(`\nB09, October: ${signal.trustworthy ? "no open incident holds the budget decision" : "the budget decision is held"}`);
      for (const b of signal.blockers) console.log(`  held by #${b.exceptionId} (${b.kind}): ${b.summary}`);
      for (const g of gaps) console.log(`  coverage gap #${g.exceptionId}: ${g.conclusion}`);
    }
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(`[advance] ${(error as Error).message}`);
  process.exit(1);
});
