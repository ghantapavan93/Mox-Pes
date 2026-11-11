import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { decideChange, DecisionSchema, getChange, monitorChange, releaseChange, rerunPreflight } from "@/lib/changeguard/service";
import { errorResponse } from "@/lib/http";
import { parseRecordId } from "@/lib/record-id";
import { getPool, getViewer } from "@/lib/server";

const body = z.discriminatedUnion("action", [
  z.strictObject({ action: z.literal("preflight") }),
  DecisionSchema.extend({ action: z.literal("decide") }),
  z.strictObject({ action: z.literal("release") }),
  z.strictObject({ action: z.literal("monitor") }),
]);

async function idOf(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  const id = parseRecordId((await ctx.params).id);
  if (id === null) throw new ActionError("Change not found", 404);
  return id;
}

/** GET /api/changes/:id — one change with its preflight, approval binding, verification and history. */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    return NextResponse.json(await getChange(getPool(), await getViewer(), await idOf(ctx)));
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/changes/:id — move a change forward:
 *   preflight (re-run) · decide (approve/reject; a different person; bound to the reviewed
 *   configHash and preflightHash) · release (approved only; re-checks the bindings under a row
 *   lock, applies inside the synthetic environment, verifies) · monitor (post-release checks).
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const id = await idOf(ctx);
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    const pool = getPool();
    switch (input.action) {
      case "preflight":
        return NextResponse.json({ change: await rerunPreflight(pool, viewer, id) });
      case "decide":
        return NextResponse.json({
          change: await decideChange(pool, viewer, id, { decision: input.decision, reason: input.reason, configHash: input.configHash, preflightHash: input.preflightHash }),
        });
      case "release":
        return NextResponse.json({ change: await releaseChange(pool, viewer, id) });
      case "monitor":
        return NextResponse.json({ change: await monitorChange(pool, viewer, id) });
    }
  } catch (error) {
    return errorResponse(error);
  }
}
