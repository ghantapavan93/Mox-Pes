import { NextResponse, connection } from "next/server";
import { ActionError } from "@/lib/actions";
import { errorResponse } from "@/lib/http";
import { getCustomerJourney, getJourneyRawEvent, getProspectJourney, parseJourneyRef } from "@/lib/identity";
import { getPool, getViewer } from "@/lib/server";

/**
 * GET /api/customers/:id/raw-events/:rawEventId — the stored source payload behind one timeline
 * item, with its mapper version and every stored version of the same source record. Payloads
 * are redacted at ingest (contact details are hash tokens). Served only when the raw event is a
 * version of a record in this customer's journey, so the journey's branch scope covers it.
 */
export async function GET(_request: Request, ctx: { params: Promise<{ id: string; rawEventId: string }> }) {
  // Outside try: during prerendering connection() rejects by design, and that must not be logged as a route error.
  await connection();
  try {
    const { id, rawEventId } = await ctx.params;
    const ref = parseJourneyRef(id);
    if (!ref || !/^\d{1,15}$/.test(rawEventId)) throw new ActionError("Not found", 404);
    const viewer = await getViewer();
    const pool = getPool();
    const journey =
      ref.kind === "customer"
        ? await getCustomerJourney(pool, ref.crmCustomerId, viewer.branchIds)
        : await getProspectJourney(pool, ref.identityId, viewer.branchIds);
    if (!journey) throw new ActionError("Customer not found", 404);
    const raw = await getJourneyRawEvent(pool, journey, Number(rawEventId));
    if (!raw) throw new ActionError("That raw event is not part of this customer's journey", 404);
    return NextResponse.json(raw);
  } catch (error) {
    return errorResponse(error);
  }
}
