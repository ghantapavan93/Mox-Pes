import { createPool, getNow } from "@/lib/db";
import { VIEWERS } from "@/lib/viewer";
import { approveProposal, createProposal, dryRunProposal, executeProposal } from "@/lib/workflow/proposals";
import { caseForException, caseProposals } from "@/lib/workflow/queries";
import { readClipboard } from "./clipboard";

/**
 * Runs B20's correction through the Action Center on a loaded copy of the demo world: the
 * marketing analyst proposes replaying the held calls through calls@1.1, the integration engineer
 * dry-runs it, and the revenue ops approver, a different role, approves and executes it. The hosted
 * demo has no staff roles, so without this a visitor finds held decisions but never an approved
 * correction, its receipt and its audit trail (release design §1, success 5).
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
    const open = await pool.query<{ id: string }>(
      "select id from exceptions where branch_id = 'B20' and kind = 'quarantined_source_records' and status = 'open' order by id limit 1",
    );
    if (open.rows.length === 0) {
      console.log("B20 has no open quarantine incident: nothing to correct.");
      return;
    }
    const exceptionId = Number(open.rows[0].id);
    const now = await getNow(pool);
    const proposal = await createProposal(pool, {
      exceptionId,
      kind: "replay_quarantine",
      params: { mapperVersion: "1.1" },
      rationale: "Replay the held calls through calls@1.1, which reads the renamed caller field",
      source: "human",
      actor: VIEWERS.marketing,
      now,
    });
    const dry = await dryRunProposal(pool, { proposalId: proposal.id, actor: VIEWERS.engineer, now });
    if (dry.status !== "dry_run_ok") throw new Error(`The dry run did not pass: ${dry.dryRun?.error ?? dry.status}`);
    await approveProposal(pool, { proposalId: proposal.id, actor: VIEWERS.approver, reason: "Dry run verified; the five ledger totals are conserved", now });
    await executeProposal(pool, { proposalId: proposal.id, actor: VIEWERS.approver, now });

    const kase = await caseForException(pool, exceptionId);
    const execution = (await caseProposals(pool, kase!.id)).find((p) => p.id === proposal.id)?.execution;
    if (execution?.status !== "succeeded") throw new Error(`The execution did not succeed: ${execution?.status ?? "missing"}`);
    const before = execution.before?.month?.branch;
    const after = execution.after?.month?.branch;
    const dollars = (cents: number | null | undefined) => (cents == null ? "none" : `$${(cents / 100).toFixed(2)}`);
    console.log(`Corrected incident #${exceptionId} (proposal #${proposal.id}): October paid CAC ${dollars(before?.paidCacCents)} → ${dollars(after?.paidCacCents)}, paid customers ${before?.paidAcquired} → ${after?.paidAcquired}, serviced ${before?.acquired} → ${after?.acquired}.`);
  } finally {
    await pool.end();
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exit(1);
});
