import "server-only";
import { cookies } from "next/headers";
import { getNow, getPool } from "@/lib/db";
import { demoModeEnabled } from "@/lib/demo-mode";
import { ROLE_COOKIE, viewerFromRole, type Viewer } from "@/lib/viewer";

/** Request-scoped helpers for server components and route handlers. */

export async function getViewer(): Promise<Viewer> {
  // Read the request before anything else, demo mode or not. The viewer is request-scoped by
  // definition. If the demo-mode check came first, a build without DEMO_MODE (the normal case:
  // the flag is given to `next start`, not `next build`) would never touch a request API here.
  // Next would then prerender the viewer into every page's static shell as the guest, while
  // the request-time payload names the real role. That text mismatch was React error #418 on
  // every page for any non-guest role (R-20).
  const jar = await cookies();
  // Outside demo mode the role cookie is not trusted: everyone is a read-only guest.
  if (!demoModeEnabled()) return viewerFromRole(undefined);
  return viewerFromRole(jar.get(ROLE_COOKIE)?.value);
}

export async function businessNow(): Promise<Date> {
  return getNow(getPool());
}

export { getPool };
