import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { dispatchEvents } from "@/lib/events/consumers";
import { afterResponse, errorResponse, readJsonBody } from "@/lib/http";
import { publishUpload } from "@/lib/onboarding/service";
import { parseRecordId } from "@/lib/record-id";
import { businessNow, getPool, getViewer } from "@/lib/server";

/**
 * POST /api/onboarding/uploads/:id/publish { dryRunId } — approver only. dryRunId is the dry run
 * the approver reviewed; a newer one in the meantime is refused (409). Publishes the dry run's eligible
 * rows through intake (calls and web leads; payments and spend are reconcile-only). Intake
 * publishes intake.records_stored in the same transaction; identity resolution and
 * reconciliation pick it up after the response, as for any delivery.
 */
const body = z.object({ dryRunId: z.number().int().positive().max(Number.MAX_SAFE_INTEGER) });

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    const id = parseRecordId((await ctx.params).id);
    if (id === null) throw new ActionError("Upload not found", 404);
    const { dryRunId } = body.parse(await readJsonBody(request, 4 * 1024));
    const pool = getPool();
    const result = await publishUpload(pool, { viewer: await getViewer(), uploadId: id, dryRunId, now: await businessNow() });
    if (result.published > 0) afterResponse("event dispatch", () => dispatchEvents(pool));
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
