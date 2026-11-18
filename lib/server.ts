import "server-only";
import { cookies } from "next/headers";
import { connection } from "next/server";
import { getNow, getPool } from "@/lib/db";
import { demoModeEnabled } from "@/lib/demo-mode";
import { ROLE_COOKIE, viewerFromRole, workspaceViewer, type Viewer } from "@/lib/viewer";
import { VISITOR_COOKIE, newVisitorToken, subjectOf } from "@/lib/workspace";

/** Request-scoped helpers for server components and route handlers. */

/** The visitor workspace is on for this deployment (release design §5.1). Default off. */
export function workspaceEnabled(env: Record<string, string | undefined> = process.env): boolean {
  return env.PUBLIC_WORKSPACE === "1";
}

/**
 * Who is asking, in this order (release design §5.1):
 * 1. demo mode on: the role the `rs_role` cookie names, else the guest; demo mode off: the guest;
 * 2. the guest, with PUBLIC_WORKSPACE=1: the workspace guest, owner from the `rs_visitor` cookie;
 * 3. otherwise the role as resolved. Staff roles never get the workspace.
 * It only reads cookies; only the handlers that start a workspace item set one.
 */
export async function getViewer(): Promise<Viewer> {
  // Read the request before anything else, demo mode or not. The viewer is request-scoped by
  // definition. If the demo-mode check came first, a build without DEMO_MODE (the normal case:
  // the flag is given to `next start`, not `next build`) would never touch a request API here.
  // Next would then prerender the viewer into every page's static shell as the guest, while
  // the request-time payload names the real role. That text mismatch was React error #418 on
  // every page for any non-guest role (R-20).
  const jar = await cookies();
  // A request-time prerender (the session App Shell that cacheComponents with partialPrefetching
  // builds for a route that reads cookies) never passes connection(), so it stops here, before any
  // database read; the dynamic render passes at once. Without it, every document request ran every
  // read twice and threw the prerender's results away (docs/agent-work/release/measurements/steps.md).
  await connection();
  // Outside demo mode the role cookie is not trusted: everyone is a read-only guest.
  const viewer = demoModeEnabled() ? viewerFromRole(jar.get(ROLE_COOKIE)?.value) : viewerFromRole(undefined);
  if (viewer.role === "guest" && workspaceEnabled()) return workspaceViewer(subjectOf(jar.get(VISITOR_COOKIE)?.value));
  return viewer;
}

export interface VisitorCookie {
  name: string;
  value: string;
  httpOnly: true;
  sameSite: "lax";
  secure: boolean;
  path: "/";
  maxAge: number;
}

/**
 * For the two handlers that start a workspace item (POST /api/onboarding/uploads, POST
 * /api/investigations): the viewer, and the cookie to set. A workspace guest without a valid token
 * gets a new one, so the item is stored under a real owner, never "demo:guest"; one with a token gets
 * the same token re-sent with a fresh Max-Age, so the cookie outlives its newest item. `secure`
 * follows the request's scheme, as the role cookie does (app/api/role/route.ts).
 */
export async function viewerForWorkspaceStart(request: Request): Promise<{ viewer: Viewer; setCookie: VisitorCookie | null }> {
  const viewer = await getViewer();
  if (!viewer.can.workspace) return { viewer, setCookie: null };
  const jar = await cookies();
  const existing = jar.get(VISITOR_COOKIE)?.value;
  const token = subjectOf(existing) ? existing! : newVisitorToken();
  const tls = new URL(request.url).protocol === "https:" || request.headers.get("x-forwarded-proto") === "https";
  return {
    viewer: workspaceViewer(subjectOf(token)),
    setCookie: { name: VISITOR_COOKIE, value: token, httpOnly: true, sameSite: "lax", secure: tls, path: "/", maxAge: 86_400 },
  };
}

export async function businessNow(): Promise<Date> {
  return getNow(getPool());
}

export { getPool };
