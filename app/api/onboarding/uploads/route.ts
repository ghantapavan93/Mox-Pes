import { NextResponse, connection } from "next/server";
import { errorResponse, readBodyBytes } from "@/lib/http";
import { onboardingAccess } from "@/lib/onboarding/access";
import { LIMITS, tooLargeMessage } from "@/lib/onboarding/limits";
import { listUploads, stageUpload, stageWorkspaceUpload } from "@/lib/onboarding/service";
import { businessNow, getPool, getViewer, viewerForWorkspaceStart, type VisitorCookie } from "@/lib/server";
import { WORKSPACE } from "@/lib/workspace";

/** Staging a 10,000-row workspace file on a cold database takes seconds, not minutes. */
export const maxDuration = 60;

/**
 * POST /api/onboarding/uploads — stage one file. The body is the file's bytes; the name comes
 * from the x-filename header (URL-encoded, display only). The body is read with a hard byte
 * limit, the viewer's own (4 MB for the visitor workspace), so an oversized upload is refused
 * (413) before it is held in memory, with the file's size when the client declared it.
 *
 * A staff role stages a company upload: 201, or 422 with the parser's reason. A workspace guest
 * stages into its own workspace (release design §5.2): 201; 200 with `repeatOf` when it already
 * holds this exact file; or the refusal with its own status (413, 422, 429, 503). Either way the
 * response sets or refreshes the guest's `rs_visitor` cookie, so the upload has a real owner.
 *
 * GET /api/onboarding/uploads — the 50 most recent uploads this viewer may see.
 */
export async function POST(request: Request) {
  await connection();
  let cookie: VisitorCookie | null = null;
  const respond = (response: NextResponse) => {
    if (cookie) response.cookies.set(cookie);
    return response;
  };
  try {
    const start = await viewerForWorkspaceStart(request);
    cookie = start.setCookie;
    const { viewer } = start;
    const workspace = onboardingAccess(viewer) === "workspace";
    const maxBytes = workspace ? WORKSPACE.maxBytes : LIMITS.maxUploadBytes;
    const bytes = await readBodyBytes(request, maxBytes, (declared) => tooLargeMessage(declared, maxBytes, workspace ? "workspace" : "company"));
    let filename = "upload";
    try {
      filename = decodeURIComponent(request.headers.get("x-filename") ?? "upload");
    } catch {
      filename = "upload";
    }
    const sheet = Number(request.headers.get("x-sheet-index") ?? "0");
    const args = { viewer, filename, bytes, sheetIndex: Number.isInteger(sheet) && sheet >= 0 && sheet < 50 ? sheet : 0, now: await businessNow() };
    if (workspace) {
      const result = await stageWorkspaceUpload(getPool(), args);
      if ("refused" in result) return respond(NextResponse.json(result, { status: result.refused.status }));
      return respond(NextResponse.json(result, { status: "repeatOf" in result ? 200 : 201 }));
    }
    const result = await stageUpload(getPool(), args);
    if ("refused" in result) return NextResponse.json(result, { status: 422 });
    return NextResponse.json(result, { status: 201 });
  } catch (error) {
    return respond(errorResponse(error));
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
