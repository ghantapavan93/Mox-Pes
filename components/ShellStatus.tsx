import Link from "next/link";
import { Database, Globe2 } from "lucide-react";
import { dateTime } from "@/lib/format";
import { freshness } from "@/lib/metrics/scorecard";
import { feedAttention } from "@/lib/health/feeds";
import { BRAND_BY_ID } from "@/lib/reference";
import { businessNow, getPool, getViewer } from "@/lib/server";

/**
 * Top-bar data freshness: when the numbers were last current, and whether any feed is behind.
 * Every page's numbers are only as current as this, so it is always visible.
 */
export async function FreshnessIndicator() {
  const [streams, now] = await Promise.all([freshness(getPool()), businessNow()]);
  const successes = streams.map((s) => s.lastSuccessAt).filter((d): d is Date => d !== null);
  const asOf = successes.length ? new Date(Math.min(...successes.map((d) => new Date(d).getTime()))) : null;
  const { stale, failing, ok } = feedAttention(streams, now);
  return (
    <Link
      href="/audit"
      className="hidden min-w-0 items-center gap-2 rounded-md px-2 py-1 text-xs text-muted hover:bg-surface-2 hover:text-text md:inline-flex"
      data-testid="freshness-indicator"
      title={ok ? "All feeds succeeded within 36 hours" : `${stale.length} stale, ${failing.length} failing — open Audit & Health`}
    >
      <span aria-hidden className={`size-2 shrink-0 rounded-full ${ok ? "bg-good" : "bg-warn"}`} />
      <Database aria-hidden className="size-3.5 shrink-0" />
      <span className="truncate">
        {asOf ? <>Data as of <span className="font-medium text-text">{dateTime(asOf)}</span></> : "No successful sync yet"}
        <span className="text-faint"> · {ok ? `${streams.length} feeds fresh` : `${stale.length + failing.length} of ${streams.length} feeds need attention`}</span>
      </span>
    </Link>
  );
}

/** What the current viewer can see: the scope every number on the page is computed over. */
export async function ScopeIndicator() {
  const viewer = await getViewer();
  const label = viewer.brandIds
    ? `${viewer.brandIds.map((b) => BRAND_BY_ID.get(b)!.name).join(", ")} · ${viewer.branchIds!.length} branches`
    : viewer.branchIds
      ? `Branch ${viewer.branchIds.join(", ")} only`
      : "All brands · 44 branches";
  return (
    <span className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface px-2 py-1 text-xs text-muted" data-testid="scope-indicator">
      <Globe2 aria-hidden className="size-3.5" />
      <span className="sr-only">Scope:</span>
      <span className="font-medium text-text">{label}</span>
    </span>
  );
}
