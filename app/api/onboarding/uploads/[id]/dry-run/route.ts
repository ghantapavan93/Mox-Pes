import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { errorResponse, readJsonBody } from "@/lib/http";
import { runDryRun } from "@/lib/onboarding/service";
import { parseRecordId } from "@/lib/record-id";
import { businessNow, getPool, getViewer } from "@/lib/server";

const body = z.object({ mappingId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

/**
 * POST /api/onboarding/uploads/:id/dry-run — compile every row with the deployed mapper and
 * compare with the ledger. Writes only the dry-run record; the ledger is read, never changed.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    const id = parseRecordId((await ctx.params).id);
    if (id === null) throw new ActionError("Upload not found", 404);
    const { mappingId } = body.parse(await readJsonBody(request, 4 * 1024));
    return NextResponse.json(await runDryRun(getPool(), { viewer: await getViewer(), uploadId: id, mappingId, now: await businessNow() }));
  } catch (error) {
    return errorResponse(error);
  }
}
