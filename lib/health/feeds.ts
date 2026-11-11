/** A feed is stale when its last successful run is older than this, by the business clock. */
export const STALE_AFTER_MS = 36 * 3_600_000;

interface FeedLike {
  stream: string;
  lastSuccessAt: Date | string | null;
  lastRunStatus: string | null;
}

/**
 * Which feeds need attention: stale (no success within STALE_AFTER_MS of the business clock, or
 * never) or failing (the latest run did not succeed). One rule for the top bar and Audit & Health.
 */
export function feedAttention<T extends FeedLike>(streams: T[], now: Date): { stale: T[]; failing: T[]; ok: boolean } {
  const stale = streams.filter((s) => !s.lastSuccessAt || now.getTime() - new Date(s.lastSuccessAt).getTime() > STALE_AFTER_MS);
  const failing = streams.filter((s) => s.lastRunStatus !== null && s.lastRunStatus !== "succeeded");
  return { stale, failing, ok: stale.length === 0 && failing.length === 0 };
}
