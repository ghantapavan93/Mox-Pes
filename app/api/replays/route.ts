import { NextResponse } from "next/server";
import { z } from "zod";
import { mapperVersions } from "@/lib/adapters/registry";
import { ActionError } from "@/lib/actions";
import { errorResponse } from "@/lib/http";
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
 *
 * DRY RUNS ONLY. Changing stored records goes through the Action Center (propose → dry run →
 * approve, by another role → the application executes once). This route used to commit too,
 * which let an engineer skip approval (audit 2026-11-09, J1); a commit is now refused with 409.
 */
export async function POST(request: Request) {
  try {
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    if (!viewer.can.replay) throw new ForbiddenError(`${viewer.label} cannot replay source records`);
    if (!input.dryRun) {
      throw new ActionError("Commits go through the Action Center: propose the fix, dry-run it, and an approver in another role approves before the application executes it.", 409);
    }
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
      dryRun: true,
      now: await businessNow(),
      exceptionId: exception.id,
      scope: { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: exception.branchId ? [exception.branchId] : null },
    });
    console.log(JSON.stringify({ level: "info", msg: "replay", exceptionId: exception.id, mode: plan.mode, dryRun: input.dryRun, claimed: result.claimed, projected: result.projected, alreadyProcessed: result.alreadyProcessed }));
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
