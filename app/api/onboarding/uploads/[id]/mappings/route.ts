import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { errorResponse, readJsonBody } from "@/lib/http";
import { proposeMapping } from "@/lib/onboarding/service";
import { parseRecordId } from "@/lib/record-id";
import { businessNow, getPool, getViewer } from "@/lib/server";

const body = z.object({ spec: z.unknown() });

/**
 * POST /api/onboarding/uploads/:id/mappings — propose a mapping version for this export's
 * layout. Returns the version and any problems that would block a dry run. Identical rules
 * reuse the existing version instead of creating a new one.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    const id = parseRecordId((await ctx.params).id);
    if (id === null) throw new ActionError("Upload not found", 404);
    const { spec } = body.parse(await readJsonBody(request, 256 * 1024));
    return NextResponse.json(await proposeMapping(getPool(), { viewer: await getViewer(), uploadId: id, spec, now: await businessNow() }), { status: 201 });
  } catch (error) {
    return errorResponse(error);
  }
}
