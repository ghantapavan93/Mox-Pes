import { NextResponse, after, connection } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { getJobDetail } from "@/lib/connectors/studio";
import { toJobView } from "@/lib/connectors/views";
import { errorResponse } from "@/lib/http";
import { drainJobs } from "@/lib/jobs/kick";
import { cancelJob, retryJob } from "@/lib/jobs/sync";
import { businessNow, getPool, getViewer } from "@/lib/server";
import { requirePermission, resolveScope } from "@/lib/viewer";

const params = z.object({ jobId: z.coerce.number().int().positive() });
const body = z.discriminatedUnion("action", [
  z.object({ action: z.literal("cancel") }),
  z.object({ action: z.literal("retry"), idempotencyKey: z.string().min(8).max(100) }),
]);

/** GET /api/connectors/jobs/:jobId — one job with its API call trace (scoped read). */
export async function GET(_request: Request, ctx: { params: Promise<{ jobId: string }> }) {
  await connection();
  try {
    const { jobId } = params.parse(await ctx.params);
    const viewer = await getViewer();
    const detail = await getJobDetail(getPool(), jobId, resolveScope(viewer));
    if (!detail) throw new ActionError(`Job ${jobId} not found`, 404);
    return NextResponse.json(
      { job: toJobView({ ...detail.job, branchId: detail.branchId }), calls: detail.calls, retries: detail.retries },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    return errorResponse(error);
  }
}

/**
 * POST /api/connectors/jobs/:jobId — `{action: "cancel"}` or `{action: "retry", idempotencyKey}`.
 * Requires the `sync` permission. A retry is a new job (the failed one stays as history) and is
 * picked up after the response.
 */
export async function POST(request: Request, ctx: { params: Promise<{ jobId: string }> }) {
  await connection();
  try {
    const { jobId } = params.parse(await ctx.params);
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    requirePermission(viewer, "sync", input.action === "cancel" ? "cancel sync jobs" : "retry sync jobs");
    const pool = getPool();
    const common = { jobId, actor: viewer.role, scope: resolveScope(viewer), now: new Date(), auditAt: await businessNow() };
    if (input.action === "cancel") {
      const job = await cancelJob(pool, common);
      return NextResponse.json({ jobId: job.id, state: job.state, cancelRequested: job.cancelRequested });
    }
    const job = await retryJob(pool, { ...common, idempotencyKey: input.idempotencyKey });
    after(() => drainJobs(pool));
    return NextResponse.json({ jobId: job.id, state: job.state, retryOf: job.retryOf }, { status: 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
