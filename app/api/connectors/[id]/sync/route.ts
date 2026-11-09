import { NextResponse, after, connection } from "next/server";
import { z } from "zod";
import { CRM_ENTITIES } from "@/lib/connectors/types";
import { errorResponse } from "@/lib/http";
import { drainJobs } from "@/lib/jobs/kick";
import { enqueueSync } from "@/lib/jobs/sync";
import { businessNow, getPool, getViewer } from "@/lib/server";
import { requirePermission, resolveScope } from "@/lib/viewer";

const params = z.object({ id: z.coerce.number().int().positive() });
const body = z.object({
  /** Omitted or empty = every office the connector syncs (within the caller's scope). */
  officeIds: z.array(z.number().int().positive()).max(500).optional(),
  entities: z.array(z.enum(CRM_ENTITIES)).max(CRM_ENTITIES.length).optional(),
  idempotencyKey: z.string().min(8).max(100),
});

/**
 * POST /api/connectors/:id/sync — queue one job per office × entity and return at once. The
 * work runs after the response (after()), never inside this request; `npm run worker` runs the
 * same queue. Requires the `sync` permission; offices outside the caller's scope are refused.
 */
export async function POST(request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    const { id } = params.parse(await ctx.params);
    const input = body.parse(await request.json());
    const viewer = await getViewer();
    requirePermission(viewer, "sync", "start a CRM sync");
    const pool = getPool();
    const result = await enqueueSync(pool, {
      connectorId: id,
      officeIds: input.officeIds ?? null,
      entities: input.entities ?? null,
      idempotencyKey: input.idempotencyKey,
      actor: viewer.role,
      scope: resolveScope(viewer),
      now: new Date(),
      auditAt: await businessNow(),
    });
    if (result.created.length > 0) after(() => drainJobs(pool));
    console.log(JSON.stringify({ level: "info", msg: "sync requested", connectorId: id, created: result.created.length, reused: result.reusedQueued.length, alreadyRequested: result.alreadyRequested }));
    return NextResponse.json({
      requestKey: result.requestKey,
      alreadyRequested: result.alreadyRequested,
      created: result.created.length,
      reusedQueued: result.reusedQueued.length,
      jobIds: result.jobs.map((j) => j.id),
    }, { status: result.alreadyRequested ? 200 : 202 });
  } catch (error) {
    return errorResponse(error);
  }
}
