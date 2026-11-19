import { NextResponse } from "next/server";
import { B20_TOUR, TOUR_BRANCH, tourHref } from "@/lib/demo/b20-tour";
import { repairedTourIncident } from "@/lib/demo/tour-incident";
import { getPool, getViewer } from "@/lib/server";
import { canSeeBranch } from "@/lib/viewer";

/**
 * GET /demo/tour: the visitor tour's first step, on the incident it walks. A link that needs no id,
 * so the Start page stays static (no database read before its first paint). Without a repaired
 * incident, or for a viewer who may not see the tour's branch, it goes to /demo, which says why.
 * It reads the viewer (cookies), so it always runs at request time.
 */
export async function GET(request: Request) {
  const viewer = await getViewer();
  const incident = canSeeBranch(viewer, TOUR_BRANCH) ? await repairedTourIncident(getPool()) : null;
  return NextResponse.redirect(new URL(incident ? tourHref(B20_TOUR[0], incident.id) : "/demo", request.url), 307);
}
