import { NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { getShadowCheck } from "@/lib/shadow/store";
import { getPool, getViewer } from "@/lib/server";

/** GET /api/shadow/:id — one recorded check, or 404 when it does not exist or is outside the viewer's scope. */
export async function GET(_request: Request, { params }: { params: Promise<{ id: string }> }) {
  try {
    const { id } = await params;
    const n = Number(id);
    const viewer = await getViewer();
    const check = Number.isSafeInteger(n) && n > 0 ? await getShadowCheck(getPool(), viewer, n) : null;
    if (!check) return NextResponse.json({ error: "Check not found" }, { status: 404 });
    return NextResponse.json({ check });
  } catch (error) {
    return errorResponse(error);
  }
}
