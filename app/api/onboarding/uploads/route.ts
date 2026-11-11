import { NextResponse, connection } from "next/server";
import { errorResponse, readBodyBytes } from "@/lib/http";
import { LIMITS } from "@/lib/onboarding/limits";
import { listUploads, stageUpload } from "@/lib/onboarding/service";
import { businessNow, getPool, getViewer } from "@/lib/server";

/**
 * POST /api/onboarding/uploads — stage one file. The body is the file's bytes; the name comes
 * from the x-filename header (URL-encoded, display only). The body is read with a hard byte
 * limit, so an oversized upload is refused (413) before it is held in memory.
 * A file the parser refuses is answered 422 with the reason; nothing is staged.
 *
 * GET /api/onboarding/uploads — the 50 most recent uploads (proposer and approver roles).
 */
export async function POST(request: Request) {
  await connection();
  try {
    const viewer = await getViewer();
    const bytes = await readBodyBytes(request, LIMITS.maxUploadBytes);
    let filename = "upload";
    try {
      filename = decodeURIComponent(request.headers.get("x-filename") ?? "upload");
    } catch {
      filename = "upload";
    }
    const sheet = Number(request.headers.get("x-sheet-index") ?? "0");
    const result = await stageUpload(getPool(), { viewer, filename, bytes, sheetIndex: Number.isInteger(sheet) && sheet >= 0 && sheet < 50 ? sheet : 0, now: await businessNow() });
    if ("refused" in result) return NextResponse.json(result, { status: 422 });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function GET() {
  await connection();
  try {
    return NextResponse.json({ uploads: await listUploads(getPool(), await getViewer(), await businessNow()) });
  } catch (error) {
    return errorResponse(error);
  }
}
