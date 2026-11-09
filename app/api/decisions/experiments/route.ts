import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { AA_DEFAULTS, AaRequestSchema, listExperiments, recordAaExperiment, runAaExperiment } from "@/lib/decision/experiment";
import { errorResponse } from "@/lib/http";
import { getPool, getViewer } from "@/lib/server";

const liveQuery = z.object({
  period: z.enum(["oct", "sep", "all"]).default("oct"),
  windowDays: z.coerce.number().int().min(1).max(60).default(AA_DEFAULTS.windowDays),
  salt: z.string().trim().min(1).max(60).default(AA_DEFAULTS.salt),
});

/**
 * GET /api/decisions/experiments?period=oct — stored experiment runs the caller may see, plus the
 * A/A analysis computed live over the caller's branch scope (nothing is stored by a GET).
 */
export async function GET(request: Request) {
  await connection();
  try {
    const url = new URL(request.url);
    const q = liveQuery.parse({
      period: url.searchParams.get("period") ?? undefined,
      windowDays: url.searchParams.get("windowDays") ?? undefined,
      salt: url.searchParams.get("salt") ?? undefined,
    });
    const viewer = await getViewer();
    const pool = getPool();
    const [live, stored] = await Promise.all([runAaExperiment(pool, viewer, q), listExperiments(pool, viewer)]);
    return NextResponse.json({ live, experiments: stored });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/decisions/experiments — run the A/A analysis over the caller's scope and store its
 * config and result (audited). Requires the investigate permission.
 */
export async function POST(request: Request) {
  try {
    const input = AaRequestSchema.parse(await request.json());
    const viewer = await getViewer();
    const stored = await recordAaExperiment(getPool(), viewer, input);
    console.log(JSON.stringify({ level: "info", msg: "experiment recorded", id: stored.id, status: stored.status, actor: viewer.role }));
    return NextResponse.json(stored, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
