import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { errorResponse, readJsonBody } from "@/lib/http";
import { decideMapping } from "@/lib/onboarding/service";
import { parseRecordId } from "@/lib/record-id";
import { businessNow, getPool, getViewer } from "@/lib/server";

const body = z.object({ decision: z.enum(["approve", "reject"]), reason: z.string().trim().min(5).max(1000) });

/** POST /api/onboarding/mappings/:id/decision — approver only, never the proposing role. */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    const id = parseRecordId((await ctx.params).id);
    if (id === null) throw new ActionError("Mapping not found", 404);
    const input = body.parse(await readJsonBody(request, 8 * 1024));
    return NextResponse.json(await decideMapping(getPool(), { viewer: await getViewer(), mappingId: id, ...input, now: await businessNow() }));
  } catch (error) {
    return errorResponse(error);
  }
}
