import { NextResponse, connection } from "next/server";
import { errorResponse } from "@/lib/http";
import { compareTraces, traceBranchMetric, TRACEABLE, TraceError, type TraceableMetric } from "@/lib/lineage/trace";
import { PERIODS, parsePeriod, type PeriodKey } from "@/lib/period";
import { getPool, getViewer } from "@/lib/server";

/**
 * GET /api/metrics/trace?branch=B09&period=oct&metric=paid_cac[&compare=sep]
 *
 * Where a branch's number comes from: the records, mappings, definitions and exclusions behind
 * it, reproduced and checked against the scorecard (lib/lineage/trace.ts). Scoped to the caller
 * on the server; read-only.
 */
export async function GET(request: Request) {
  await connection();
  try {
    const url = new URL(request.url);
    const branchId = url.searchParams.get("branch") ?? "";
    const metric = (url.searchParams.get("metric") ?? "paid_cac") as TraceableMetric;
    if (!(TRACEABLE as readonly string[]).includes(metric)) return NextResponse.json({ error: `metric must be one of ${TRACEABLE.join(", ")}` }, { status: 400 });
    const period = parsePeriod(url.searchParams.get("period") ?? undefined);
    const compareKey = url.searchParams.get("compare");
    if (compareKey !== null && !Object.hasOwn(PERIODS, compareKey)) return NextResponse.json({ error: "compare must be a period key" }, { status: 400 });
    const viewer = await getViewer();
    const pool = getPool();
    const trace = await traceBranchMetric(pool, viewer, { branchId, period, metric });
    const comparison = compareKey ? compareTraces(await traceBranchMetric(pool, viewer, { branchId, period: PERIODS[compareKey as PeriodKey], metric }), trace) : null;
    return NextResponse.json({ trace, comparison });
  } catch (error) {
    if (error instanceof TraceError) return NextResponse.json({ error: error.message }, { status: error.status });
    return errorResponse(error);
  }
}
