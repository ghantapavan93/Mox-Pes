import { NextResponse, connection } from "next/server";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { getConnector } from "@/lib/connectors/config";
import { compareRecord, recordAdHocCalls } from "@/lib/connectors/studio";
import { CRM_ENTITIES, type ApiCallRecord } from "@/lib/connectors/types";
import { errorResponse } from "@/lib/http";
import { connectorClient } from "@/lib/jobs/runtime";
import { getPool, getViewer } from "@/lib/server";
import { requirePermission, resolveScope } from "@/lib/viewer";

const params = z.object({ id: z.coerce.number().int().positive() });
const query = z.object({
  entity: z.enum(CRM_ENTITIES),
  recordId: z.coerce.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  officeId: z.coerce.number().int().positive().optional(),
});

/**
 * GET /api/connectors/:id/compare?entity=&recordId=[&officeId=] — the record as the source has
 * it now (fetched through the connector over HTTP, redacted), as the deployed mapper would
 * project it, and as stored. Requires `sync`: each compare spends the office's API read budget.
 */
export async function GET(request: Request, ctx: { params: Promise<{ id: string }> }) {
  await connection();
  try {
    const { id } = params.parse(await ctx.params);
    const url = new URL(request.url);
    const q = query.parse(Object.fromEntries(url.searchParams));
    const viewer = await getViewer();
    requirePermission(viewer, "sync", "fetch records from the CRM");
    const pool = getPool();
    const connector = await getConnector(pool, id);
    if (!connector) throw new ActionError(`Connector ${id} not found`, 404);
    const calls: ApiCallRecord[] = [];
    const client = connectorClient(connector, (c) => calls.push(c));
    const result = await compareRecord(pool, { connector: client, entity: q.entity, recordId: q.recordId, officeId: q.officeId ?? null, scope: resolveScope(viewer) });
    await recordAdHocCalls(pool, connector.id, calls);
    if (!result) throw new ActionError(`No ${q.entity} ${q.recordId} in your scope — give its office when it has not been synced yet`, 404);
    return NextResponse.json(result, { headers: { "cache-control": "no-store" } });
  } catch (error) {
    return errorResponse(error);
  }
}
