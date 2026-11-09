import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { decisionVerdicts, defaultDecisionBranch } from "@/lib/decision/verdicts";
import { errorResponse } from "@/lib/http";
import { PERIODS } from "@/lib/period";
import { getPool, getViewer } from "@/lib/server";

const query = z.object({
  branch: z.string().regex(/^B\d{2}$/).optional(),
  period: z.enum(["oct", "sep", "all"]).default("oct"),
});

/**
 * GET /api/decisions/verdicts?branch=B09&period=oct — the three separate verdicts (data
 * integrity, decision readiness, business effectiveness) for every paid channel at one branch.
 * Read-only; branch scope is enforced (a partner asking for another branch gets 403).
 */
export async function GET(request: Request) {
  await connection();
  try {
    const url = new URL(request.url);
    const viewer = await getViewer();
    const q = query.parse({ branch: url.searchParams.get("branch") ?? undefined, period: url.searchParams.get("period") ?? undefined });
    const verdicts = await decisionVerdicts(getPool(), viewer, { branchId: q.branch ?? defaultDecisionBranch(viewer), period: PERIODS[q.period] });
    return NextResponse.json(verdicts);
  } catch (error) {
    return errorResponse(error);
  }
}
