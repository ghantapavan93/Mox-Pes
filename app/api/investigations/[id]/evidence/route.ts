import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { EvidenceIdSchema } from "@/lib/ai/evidence";
import { resolveEvidence } from "@/lib/ai/queries";
import { errorResponse } from "@/lib/http";
import { businessNow, getPool, getViewer } from "@/lib/server";

const query = z.object({ ref: EvidenceIdSchema });

/**
 * GET /api/investigations/:id/evidence?ref=exception:2455 — the record behind one citation, for
 * the evidence drawer. Served only for ids a step of this investigation returned, re-read now
 * through the same scoped tool (or, for derived figures, the tool output the step stored).
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
    return NextResponse.json(await resolveEvidence({ db: pool, viewer, now: await businessNow() }, Number(id), input.ref));
  } catch (error) {
    return errorResponse(error);
  }
}
