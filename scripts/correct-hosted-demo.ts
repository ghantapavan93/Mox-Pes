import { createPool } from "@/lib/db";
import { applyHostedCorrection } from "@/lib/demo/hosted-correction";
import { readClipboard } from "./clipboard";

/**
 * Runs B20's correction through the Action Center on a loaded copy of the demo world
 * (lib/demo/hosted-correction.ts): the marketing analyst proposes replaying the held calls through
 * calls@1.1, the integration engineer dry-runs it, and the revenue ops approver, a different role,
 * approves and executes it. The hosted demo has no staff roles, so without this a visitor finds
 * held decisions but never an approved correction, its receipt and its audit trail (release
 * design §1, success 5).
 *
 * Run once after the hosted loader, on the database it loaded (docs/deploy.md, step 2):
 *
 *   npm run db:correct-hosted -- --from-clipboard     the release branch's URL on the clipboard
 *   DATABASE_URL=… npm run db:correct-hosted          a local rehearsal copy
 *
 * The URL is never printed. Refuses the local demo, release-candidate and test databases, and does
 * nothing when B20's quarantine incident is no longer open.
 */

const PROTECTED = new Set(["revenue_signal", "revenue_signal_rc", "revenue_signal_test", "revenue_signal_deploy"]);

async function targetUrl(): Promise<string> {
  const raw = process.argv.includes("--from-clipboard") ? await readClipboard() : (process.env.DATABASE_URL ?? "");
  if (!/^postgres(ql)?:\/\/\S+$/.test(raw)) throw new Error("No database URL: put the release branch's URL on the clipboard (--from-clipboard) or set DATABASE_URL.");
  const name = decodeURIComponent(new URL(raw).pathname.slice(1));
  if (PROTECTED.has(name)) throw new Error(`Refusing to change the local ${name} database.`);
  return raw;
}

async function main() {
  const pool = createPool(await targetUrl());
  try {
    const done = await applyHostedCorrection(pool);
    if (!done) {
      console.log("B20 has no open quarantine incident: nothing to correct.");
      return;
    }
    const dollars = (cents: number | null | undefined) => (cents == null ? "none" : `$${(cents / 100).toFixed(2)}`);
    console.log(`Corrected incident #${done.exceptionId} (proposal #${done.proposalId}): October paid CAC ${dollars(done.before?.paidCacCents)} → ${dollars(done.after?.paidCacCents)}, paid customers ${done.before?.paidAcquired} → ${done.after?.paidAcquired}, serviced ${done.before?.acquired} → ${done.after?.acquired}.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
