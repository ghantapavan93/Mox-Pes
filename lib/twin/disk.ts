import { statfs } from "node:fs/promises";
import type { Queryable } from "@/lib/db";

/**
 * The disk preflight before a twin is cloned (R-49). A twin is a ~200 MB copy of the base world,
 * and a base rebuild needs about as much again. On 2026-11-12 the database server's drive filled
 * mid-run (714 MB free), Postgres could not extend a file, and every database on the server
 * failed, not only the twin. So, before anything is copied:
 *
 *   1. measure the free space on the volume that holds the server's data directory;
 *   2. if it is short, drop finished twins THIS control database owns (its evaluations that are
 *      no longer running, oldest first) until it is not; never the base, a running evaluation's
 *      twin, or any other database on the server;
 *   3. if it is still short, refuse with the numbers. Nothing was cloned.
 *
 * The measurement is fail-closed: a server this process cannot see (not on this machine, or its
 * data directory not readable) is refused, unless TWIN_SKIP_DISK_PREFLIGHT=1 says a person
 * accepts the risk.
 */

export class DiskPreflightError extends Error {}

/** Free space to keep beyond the copy itself: Postgres needs room for WAL and temporary files. */
export const DISK_HEADROOM_BYTES = Number(process.env.TWIN_DISK_HEADROOM_BYTES ?? 1024 ** 3);

const LOCAL_HOSTS = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);

export const formatBytes = (n: number) => (n >= 1024 ** 3 ? `${(n / 1024 ** 3).toFixed(1)} GB` : `${Math.round(n / 1024 ** 2)} MB`);

/** Free bytes on the volume of the database server's data directory, as this process sees it. */
export async function freeBytesOnServer(admin: Queryable, host: string): Promise<number> {
  if (!LOCAL_HOSTS.has(host)) {
    throw new DiskPreflightError(`The database server (${host}) is not on this machine, so its free disk space cannot be measured; refusing to clone. Set TWIN_SKIP_DISK_PREFLIGHT=1 to accept the risk.`);
  }
  let dir: string;
  try {
    dir = (await admin.query<{ d: string }>("select current_setting('data_directory') as d")).rows[0].d;
  } catch {
    throw new DiskPreflightError("The database server does not reveal its data directory to this role, so its free disk space cannot be measured; refusing to clone.");
  }
  const s = await statfs(dir);
  return Number(s.bavail) * Number(s.bsize);
}

export interface OwnedTwin {
  evaluationId: number;
  database: string;
}

export interface DiskCheck {
  freeBytes: number;
  needBytes: number;
  /** Finished twins of this control database dropped to make room, oldest first. */
  dropped: OwnedTwin[];
  skipped?: true;
}

/**
 * Makes room among the caller's own finished twins, then refuses if there is still not enough.
 * `ownFinished` must list ONLY twins the caller owns and no longer runs; `drop` removes one.
 */
export async function diskPreflight(deps: {
  needBytes: number;
  measure: () => Promise<number>;
  ownFinished: OwnedTwin[];
  drop: (twin: OwnedTwin) => Promise<void>;
}): Promise<DiskCheck> {
  if (process.env.TWIN_SKIP_DISK_PREFLIGHT === "1") return { freeBytes: -1, needBytes: deps.needBytes, dropped: [], skipped: true };
  let free = await deps.measure();
  const dropped: OwnedTwin[] = [];
  for (const twin of deps.ownFinished) {
    if (free >= deps.needBytes) break;
    await deps.drop(twin);
    dropped.push(twin);
    free = await deps.measure();
  }
  if (free < deps.needBytes) {
    throw new DiskPreflightError(
      `Not enough free disk for a twin: ${formatBytes(free)} free on the database server's volume, ${formatBytes(deps.needBytes)} needed (the copy plus ${formatBytes(DISK_HEADROOM_BYTES)} headroom). ` +
        `${dropped.length} finished twin(s) of this control database were dropped first; nothing else was touched and nothing was cloned. Free space on the server, then resume.`,
    );
  }
  return { freeBytes: free, needBytes: deps.needBytes, dropped };
}
