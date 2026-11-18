import { NextResponse, connection } from "next/server";
import { ActionError } from "@/lib/actions";
import { errorResponse } from "@/lib/http";
import { deleteUpload, getUpload } from "@/lib/onboarding/service";
import { parseRecordId } from "@/lib/record-id";
import { businessNow, getPool, getViewer } from "@/lib/server";

/** GET /api/onboarding/uploads/:id — profile, suggestions, mapping versions, latest dry run. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    const id = parseRecordId((await ctx.params).id);
    if (id === null) throw new ActionError("Upload not found", 404);
    return NextResponse.json(await getUpload(getPool(), await getViewer(), id, await businessNow()));
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * DELETE /api/onboarding/uploads/:id — a company upload: deletes the staged rows now (the summary
 * stays for audit). A workspace upload, for its owner: deletes everything ("Delete it now").
 */
export async function DELETE(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    const id = parseRecordId((await ctx.params).id);
    if (id === null) throw new ActionError("Upload not found", 404);
    await deleteUpload(getPool(), { viewer: await getViewer(), uploadId: id, now: await businessNow() });
    return NextResponse.json({ deleted: true });
  } catch (error) {
    return errorResponse(error);
  }
}
