import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { getConnector } from "@/lib/connectors/config";
import { connectorHealth, listJobs } from "@/lib/connectors/studio";
import { toJobView } from "@/lib/connectors/views";
import { ActionError } from "@/lib/actions";
import { errorResponse } from "@/lib/http";
import { businessNow, getPool, getViewer } from "@/lib/server";
import { resolveScope } from "@/lib/viewer";

const params = z.object({ id: z.coerce.number().int().positive() });
const query = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(40),
  state: z.enum(["queued", "running", "succeeded", "failed", "cancelled"]).optional(),
});

/**
 * GET /api/connectors/:id/jobs — recent jobs and connector health, for the Studio's live table.
 * Read-only; rows are limited to offices in the caller's branch scope.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    const { id } = params.parse(await ctx.params);
    const url = new URL(request.url);
    const q = query.parse({ limit: url.searchParams.get("limit") ?? undefined, state: url.searchParams.get("state") ?? undefined });
    const viewer = await getViewer();
    const scope = resolveScope(viewer);
    const pool = getPool();
    const connector = await getConnector(pool, id);
    if (!connector) throw new ActionError(`Connector ${id} not found`, 404);
    const [jobs, health] = await Promise.all([
      listJobs(pool, { connectorId: id, scope, limit: q.limit, state: q.state ?? null }),
      connectorHealth(pool, connector, scope, await businessNow(), new Date()),
    ]);
    return NextResponse.json({ jobs: jobs.map(toJobView), health }, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
