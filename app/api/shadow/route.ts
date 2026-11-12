import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { listShadowChecks, parseShadowInput, runShadowCheck } from "@/lib/shadow/store";
import { businessNow, getPool, getViewer } from "@/lib/server";

/** GET /api/shadow — the checks of other systems' figures and answers the viewer may see. */
export async function GET() {
  try {
    const viewer = await getViewer();
    return NextResponse.json({ checks: await listShadowChecks(getPool(), viewer) });
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/shadow — check another system's metric snapshot ({ kind: "snapshot", input }) or
 * conversational answer ({ kind: "answer", input }) against the product's evidence, and record
 * the check. Reads only, apart from the record and its audit row. Scope and permission are
 * checked on the server (docs/agent-work/SHADOW-MODE.md).
 */
export async function POST(request: Request) {
  try {
    const input = parseShadowInput(await request.json());
    const viewer = await getViewer();
    const check = await runShadowCheck(getPool(), viewer, input, await businessNow());
    return NextResponse.json({ check }, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
