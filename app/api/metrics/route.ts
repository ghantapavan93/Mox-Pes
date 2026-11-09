import { NextResponse, connection } from "next/server";
import { errorResponse } from "@/lib/http";
import { branchRows, conversionBridge, totals } from "@/lib/metrics/scorecard";
import { parsePeriod } from "@/lib/period";
import { getPool, getViewer } from "@/lib/server";
import { resolveScope } from "@/lib/viewer";

/** GET /api/metrics?period=oct&branch=B20 — the scorecard as JSON, scoped to the caller. */
export async function GET(request: Request) {
  await connection();
  try {
    const url = new URL(request.url);
    const period = parsePeriod(url.searchParams.get("period") ?? undefined);
    const viewer = await getViewer();
    const branchIds = resolveScope(viewer, url.searchParams.get("branch"));
    const pool = getPool();
    const scope = { from: period.from, to: period.to, branchIds };
    const rows = await branchRows(pool, scope);
    const [t, bridge] = await Promise.all([totals(pool, scope, rows), conversionBridge(pool, scope)]);
    return NextResponse.json({ period: period.key, scope: branchIds ?? "all", totals: t, bridge, branches: rows });
  } catch (error) {
    return errorResponse(error);
  }
}
