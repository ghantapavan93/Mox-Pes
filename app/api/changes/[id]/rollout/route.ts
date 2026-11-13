import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { DEFAULT_DATABASE_URL } from "@/lib/db";
import { afterResponse, errorResponse } from "@/lib/http";
import { parseRecordId } from "@/lib/record-id";
import { getPool, getViewer } from "@/lib/server";
import { superviseEvaluation } from "@/lib/twin/runner";
import { abandonEvaluation, assertCanSeeEvaluations, createEvaluation, evaluationsForPage, getEvaluation, isStale, reopenEvaluation } from "@/lib/twin/store";
import { codeFingerprint, databaseName } from "@/lib/twin/world";
import { ForbiddenError } from "@/lib/viewer";

/**
 * Reliability Twin evaluations of a change (lib/twin/*): a SIMULATED staged rollout in an
 * isolated copy of the synthetic world. Starting one activates nothing and deploys nothing.
 *
 *   GET  /api/changes/:id/rollout                  the change's evaluations, newest first
 *   POST /api/changes/:id/rollout {variant}        start one; it runs after the response
 *   POST /api/changes/:id/rollout {resume: evId}   resume one whose runner stopped responding, or
 *                                                  one that ended in an error (same code, twin kept)
 *   POST /api/changes/:id/rollout {abandon: evId}  end a running one that is not finishing
 */

const body = z.union([
  z.strictObject({ variant: z.string().max(40) }),
  z.strictObject({ resume: z.number().int().positive() }),
  z.strictObject({ abandon: z.number().int().positive() }),
]);

/** One runner per evaluation in this server process. */
const running = ((globalThis as unknown as { __rsTwinRuns?: Set<number> }).__rsTwinRuns ??= new Set<number>());

function start(id: number) {
  if (running.has(id)) return;
  running.add(id);
  const url = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
  afterResponse(`rollout evaluation ${id}`, () =>
    superviseEvaluation(url, id, { mainUrl: url, interruptions: true, log: (line) => console.log(JSON.stringify({ level: "info", msg: "twin", evaluationId: id, simulated: true, line })) })
      .catch((error) => console.error(JSON.stringify({ level: "error", msg: "twin evaluation failed", evaluationId: id, error: (error as Error).message })))
      .finally(() => running.delete(id)),
  );
}

async function idOf(ctx: { params: Promise<{ id: string }> }): Promise<number> {
  const id = parseRecordId((await ctx.params).id);
  if (id === null) throw new ActionError("Change not found", 404);
  return id;
}

export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    const evaluations = await evaluationsForPage(getPool(), await getViewer(), await idOf(ctx), codeFingerprint());
    return NextResponse.json({ evaluations: evaluations.map((e) => ({ ...e, stale: e.stale && !running.has(e.id) })) });
  } catch (error) {
    return errorResponse(error);
  }
}

export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  try {
    const changeId = await idOf(ctx);
    const viewer = await getViewer();
    const input = body.parse(await request.json());
    const pool = getPool();
    if ("abandon" in input) {
      await abandonEvaluation(pool, viewer, { changeId, evaluationId: input.abandon, now: new Date() });
      return NextResponse.json({ evaluationId: input.abandon, abandoned: true });
    }
    if ("resume" in input) {
      if (!viewer.can.propose) throw new ForbiddenError(`${viewer.label} cannot resume a rollout evaluation`);
      assertCanSeeEvaluations(viewer);
      const ev = await getEvaluation(pool, input.resume);
      if (!ev || ev.changeId !== changeId) throw new ActionError("Evaluation not found", 404);
      if (ev.status === "ERROR") {
        await reopenEvaluation(pool, viewer, { changeId, evaluationId: ev.id, currentCode: codeFingerprint(), now: new Date() });
      } else if (ev.status !== "RUNNING") {
        throw new ActionError(`Evaluation ${ev.id} is ${ev.status}; it has a verdict and cannot be resumed`, 409);
      } else if (running.has(ev.id) || !isStale(ev, Date.now())) {
        // The lease decides across processes; this is the friendly early answer.
        throw new ActionError("Its runner is still reporting; wait for it, or abandon it if it is not progressing", 409);
      }
      start(ev.id);
      return NextResponse.json({ evaluationId: ev.id, resumed: true }, { status: 202 });
    }
    const id = await createEvaluation(pool, viewer, { changeId, variant: input.variant, controlDatabase: databaseName(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL), now: new Date() });
    start(id);
    return NextResponse.json({ evaluationId: id }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
