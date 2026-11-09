import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { errorResponse } from "@/lib/http";
import { getPool, getViewer } from "@/lib/server";
import { ROLES } from "@/lib/viewer";
import { assignCaseOwner, closeCase } from "@/lib/workflow/proposals";
import { MANUAL_CLOSE_STATES } from "@/lib/workflow/states";

const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("assign"), owner: z.enum(ROLES).nullable() }),
  z.object({ action: z.literal("close"), outcome: z.enum(MANUAL_CLOSE_STATES), reason: z.string().trim().min(10).max(1000) }),
]);

/**
 * POST /api/cases/:id — assign the owning role, or close the case without a fix (cancelled,
 * unresolvable, insufficient evidence) with a reason. Audited; scope checked on the server.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    const { id } = await ctx.params;
    if (!/^\d{1,15}$/.test(id)) throw new ActionError("Case not found", 404);
    const caseId = Number(id);
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    if (input.action === "assign") {
      const kase = await assignCaseOwner(getPool(), { caseId, owner: input.owner, actor: viewer });
      return NextResponse.json({ case: kase, message: input.owner ? `Owned by ${input.owner}.` : "Unassigned." });
    }
    const kase = await closeCase(getPool(), { caseId, outcome: input.outcome, reason: input.reason, actor: viewer });
    return NextResponse.json({ case: kase, message: "Case closed." });
  } catch (error) {
    return errorResponse(error);
  }
}
