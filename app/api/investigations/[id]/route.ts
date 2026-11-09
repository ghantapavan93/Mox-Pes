import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { getInvestigation, proposalStates } from "@/lib/ai/queries";
import { errorResponse } from "@/lib/http";
import { getPool, getViewer } from "@/lib/server";

const query = z.object({ afterSeq: z.coerce.number().int().min(0).default(0) });

/**
 * GET /api/investigations/:id?afterSeq= — one investigation: status, result, the steps after
 * `afterSeq` (for polling a running investigation) and the live Action Center state of the
 * proposals it created or linked. Outside the viewer's scope → 404, like a missing id.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  // Outside try: during prerendering connection() rejects by design, and that must not be logged as a route error.
  await connection();
  try {
    const { id } = await ctx.params;
    if (!/^\d{1,15}$/.test(id)) throw new ActionError("Investigation not found", 404);
    const input = query.parse(Object.fromEntries(new URL(request.url).searchParams));
    const viewer = await getViewer();
    const pool = getPool();
    const investigation = await getInvestigation(pool, viewer, Number(id), { afterSeq: input.afterSeq });
    if (!investigation) throw new ActionError("Investigation not found", 404);
    const ids = (investigation.result?.proposals ?? []).map((p) => p.proposalId).filter((p): p is number => p !== null);
    return NextResponse.json({ ...investigation, proposalStates: await proposalStates(pool, viewer, ids) });
  } catch (error) {
    return errorResponse(error);
  }
}
