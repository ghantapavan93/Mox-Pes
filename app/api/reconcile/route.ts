import { NextResponse } from "next/server";
import { withTransaction } from "@/lib/db";
import { errorResponse } from "@/lib/http";
import { reconcile } from "@/lib/reconcile/reconcile";
import { businessNow, getPool, getViewer } from "@/lib/server";
import { ForbiddenError } from "@/lib/viewer";

/**
 * POST /api/reconcile — run all detectors now. Push ingestion does not reconcile inline;
 * in production this is a scheduled job (cron / Dagster sensor). Integration engineers only.
 */
export async function POST() {
  try {
    const viewer = await getViewer();
    if (!viewer.can.replay) throw new ForbiddenError(`${viewer.label} cannot run reconciliation`);
    const now = await businessNow();
    const result = await withTransaction(getPool(), (tx) => reconcile(tx, now));
    return NextResponse.json(result);
  } catch (error) {
    return errorResponse(error);
  }
}
