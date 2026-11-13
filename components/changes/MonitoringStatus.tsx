import Link from "next/link";
import { Badge } from "@/components/ui";
import { namesOnlyVisibleBranches, type MonitorOutcome, type MonitorState, type MonitorView } from "@/lib/changeguard/monitor";
import { OVERDUE_AFTER_MS } from "@/lib/changeguard/schedule";
import { dateTime } from "@/lib/format";
import type { Viewer } from "@/lib/viewer";

export const STATE_LABEL: Record<MonitorState, string> = {
  current: "Current",
  overdue: "Overdue",
  insufficient_evidence: "Insufficient evidence",
  confirmed_drift: "Confirmed drift",
  replaced: "Replaced by a newer release",
};
const STATE_TONE: Record<MonitorState, "good" | "warn" | "bad" | "neutral"> = {
  current: "good",
  overdue: "warn",
  insufficient_evidence: "warn",
  confirmed_drift: "bad",
  replaced: "neutral",
};
export const OUTCOME_LABEL: Record<MonitorOutcome, string> = {
  current: "Current",
  insufficient_evidence: "Insufficient evidence",
  drift: "Confirmed drift",
  superseded: "Replaced by a newer release",
  error: "The check did not run",
};

function sentence(view: MonitorView): string {
  switch (view.state) {
    case "current":
      return view.latestConclusion
        ? "The latest check found the released mapping in place and the evidence as it was approved."
        : `Verified at release; the first scheduled check is due ${view.nextDueAt ? dateTime(view.nextDueAt) : "—"}.`;
    case "overdue":
      return `A scheduled check is more than ${OVERDUE_AFTER_MS / 3_600_000} h late, so nothing certifies the mapping as current. Is the worker running?`;
    case "insufficient_evidence":
      return view.latestConclusion
        ? "The latest check could not certify the mapping as current (see why below). The last successful verification was not refreshed."
        : "The release verification did not fully pass, and no check has certified the mapping since.";
    case "confirmed_drift":
      return "Stored records contradict what the release was approved on. The mapping was left as released and nothing was rolled back; a person reviews it.";
    case "replaced":
      return "A newer ChangeGuard release of this campaign replaced this change; it is no longer monitored.";
  }
}

/**
 * Post-release monitoring for one released campaign mapping: "verified at release" apart from
 * the latest scheduled result, the last SUCCESSFUL verification, and what is due next. Sentences
 * that name a branch outside the viewer's scope are not shown to them.
 */
export function MonitoringStatus({ changeId, view, viewer }: { changeId: number; view: MonitorView; viewer: Pick<Viewer, "branchIds"> }) {
  const latest = view.latest;
  const concluded = view.latestConclusion;
  const reviewVisible = view.reviewItem && (viewer.branchIds === null || (view.reviewItem.branchId !== null && viewer.branchIds.includes(view.reviewItem.branchId)));
  return (
    <div className="space-y-2 rounded-md border border-border p-3" data-testid="monitoring" data-state={view.state}>
      <p className="text-sm">
        <span data-testid="monitoring-state">
          <Badge tone={STATE_TONE[view.state]} dot>
            {STATE_LABEL[view.state]}
          </Badge>
        </span>{" "}
        <span className="text-muted">{sentence(view)}</span>
      </p>
      <dl className="grid gap-x-4 gap-y-1 text-xs sm:grid-cols-[max-content_minmax(0,1fr)]">
        <dt className="font-medium text-text">Verified at release</dt>
        <dd className="text-muted" data-testid="verified-at-release">
          {dateTime(view.release.at)} · {view.release.passed} of {view.release.of} release checks passed, in the release transaction. Fixed; monitoring never changes it.
        </dd>
        <dt className="font-medium text-text">Latest monitoring result</dt>
        <dd className="text-muted" data-testid="latest-check">
          {latest ? (
            <>
              <span className="text-text">{OUTCOME_LABEL[latest.outcome]}</span> · {dateTime(latest.ranAt)} · {latest.trigger === "scheduled" ? `scheduled check (slot ${dateTime(latest.slotAt!)})` : `run on request by ${latest.ranBy}`}
              {latest.outcome === "error" && latest.error ? ` · ${latest.error}` : ""} ·{" "}
              <Link href={`/changes/${changeId}/checks/${latest.id}`} className="text-accent underline" data-testid="check-evidence-link">
                evidence for check #{latest.id}
              </Link>
              {concluded && concluded.id !== latest.id && (
                <>
                  {" "}· last conclusion: {OUTCOME_LABEL[concluded.outcome]} ({dateTime(concluded.ranAt)},{" "}
                  <Link href={`/changes/${changeId}/checks/${concluded.id}`} className="text-accent underline">
                    #{concluded.id}
                  </Link>
                  )
                </>
              )}
            </>
          ) : (
            "No check has run yet."
          )}
        </dd>
        <dt className="font-medium text-text">Last successful verification</dt>
        <dd className="text-muted" data-testid="last-verified">
          {view.lastVerifiedAt ? `${dateTime(view.lastVerifiedAt)}${view.lastVerifiedAt === view.release.at ? " (the release)" : " (a check that found it current)"}` : "None: nothing has certified it yet."} A check that fails or cannot certify never moves this.
        </dd>
        <dt className="font-medium text-text">Next scheduled check</dt>
        <dd className="text-muted" data-testid="next-check">
          {view.state === "replaced"
            ? "None: replaced."
            : view.windowEnded
              ? `None: the monitoring window ended ${dateTime(view.windowEndsAt!)}.`
              : view.nextDueAt
                ? `${view.overdue ? "Overdue: was due " : ""}${dateTime(view.nextDueAt)}${view.retryAt ? ` · after an error, retried from ${dateTime(view.retryAt)}` : ""} · daily until ${view.windowEndsAt ? dateTime(view.windowEndsAt) : "—"}`
                : "None scheduled."}
        </dd>
        <dt className="font-medium text-text">Review item</dt>
        <dd className="text-muted" data-testid="review-item">
          {view.reviewItem ? (
            reviewVisible ? (
              <Link href={`/exceptions/${view.reviewItem.id}`} className="text-accent underline">
                Incident #{view.reviewItem.id} ({view.reviewItem.status})
              </Link>
            ) : (
              `One review item exists (${view.reviewItem.status}); it belongs to a branch outside your scope.`
            )
          ) : (
            "None."
          )}
        </dd>
      </dl>
      {concluded && (
        <ul className="space-y-1 text-xs" aria-label="Latest monitoring checks">
          {concluded.checks.map((c) => (
            <li key={c.id} className="flex gap-2" data-check={c.id} data-status={c.status ?? (c.passed ? "pass" : "fail")}>
              <span aria-hidden className={c.status === "unknown" ? "text-warn" : c.passed ? "text-good" : "text-bad"}>
                {c.status === "unknown" ? "?" : c.passed ? "✓" : "✗"}
              </span>
              <span className="min-w-0">
                <span className="font-medium">monitoring, {c.id.replaceAll("_", " ")}</span>:{" "}
                {namesOnlyVisibleBranches(viewer, c.detail) ? c.detail : "This finding names a branch outside your scope; a company-wide role can read it in full."}
              </span>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
