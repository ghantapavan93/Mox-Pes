import { NextResponse, type NextRequest } from "next/server";

/**
 * Cross-site request refusal for state-changing API calls (defence in depth; security pass
 * 2026-11-11). The role cookie is SameSite=Lax, which already keeps it off cross-site POSTs in
 * current browsers; this also refuses a write whose Origin (or Fetch Metadata) says it came
 * from another site, whatever the cookie policy of the browser in use.
 *
 * Machine-to-machine routes are exempt: /api/ingest authenticates with a key, not a cookie,
 * and /api/mock is the demo vendor simulator.
 */
const SAFE = new Set(["GET", "HEAD", "OPTIONS"]);
const EXEMPT = /^\/api\/(ingest|mock)(\/|$)/;

export function isCrossSiteWrite(req: { method: string; pathname: string; origin: string | null; host: string | null; fetchSite: string | null }): boolean {
  if (SAFE.has(req.method.toUpperCase()) || EXEMPT.test(req.pathname)) return false;
  if (req.fetchSite === "cross-site") return true;
  if (req.origin === null || req.origin === "null") return req.origin === "null";
  try {
    return new URL(req.origin).host !== req.host;
  } catch {
    return true;
  }
}

export function proxy(request: NextRequest) {
  const crossSite = isCrossSiteWrite({
    method: request.method,
    pathname: request.nextUrl.pathname,
    origin: request.headers.get("origin"),
    // Behind a reverse proxy the public host is the forwarded one.
    host: request.headers.get("x-forwarded-host") ?? request.headers.get("host"),
    fetchSite: request.headers.get("sec-fetch-site"),
  });
  if (crossSite) return NextResponse.json({ error: "Cross-site request refused" }, { status: 403 });
  return NextResponse.next();
}

export const config = {
  matcher: "/api/:path*",
};
