import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { StaleEvidenceError, recordDriftReview } from "@/lib/changeguard/review";
import { errorResponse } from "@/lib/http";
import { parseRecordId } from "@/lib/record-id";
import { businessNow, getPool, getViewer } from "@/lib/server";
import { ROLES } from "@/lib/viewer";

const body = z.discriminatedUnion("disposition", [
  z.object({
    disposition: z.literal("reviewed_no_change"),
    runId: z.number().int().positive(),
    evidenceKey: z.string().regex(/^[0-9a-f]{64}$/),
    rationale: z.string().max(1000),
  }),
  z.object({
    disposition: z.literal("needs_investigation"),
    runId: z.number().int().positive(),
    evidenceKey: z.string().regex(/^[0-9a-f]{64}$/),
    rationale: z.string().max(1000),
    owner: z.enum(ROLES),
  }),
]);

/**
 * POST /api/exceptions/:id/review — a person's decision on a post-release drift case, bound to the
 * check they read (runId) and that check's material facts (evidenceKey). Permission, scope and
 * freshness are checked on the server: a guest gets 403, a case outside the viewer's branches 404,
 * and newer evidence than the reviewer read a 409 with `conflict` saying which check to read.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    const { id } = await ctx.params;
    const exceptionId = parseRecordId(id);
    if (exceptionId === null) throw new ActionError("Case not found", 404);
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    const result = await recordDriftReview(getPool(), viewer, {
      exceptionId,
      runId: input.runId,
      evidenceKey: input.evidenceKey,
      disposition: input.disposition,
      rationale: input.rationale,
      owner: input.disposition === "needs_investigation" ? input.owner : null,
      now: await businessNow(),
    });
    return NextResponse.json({ message: result.message, state: result.state, reviewId: result.review.id });
  } catch (error) {
    if (error instanceof StaleEvidenceError) return NextResponse.json({ error: error.message, conflict: error.conflict }, { status: 409 });
    return errorResponse(error);
  }
}
