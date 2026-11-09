/**
 * JSON-safe shapes the Studio's client components receive (dates as ISO strings). Pure: no
 * imports, so client components can import these types and helpers without pulling server code.
 */

export interface JobStatsView {
  searched: number;
  fetched: number;
  inserted: number;
  duplicates: number;
  conflicts: number;
  projected: number;
  quarantined: number;
  rejected: number;
  missing: number;
  batches: number;
}

export interface JobView {
  id: number;
  officeId: number;
  branchId: string;
  entity: string;
  state: "queued" | "running" | "succeeded" | "failed" | "cancelled";
  attempts: number;
  maxAttempts: number;
  requestedBy: string;
  requestedAt: string;
  nextAttemptAt: string;
  finishedAt: string | null;
  cancelRequested: boolean;
  retryOf: number | null;
  stats: JobStatsView;
  lastError: string | null;
  lastErrorKind: string | null;
}

interface JobLike {
  id: number;
  officeId: number;
  branchId: string;
  entity: string;
  state: JobView["state"];
  attempts: number;
  maxAttempts: number;
  requestedBy: string;
  requestedAt: Date;
  nextAttemptAt: Date;
  finishedAt: Date | null;
  cancelRequested: boolean;
  retryOf: number | null;
  stats: JobStatsView;
  lastError: string | null;
  lastErrorKind: string | null;
}

export function toJobView(j: JobLike): JobView {
  return {
    id: j.id,
    officeId: j.officeId,
    branchId: j.branchId,
    entity: j.entity,
    state: j.state,
    attempts: j.attempts,
    maxAttempts: j.maxAttempts,
    requestedBy: j.requestedBy,
    requestedAt: new Date(j.requestedAt).toISOString(),
    nextAttemptAt: new Date(j.nextAttemptAt).toISOString(),
    finishedAt: j.finishedAt ? new Date(j.finishedAt).toISOString() : null,
    cancelRequested: j.cancelRequested,
    retryOf: j.retryOf,
    stats: j.stats,
    lastError: j.lastError,
    lastErrorKind: j.lastErrorKind,
  };
}

export const ACTIVE_STATES: ReadonlyArray<JobView["state"]> = ["queued", "running"];

/** One status vocabulary for jobs everywhere in the Studio. */
export function jobTone(state: string, retrying = false): "good" | "warn" | "bad" | "neutral" | "accent" {
  if (state === "succeeded") return "good";
  if (state === "failed") return "bad";
  if (state === "running") return "accent";
  if (state === "queued") return retrying ? "warn" : "neutral";
  return "neutral";
}

/** Same rendering as lib/format#dateTime, without its server-only imports. */
export function fmtTime(iso: string | null | undefined): string {
  return iso
    ? new Date(iso).toLocaleString("en-US", { month: "short", day: "numeric", hour: "numeric", minute: "2-digit", second: "2-digit", timeZone: "UTC", timeZoneName: "short" })
    : "—";
}

/** "45 s", "12 min", "3 h", "2 d" — for lags and waits. */
export function fmtDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return "—";
  const s = Math.round(Math.abs(ms) / 1000);
  if (s < 90) return `${s} s`;
  if (s < 90 * 60) return `${Math.round(s / 60)} min`;
  if (s < 36 * 3600) return `${Math.round(s / 3600)} h`;
  return `${Math.round(s / 86400)} d`;
}

/** Event the Studio's controls dispatch so the live jobs table resumes polling at once. */
export const JOBS_CHANGED_EVENT = "rs:sync-jobs-changed";
