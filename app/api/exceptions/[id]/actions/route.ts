import { NextResponse } from "next/server";
import { z } from "zod";
import { ActionError, acknowledgeException, closeException, mapCampaignToBranch, overrideLeadBranch } from "@/lib/actions";
import { errorResponse } from "@/lib/http";
import { getException } from "@/lib/queries";
import { businessNow, getPool, getViewer } from "@/lib/server";
import { ForbiddenError, canSeeBranch } from "@/lib/viewer";

const reason = z.string().trim().min(5).max(500);
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("map_campaign"), branchId: z.string().regex(/^B\d{2}$/), reason }),
  z.object({ action: z.literal("override_lead_branch"), branchId: z.string().regex(/^B\d{2}$/), reason }),
  z.object({ action: z.literal("close"), reason }),
  z.object({ action: z.literal("acknowledge"), reason }),
]);

const ACTION_FOR_KIND: Record<string, string> = {
  unmapped_spend: "map_campaign",
  branch_mismatch: "override_lead_branch",
  payload_conflict: "close",
  channel_conflict: "acknowledge",
};

/** POST /api/exceptions/:id/actions — record a human decision on one exception. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await ctx.params;
    if (!/^\d{1,15}$/.test(id)) throw new ActionError("Exception not found", 404);
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    const pool = getPool();
    const exception = await getException(pool, Number(id));
    if (!exception || !canSeeBranch(viewer, exception.branchId)) throw new ActionError("Exception not found", 404);
    if (ACTION_FOR_KIND[exception.kind] !== input.action) throw new ActionError(`"${input.action}" does not apply to ${exception.kind}`, 400);
    if (exception.status !== "open") throw new ActionError("Exception is already resolved", 409);
    const now = await businessNow();
    const ev = exception.evidence as Record<string, unknown>;

    switch (input.action) {
      case "map_campaign":
        if (!viewer.can.decide) throw new ForbiddenError(`${viewer.label} cannot map campaigns`);
        await mapCampaignToBranch(pool, { campaignId: Number(ev.campaignId), branchId: input.branchId, actor: viewer.role, reason: input.reason, now });
        return NextResponse.json({ message: `Campaign mapped to ${input.branchId}. Spend now counts in that branch's CAC.` });
      case "override_lead_branch": {
        if (!viewer.can.decide) throw new ForbiddenError(`${viewer.label} cannot change lead credit`);
        const allowed = [ev.crmBranch, ev.territoryBranch].filter(Boolean);
        if (!allowed.includes(input.branchId)) throw new ActionError(`Branch must be one the evidence supports: ${allowed.join(" or ")}`, 400);
        await overrideLeadBranch(pool, { leadId: Number(ev.leadId), branchId: input.branchId, actor: viewer.role, reason: input.reason, now });
        return NextResponse.json({ message: `Lead credited to ${input.branchId}. Reconciliation re-ran.` });
      }
      case "acknowledge":
        if (!viewer.can.decide) throw new ForbiddenError(`${viewer.label} cannot acknowledge exceptions`);
        await acknowledgeException(pool, { exceptionId: exception.id, actor: viewer.role, reason: input.reason, now });
        return NextResponse.json({ message: "Acknowledged. It no longer counts as open." });
      case "close":
        if (!viewer.can.closeConflicts) throw new ForbiddenError(`${viewer.label} cannot close conflicts`);
        await closeException(pool, { exceptionId: exception.id, actor: viewer.role, reason: input.reason, now });
        return NextResponse.json({ message: "Conflict closed." });
    }
  } catch (error) {
    return errorResponse(error);
  }
}
