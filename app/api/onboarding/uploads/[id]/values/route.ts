import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { errorResponse, readJsonBody } from "@/lib/http";
import { getUpload } from "@/lib/onboarding/service";
import { parseRecordId } from "@/lib/record-id";
import { businessNow, getPool, getViewer } from "@/lib/server";

const body = z.object({
  dataset: z.enum(["calls", "web_leads", "crm_payments", "ad_spend"]),
  columns: z.record(z.string().max(60), z.string().max(200).nullable()),
});

/**
 * POST /api/onboarding/uploads/:id/values — the distinct values of the columns a DRAFT maps to
 * status, source and branch fields, with the translations offered for each. Read only.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    const id = parseRecordId((await ctx.params).id);
    if (id === null) throw new ActionError("Upload not found", 404);
    const draft = body.parse(await readJsonBody(request, 64 * 1024));
    const detail = await getUpload(getPool(), await getViewer(), id, await businessNow(), draft);
    return NextResponse.json({ values: detail.values });
  } catch (error) {
    return errorResponse(error);
  }
}
