import { NextResponse, after, connection } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { afterResponse, errorResponse } from "@/lib/http";
import { dispatchEvents } from "@/lib/events/consumers";
import { drainJobs } from "@/lib/jobs/kick";
import { getPool, getViewer } from "@/lib/server";
import { approveProposal, dryRunProposal, executeProposal, rejectProposal } from "@/lib/workflow/proposals";

const reason = z.string().trim().min(5).max(1000);
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("dry_run") }),
  z.object({ action: z.literal("approve"), reason }),
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
    if (!/^\d{1,15}$/.test(id)) throw new ActionError("Proposal not found", 404);
    const proposalId = Number(id);
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    const pool = getPool();

    switch (input.action) {
      case "dry_run": {
        const proposal = await dryRunProposal(pool, { proposalId, actor: viewer });
        const message =
          proposal.status === "dry_run_ok"
            ? "Dry run verified and rolled back. Awaiting approval by a different role."
            : `Dry run did not verify: ${proposal.dryRun?.error ?? "see the result"}`;
        return NextResponse.json({ proposal, message });
      }
      case "approve": {
        const proposal = await approveProposal(pool, { proposalId, actor: viewer, reason: input.reason });
        return NextResponse.json({ proposal, message: "Approved. The application can now execute it." });
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
            : `Execution failed and was rolled back: ${result.execution.error}`;
        return NextResponse.json({ ...result, message });
      }
    }
  } catch (error) {
    return errorResponse(error);
  }
}
