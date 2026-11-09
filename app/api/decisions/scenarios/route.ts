import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { ScenarioRequestSchema, listScenarios, saveScenario, scenario } from "@/lib/decision/scenario";
import { errorResponse } from "@/lib/http";
import { getPool, getViewer } from "@/lib/server";
import { ForbiddenError } from "@/lib/viewer";

const body = ScenarioRequestSchema.extend({
  /** false = compute and return only (no state change); true = also store it, audited. */
  save: z.boolean().default(false),
});

const listQuery = z.object({
  branch: z.string().regex(/^B\d{2}$/).optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

/**
 * POST /api/decisions/scenarios — model a budget shift at one branch. Requires the investigate
 * or propose permission and the branch in scope. The result is always labelled a forecast from
 * observational data; when readiness fails it still computes and carries the blockers.
 */
export async function POST(request: Request) {
  try {
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    if (!viewer.can.investigate && !viewer.can.propose) throw new ForbiddenError(`${viewer.label} cannot model budget scenarios`);
    const pool = getPool();
    const { save, ...scenarioRequest } = input;
    if (save) {
      const saved = await saveScenario(pool, viewer, scenarioRequest);
      console.log(JSON.stringify({ level: "info", msg: "scenario saved", id: saved.id, branchId: saved.branchId, decisionReady: saved.decisionReady, actor: viewer.role }));
      return NextResponse.json(saved, { status: 201 });
    }
    return NextResponse.json({ result: await scenario(pool, viewer, scenarioRequest) });
  } catch (error) {
    return errorResponse(error);
  }
}

/** GET /api/decisions/scenarios?branch=B09 — saved scenarios in the caller's scope, newest first. */
export async function GET(request: Request) {
  await connection();
  try {
    const url = new URL(request.url);
    const q = listQuery.parse({ branch: url.searchParams.get("branch") ?? undefined, limit: url.searchParams.get("limit") ?? undefined });
    const viewer = await getViewer();
    return NextResponse.json({ scenarios: await listScenarios(getPool(), viewer, { branchId: q.branch ?? null, limit: q.limit }) });
  } catch (error) {
    return errorResponse(error);
  }
}
