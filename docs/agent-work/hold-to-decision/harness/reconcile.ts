/**
 * Apply pending migrations to an acceptance database and run reconciliation once at its business
 * clock, as the worker would after the next delivery (HOLD-TO-DECISION.md §3). Acceptance
 * databases only.
 *   ACCEPTANCE_DATABASE_URL=… npx tsx docs/agent-work/hold-to-decision/harness/reconcile.ts
 */
import { acceptanceDatabaseName, acceptanceDatabaseUrl } from "@/tests/acceptance/b09/env";
import { createPool, getNow, withTransaction } from "@/lib/db";
import { migrate } from "@/lib/migrate";
import { reconcile } from "@/lib/reconcile/reconcile";

async function main() {
  const pool = createPool(acceptanceDatabaseUrl());
  try {
    const ran = await migrate(pool, (line) => console.log(line));
    const now = await getNow(pool);
    const result = await withTransaction(pool, (tx) => reconcile(tx, now));
    console.log(JSON.stringify({ database: acceptanceDatabaseName(), migrations: ran.length, now, ...result }));
  } finally {
    await pool.end();
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
