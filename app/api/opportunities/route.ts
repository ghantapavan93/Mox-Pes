import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { errorResponse } from "@/lib/http";
import { journeyFor, listOverrides, OverrideRequestSchema, recordOverride } from "@/lib/opportunities/overrides";
import { getPool, getViewer } from "@/lib/server";

const query = z.object({
  journey: z.enum(["missed_follow_up", "retention"]),
  period: z.enum(["oct", "sep", "all"]).default("all"),
  branch: z.string().regex(/^B\d{2}$/).nullable().default(null),
});

/**
 * GET /api/opportunities?journey=missed_follow_up&period=all[&branch=B09] — one journey brief
 * for the caller's scope (facts, inferences, hypothesis, recommendation, measured outcome,
 * readiness) and its recorded overrides. Read-only.
 */
export async function GET(request: Request) {
  await connection();
  try {
    const url = new URL(request.url);
    const q = query.parse({ journey: url.searchParams.get("journey"), period: url.searchParams.get("period") ?? undefined, branch: url.searchParams.get("branch") });
    const viewer = await getViewer();
    const pool = getPool();
    const brief = await journeyFor(pool, viewer, q.journey, q.period, q.branch);
    return NextResponse.json({ brief, overrides: await listOverrides(pool, q.journey, q.period, brief.scope) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/opportunities — record a readiness override: { journey, period, branch, to, reason }.
 * The approve permission, a reason and a one-level step are required; stale data and open
 * data-quality blockers can never be overridden. Recomputed server-side and audited.
 */
export async function POST(request: Request) {
  try {
    const input = OverrideRequestSchema.parse(await request.json());
    const viewer = await getViewer();
    const result = await recordOverride(getPool(), viewer, input);
    console.log(JSON.stringify({ level: "info", msg: "readiness override recorded", id: result.override.id, journey: input.journey, from: result.override.assessedLevel, to: result.override.overrideLevel, actor: viewer.role }));
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
