import "server-only";
import { cookies } from "next/headers";
import { getNow, getPool } from "@/lib/db";
import { ROLE_COOKIE, viewerFromRole, type Viewer } from "@/lib/viewer";

/** Request-scoped helpers for server components and route handlers. */

export async function getViewer(): Promise<Viewer> {
  const jar = await cookies();
  return viewerFromRole(jar.get(ROLE_COOKIE)?.value);
}

export async function businessNow(): Promise<Date> {
  return getNow(getPool());
}

export { getPool };
