import "server-only";
import { cookies } from "next/headers";
import { getNow, getPool } from "@/lib/db";
import { demoModeEnabled } from "@/lib/demo-mode";
import { ROLE_COOKIE, viewerFromRole, type Viewer } from "@/lib/viewer";

/** Request-scoped helpers for server components and route handlers. */

export async function getViewer(): Promise<Viewer> {
  // Outside demo mode the role cookie is not trusted: everyone is a read-only guest.
  if (!demoModeEnabled()) return viewerFromRole(undefined);
  const jar = await cookies();
  return viewerFromRole(jar.get(ROLE_COOKIE)?.value);
}

export async function businessNow(): Promise<Date> {
  return getNow(getPool());
}

export { getPool };
