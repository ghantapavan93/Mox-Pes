import { NextResponse, connection } from "next/server";
import { ActionError } from "@/lib/actions";
import { errorResponse } from "@/lib/http";
import { getCustomerJourney, getProspectJourney, parseJourneyRef } from "@/lib/identity";
import { getPool, getViewer } from "@/lib/server";

/**
 * GET /api/customers/:id — the full journey of one CRM customer (`:id` = CRM customer id) or
 * prospect (`:id` = P-<identityId>): identity links, every source record, money and a single
 * chronological timeline with source references. Unknown or outside the viewer's branches → the
 * same 404, so a branch-scoped viewer learns nothing about other branches' ids.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string }> }) {
  // Outside try: during prerendering connection() rejects by design, and that must not be logged as a route error.
  await connection();
  try {
    const { id } = await ctx.params;
    const ref = parseJourneyRef(id);
    if (!ref) throw new ActionError("Customer not found", 404);
    const viewer = await getViewer();
    const pool = getPool();
    const journey =
      ref.kind === "customer"
        ? await getCustomerJourney(pool, ref.crmCustomerId, viewer.branchIds)
        : await getProspectJourney(pool, ref.identityId, viewer.branchIds);
    if (!journey) throw new ActionError("Customer not found", 404);
    return NextResponse.json(journey);
  } catch (error) {
    return errorResponse(error);
  }
}
