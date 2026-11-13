import Link from "next/link";
import { AlertTriangle, CheckCircle2, Clock, Info, Replace } from "lucide-react";
import { Badge, ButtonLink, Card } from "@/components/ui";
import type { MonitorState } from "@/lib/changeguard/monitor";
import type { DecisionSummary as Summary } from "@/lib/changeguard/summary";
import { dateTime } from "@/lib/format";
import { STATE_LABEL } from "./MonitoringStatus";

const TONE: Record<MonitorState, "good" | "warn" | "bad" | "neutral"> = {
  current: "good",
  overdue: "warn",
  insufficient_evidence: "warn",
  confirmed_drift: "bad",
  replaced: "neutral",
};
/** Overdue is a missing check, not a finding: its own icon and words, never the drift's. */
const ICON: Record<MonitorState, typeof Clock> = {
  current: CheckCircle2,
  overdue: Clock,
  insufficient_evidence: Info,
  confirmed_drift: AlertTriangle,
  replaced: Replace,
};

/**
 * The decision summary above a released change's numbered sections: the release verdict, the
 * latest monitoring verdict, what changed in the evidence, what the system did not change, and
 * one next action for this viewer. Stored results only (lib/changeguard/summary.ts); the
 * timestamps, source checks and audit history stay in question 8.
 */
export function DecisionSummary({ summary, detailsHref }: { summary: Summary; detailsHref: string }) {
  const { release, latest, changed, unchanged, caution, next } = summary;
  const Icon = ICON[latest.state];
  return (
    <Card title="Decision summary" subtitle="From the stored release verification and the latest scheduled check. Nothing here is a prediction.">
      <div className="space-y-4" data-testid="decision-summary" data-state={latest.state}>
        <div className="grid gap-3 sm:grid-cols-2">
          <div className="min-w-0 rounded-md border border-border p-3" data-testid="summary-release">
            <p className="text-xs font-medium text-muted">At release</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={release.verdict === "verified" ? "good" : "warn"} dot>
                {release.verdict === "verified" ? "Verified" : "Degraded"}
              </Badge>
              <span className="tabular-nums text-muted">{dateTime(release.at)}</span>
            </p>
            <p className="mt-1 text-xs text-muted">
              {release.passed} of {release.of} release checks passed. Approved on {release.approvedOn}.
            </p>
          </div>
          <div className="min-w-0 rounded-md border border-border p-3" data-testid="summary-latest" data-tone={TONE[latest.state]}>
            <p className="text-xs font-medium text-muted">Latest check</p>
            <p className="mt-1 flex flex-wrap items-center gap-2 text-sm">
              <Badge tone={TONE[latest.state]}>
                <Icon aria-hidden className="mr-1 inline size-3 align-[-2px]" />
                {STATE_LABEL[latest.state]}
              </Badge>
              <span className="tabular-nums text-muted">{latest.at ? dateTime(latest.at) : "none yet"}</span>
            </p>
            {latest.overdue && latest.state !== "overdue" && latest.dueAt && (
              <p className="mt-2 inline-flex items-start gap-1 rounded bg-warn-soft px-1.5 py-0.5 text-xs text-warn" data-testid="summary-overdue" data-tone="warn">
                <Clock aria-hidden className="mt-0.5 size-3 flex-none" />
                Next check overdue: due {dateTime(latest.dueAt)}. A missing check, not a new finding.
              </p>
            )}
          </div>
        </div>

        <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_minmax(0,1fr)]">
          <dt className="font-medium text-text">What changed in the evidence</dt>
          <dd className="min-w-0 text-muted" data-testid="summary-changed">
            <ul className="space-y-1">
              {changed.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </dd>
          <dt className="font-medium text-text">What the system did not change</dt>
          <dd className="min-w-0 text-muted" data-testid="summary-unchanged">
            <ul className="space-y-1">
              {unchanged.map((line) => (
                <li key={line}>{line}</li>
              ))}
            </ul>
          </dd>
        </dl>

        {caution && (
          <p className="flex gap-2 rounded-md border border-border bg-surface-2 p-2 text-sm text-text" data-testid="summary-caution">
            <Info aria-hidden className="mt-0.5 size-4 flex-none text-accent" />
            <span>{caution}</span>
          </p>
        )}

        <div className="flex flex-col gap-2 border-t border-border pt-3 sm:flex-row sm:flex-wrap sm:items-center" data-testid="summary-next" data-primary={next.primary}>
          <span className="text-xs font-medium uppercase tracking-wide text-faint">Next</span>
          {next.href ? (
            <ButtonLink href={next.href} variant={next.primary ? "primary" : "secondary"} testId="summary-next-action">
              {next.label}
            </ButtonLink>
          ) : (
            <span className="text-sm font-medium text-text" data-testid="summary-next-action">
              {next.label}
            </span>
          )}
          <span className="min-w-0 text-sm text-muted">{next.note}</span>
        </div>
        <p className="text-xs text-faint">
          Timestamps, the source checks and the audit history:{" "}
          <Link href={detailsHref} className="text-accent underline">
            question 8, below
          </Link>
          .
        </p>
      </div>
    </Card>
  );
}
