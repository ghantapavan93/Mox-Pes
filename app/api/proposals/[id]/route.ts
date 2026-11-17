import { NextResponse, after, connection } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { afterResponse, errorResponse } from "@/lib/http";
import { dispatchEvents } from "@/lib/events/consumers";
import { drainJobs } from "@/lib/jobs/kick";
import { getPool, getViewer } from "@/lib/server";
import { failureText } from "@/lib/workflow/failure";
import { approveProposal, dryRunProposal, executeProposal, rejectProposal } from "@/lib/workflow/proposals";
import { parseRecordId } from "@/lib/record-id";

const reason = z.string().trim().min(5).max(1000);
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("dry_run") }),
  // The fingerprint of the dry run the approver reviewed: an approval binds to what was read.
  z.object({ action: z.literal("approve"), reason, fingerprint: z.string().regex(/^[0-9a-f]{64}$/, "The reviewed dry run's fingerprint is required") }),
  z.object({ action: z.literal("reject"), reason }),
  z.object({ action: z.literal("execute") }),
]);

/**
 * POST /api/proposals/:id — move one proposal forward:
 *   dry_run (engineer) · approve / reject (approver, never the proposer's role) · execute
 *   (approver triggers; the application executes on the approver's behalf, once).
 * Permission and branch scope are re-checked on the server for every action.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    const { id } = await ctx.params;
    const proposalId = parseRecordId(id);
    if (proposalId === null) throw new ActionError("Proposal not found", 404);
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    const pool = getPool();

    switch (input.action) {
      case "dry_run": {
        const proposal = await dryRunProposal(pool, { proposalId, actor: viewer });
        const ok = proposal.status === "dry_run_ok";
        // The request succeeded either way; `outcome` says whether the dry run did, so a failed one
        // is shown as a failure, not with a success mark (lib/workflow/failure.ts).
        const message = ok ? "Dry run verified and rolled back. Awaiting approval by a different role." : failureText("Dry run did not verify", proposal.dryRun?.verification);
        return NextResponse.json({ proposal, message, outcome: ok ? "succeeded" : "failed" });
      }
      case "approve": {
        const proposal = await approveProposal(pool, { proposalId, actor: viewer, reason: input.reason, reviewedFingerprint: input.fingerprint });
        // Says what has NOT happened yet and who acts next: the case stays awaiting until the
        // approved fix is executed (UX red team 2026-11-12: "can now execute it" read as done).
        return NextResponse.json({ proposal, message: "Approved, not yet applied. Next: an approver executes it once (Execute); until then nothing has changed and the case stays awaiting." });
      }
      case "reject": {
        const proposal = await rejectProposal(pool, { proposalId, actor: viewer, reason: input.reason });
        return NextResponse.json({ proposal, message: "Rejected. The case is back under investigation." });
      }
      case "execute": {
        const result = await executeProposal(pool, { proposalId, actor: viewer });
        console.log(JSON.stringify({ level: "info", msg: "proposal executed", proposalId, status: result.execution.status, alreadyProcessed: result.alreadyProcessed }));
        // A trigger_sync execution queued a connector job: drain it after the response, as the
        // Integration Studio does (the worker would pick it up otherwise).
        if (!result.alreadyProcessed && result.execution.status === "succeeded" && typeof result.execution.result?.jobId === "number") {
          after(() => drainJobs(pool));
        } else if (!result.alreadyProcessed && result.execution.status === "succeeded") {
          // The execution published action_center.proposal_executed (and a replay its
          // intake.records_reprojected): let the consumers catch up after the response.
          afterResponse("event dispatch", () => dispatchEvents(pool));
        }
        const message = result.alreadyProcessed
          ? `Already executed (${result.execution.status}); nothing ran again.`
          : result.execution.status === "succeeded"
            ? "Executed and verified."
            : failureText("Execution failed and was rolled back", result.execution.verification);
        return NextResponse.json({ ...result, message, outcome: result.execution.status });
      }
    }
  } catch (error) {
    return errorResponse(error);
  }
}
