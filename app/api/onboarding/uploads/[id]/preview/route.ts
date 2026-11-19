import { NextResponse, connection } from "next/server";
import { ActionError } from "@/lib/actions";
import { errorResponse } from "@/lib/http";
import { previewUpload } from "@/lib/onboarding/service";
import { parseRecordId } from "@/lib/record-id";
import { businessNow, getPool, getViewer } from "@/lib/server";

/** Counting a file reads the dashboard twice and reconciles once, in one rolled-back transaction. */
export const maxDuration = 60;

/**
 * POST /api/onboarding/uploads/:id/preview — count the latest dry run's new rows in a private
 * copy (a transaction that is always rolled back) and keep the dashboard's figures before and
 * after on that dry run. Nothing reaches the shared ledger; only the upload's owner may ask
 * (lib/onboarding/service.ts, previewUpload). Answers 503 when another copy is being counted.
 */
export async function POST(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    const id = parseRecordId((await ctx.params).id);
    if (id === null) throw new ActionError("Upload not found", 404);
    return NextResponse.json(await previewUpload(getPool(), { viewer: await getViewer(), uploadId: id, now: await businessNow() }));
  } catch (error) {
    return errorResponse(error);
  }
}
