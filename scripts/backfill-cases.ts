import { DEFAULT_DATABASE_URL, createPool, getNow, withTransaction } from "@/lib/db";
import { lockReconcile } from "@/lib/reconcile/reconcile";
import { syncCases } from "@/lib/workflow/cases";

/**
 * Opens Action Center cases for a database whose exceptions predate migration 0006:
 * `npx tsx scripts/backfill-cases.ts` (DATABASE_URL overrides the demo database).
 *
 * Additive and idempotent: it runs only syncCases (one case per exception, resolved or
 * acknowledged ones closed with their exception), under the reconcile lock, at the business
 * clock. It does NOT re-run reconciliation, so no exception, metric or scenario number moves.
 * New databases need nothing: reconcile() calls syncCases itself.
 */
async function main() {
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  try {
    const result = await withTransaction(pool, async (tx) => {
      await lockReconcile(tx);
      const now = await getNow(tx);
      return { now, ...(await syncCases(tx, now)) };
    });
    console.log(
      `Cases at ${result.now.toISOString()}: ${result.created} opened, ${result.resolved} resolved, ` +
        `${result.acknowledged} closed as acknowledged, ${result.reopened} re-opened.`,
    );
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
