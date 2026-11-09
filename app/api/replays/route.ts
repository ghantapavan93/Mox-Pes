import { NextResponse } from "next/server";
import { z } from "zod";
import { mapperVersions } from "@/lib/adapters/registry";
import { ActionError } from "@/lib/actions";
import { afterResponse, errorResponse } from "@/lib/http";
import { dispatchEvents } from "@/lib/events/consumers";
import { replay } from "@/lib/ingest/replay";
import { planReplay } from "@/lib/ingest/replay-plan";
import { PERIODS } from "@/lib/period";
import { getException } from "@/lib/queries";
import { businessNow, getPool, getViewer } from "@/lib/server";
import { ForbiddenError, canSeeBranch } from "@/lib/viewer";

const body = z.object({
  exceptionId: z.number().int().positive(),
  mapperVersion: z.string().min(1),
  dryRun: z.boolean(),
  idempotencyKey: z.string().min(8).max(100),
});

/**
 * POST /api/replays — replay the records behind one exception through a mapper version: a
 * quarantine group (held records) or a channel coverage gap (records re-mapped).
 * Integration engineers only; the exception must be in the caller's branch scope.
 * Repeating a request with the same idempotencyKey returns the stored result.
 */
export async function POST(request: Request) {
  try {
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    if (!viewer.can.replay) throw new ForbiddenError(`${viewer.label} cannot replay source records`);
    const pool = getPool();
    const exception = await getException(pool, input.exceptionId);
    if (!exception || !canSeeBranch(viewer, exception.branchId)) throw new ActionError("Exception not found", 404);
    const source = exception.kind === "channel_coverage_gap" ? "ads" : exception.evidence.source;
    if (typeof source !== "string" || !mapperVersions(source as never).includes(input.mapperVersion)) {
      throw new ActionError(`No mapper ${String(source)}@${input.mapperVersion}`, 400);
    }

    const plan = await planReplay(pool, exception, input.mapperVersion);
    const result = await replay(pool, {
      ...plan,
      mapperVersion: input.mapperVersion,
      actor: viewer.role,
      idempotencyKey: input.idempotencyKey,
      dryRun: input.dryRun,
      now: await businessNow(),
      exceptionId: exception.id,
      scope: { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: exception.branchId ? [exception.branchId] : null },
    });
    console.log(JSON.stringify({ level: "info", msg: "replay", exceptionId: exception.id, mode: plan.mode, dryRun: input.dryRun, claimed: result.claimed, projected: result.projected, alreadyProcessed: result.alreadyProcessed }));
    // The replay published intake.records_reprojected; reconciliation already ran inside it,
    // so only identity has catching up to do.
    if (!result.dryRun && !result.alreadyProcessed && result.projected > 0) {
      afterResponse("event dispatch", () => dispatchEvents(pool));
    }
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
