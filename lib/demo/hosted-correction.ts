import type { Pool } from "pg";
import { getNow } from "@/lib/db";
import { VIEWERS } from "@/lib/viewer";
import { approveProposal, createProposal, dryRunProposal, executeProposal } from "@/lib/workflow/proposals";
import { caseForException, caseProposals } from "@/lib/workflow/queries";

/**
 * The hosted copy's one approved correction: B20's quarantined calls replayed through calls@1.1,
 * taken through the Action Center as the demo roles would (the marketing analyst proposes, the
 * integration engineer dry-runs, the revenue ops approver, a different role, approves and
 * executes). The hosted demo has no staff roles, so `npm run db:correct-hosted` runs this once
 * after the hosted loader; tests run it on a seeded world to ask what a visitor asks there.
 */

export interface HostedCorrection {
  exceptionId: number;
  proposalId: number;
  /** October, as the receipt stores it: before and after the repair. */
  before: { paidCacCents: number | null; paidAcquired: number; acquired: number; paidSpendCents: number } | null;
  after: { paidCacCents: number | null; paidAcquired: number; acquired: number; paidSpendCents: number } | null;
}

/** Runs the correction; null when B20 has no open quarantine incident (it was already corrected). */
export async function applyHostedCorrection(db: Pool): Promise<HostedCorrection | null> {
  const open = await db.query<{ id: string }>(
    "select id from exceptions where branch_id = 'B20' and kind = 'quarantined_source_records' and status = 'open' order by id limit 1",
  );
  if (open.rows.length === 0) return null;
  const exceptionId = Number(open.rows[0].id);
  const now = await getNow(db);
  const proposal = await createProposal(db, {
    exceptionId,
    kind: "replay_quarantine",
    params: { mapperVersion: "1.1" },
    rationale: "Replay the held calls through calls@1.1, which reads the renamed caller field",
    source: "human",
    actor: VIEWERS.marketing,
    now,
  });
  const dry = await dryRunProposal(db, { proposalId: proposal.id, actor: VIEWERS.engineer, now });
  if (dry.status !== "dry_run_ok") throw new Error(`The dry run did not pass: ${dry.dryRun?.error ?? dry.status}`);
  await approveProposal(db, { proposalId: proposal.id, actor: VIEWERS.approver, reason: "Dry run verified; the five ledger totals are conserved", now });
  await executeProposal(db, { proposalId: proposal.id, actor: VIEWERS.approver, now });

  const kase = await caseForException(db, exceptionId);
  const execution = (await caseProposals(db, kase!.id)).find((p) => p.id === proposal.id)?.execution;
  if (execution?.status !== "succeeded") throw new Error(`The execution did not succeed: ${execution?.status ?? "missing"}`);
  const figures = (b: NonNullable<NonNullable<typeof execution.before>["month"]>["branch"] | undefined) =>
    b ? { paidCacCents: b.paidCacCents, paidAcquired: b.paidAcquired, acquired: b.acquired, paidSpendCents: b.paidSpendCents } : null;
  return { exceptionId, proposalId: proposal.id, before: figures(execution.before?.month?.branch), after: figures(execution.after?.month?.branch) };
}
