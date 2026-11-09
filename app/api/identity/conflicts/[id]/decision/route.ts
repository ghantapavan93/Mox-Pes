import { NextResponse } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { errorResponse } from "@/lib/http";
import { decideIdentityConflict } from "@/lib/identity";
import { businessNow, getPool, getViewer } from "@/lib/server";
import { ForbiddenError } from "@/lib/viewer";

const body = z.object({
  decision: z.enum(["accept", "reject"]),
  reason: z.string().trim().min(5).max(500),
});

/**
 * POST /api/identity/conflicts/:id/decision — accept or reject one ambiguous match, with a
 * reason. Needs `reviewIdentity`; the conflict must be pending and inside the caller's branch
 * scope (otherwise 404, so scope is not probed). Accepting links the lead with rule
 * `reviewer_accepted` and rejects the lead's other candidates; the decision, the link change and
 * the audit row commit together.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!/^\d{1,15}$/.test(id)) throw new ActionError("Identity conflict not found", 404);
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    if (!viewer.can.reviewIdentity) throw new ForbiddenError(`${viewer.label} cannot review identity matches`);
    const result = await decideIdentityConflict(getPool(), {
      conflictId: Number(id),
      decision: input.decision,
      reason: input.reason,
      actor: viewer.role,
      now: await businessNow(),
      scope: viewer.branchIds,
    });
    console.log(
      JSON.stringify({ level: "info", msg: "identity decision", conflictId: result.conflict.id, decision: input.decision, actor: viewer.role, autoRejected: result.autoRejectedIds.length }),
    );
    let message: string;
    if (input.decision === "accept") {
      const others = result.autoRejectedIds.length;
      message = `Linked to CRM customer ${result.conflict.crmCustomerId}${others ? `; ${others} other candidate${others === 1 ? "" : "s"} rejected` : ""}.`;
    } else if (result.link?.rule === "prospect_phone_hash" || result.link?.rule === "prospect_email_hash") {
      message = "Rejected. Every candidate is now rejected, so the lead is kept as a prospect.";
    } else {
      message = "Rejected. The lead stays unlinked until its other candidates are decided.";
    }
    return NextResponse.json({ conflict: result.conflict, autoRejectedIds: result.autoRejectedIds, link: result.link, message });
  } catch (error) {
    return errorResponse(error);
  }
}
