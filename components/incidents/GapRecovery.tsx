import Link from "next/link";
import { ButtonLink, Callout, Card, TableWrap, Td, Th } from "@/components/ui";
import { dateTime } from "@/lib/format";
import type { DecisionHold } from "@/lib/metrics/decision";
import { dollars } from "@/lib/metrics/movement-copy";
import type { ExceptionRow } from "@/lib/queries";
import { dateRanges, runDates, type GapCoverage, type StoredVerification } from "@/lib/reconcile/gap-coverage";
import type { GapStatus } from "@/lib/reconcile/gap-status";
import { CHANNEL_BY_CODE } from "@/lib/reference";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const channelName = (code: string) => CHANNEL_BY_CODE.get(code as never)?.label ?? code;

/**
 * A channel coverage gap's recovery, for its incident page, in the order a reader needs it: the
 * conclusion (the incident's status, lib/reconcile/gap-status.ts, the same words the Overview, the
 * daily evidence and Decision Lab use), the most useful before/after fact, and one next action.
 * "Verification details" keeps the rest one click away: the two scopes, the four statements that
 * are never merged (the source delivered, the required dates are covered, the correction
 * reconciles, the decision is no longer held by this incident), the original finding and the
 * delivery runs. Nothing here clears, approves or changes anything.
 */
export function GapRecovery({
  exception,
  coverage,
  status,
  otherHolds,
  links,
}: {
  exception: ExceptionRow;
  coverage: GapCoverage;
  status: GapStatus;
  /** Open incidents other than this one that hold the branch's budget decision. */
  otherHolds: DecisionHold[];
  /**
   * `records`: the daily records of the week to look at next, and that week in words; `back`: the
   * selected week the reviewer came from; `run`: where a delivery run is shown (null for a viewer
   * who may not open the ingestion pipeline).
   */
  links: { records: { href: string; week: string }; back: string | null; decisions: string; run: ((runId: number) => string) | null };
}) {
  const branch = exception.branchId ?? coverage.branchId;
  const label = coverage.channelLabel;
  const verification = (exception.evidence as { verification?: StoredVerification }).verification ?? null;
  const open = [...coverage.missing, ...coverage.recordedZero].sort();
  const { held, state } = status;
  const historical = state === "historical";
  const window = `${dateRanges([coverage.window.from])} to ${dateRanges([coverage.window.to])}`;

  // One source per state: the stored verification while it still describes the records, the live records otherwise.
  const stored = state === "verified" && verification !== null;
  const runs = stored ? verification!.runs : coverage.runs;
  const carried = stored ? verification!.coveredCents : coverage.coveredCents;
  const transition = coverage.transition.length ? ` ${dateRanges(coverage.transition)}, before the successor's first spend, ${coverage.transition.length === 1 ? "is" : "are"} the transition: no record in either campaign, not required.` : "";
  const statements: Array<[string, string, "good" | "warn" | "bad" | "neutral"]> = [
    [
      "Source delivered",
      runs.length === 0
        ? "No accepted record covers a required date yet. A delivery that re-sends identical records changes nothing."
        : stored
          ? `${plural(runs.length, "delivery run")} carried the accepted records for ${plural(runDates(runs), "required date")} when it was verified.`
          : `${plural(runs.length, "delivery run")} ${runs.length === 1 ? "carries" : "carry"} the accepted records for ${plural(runDates(runs), "required date")}. Delivered is not covered: the window is checked below.`,
      runs.length === 0 ? "neutral" : "good",
    ],
    [
      "Required dates covered",
      coverage.complete
        ? `${coverage.covered.length} of ${coverage.required.length} (${window}).${transition}`
        : `${coverage.covered.length} of ${coverage.required.length}${coverage.missing.length ? `; no ${label} spend record on ${dateRanges(coverage.missing)}` : ""}${coverage.recordedZero.length ? `; recorded $0.00 on ${dateRanges(coverage.recordedZero)}` : ""}.${transition}`,
      coverage.complete ? "good" : "bad",
    ],
    [
      "Reconciles",
      coverage.misfiled.length > 0
        ? `${dollars(coverage.misfiledCents)} of successor spend on ${plural(new Set(coverage.misfiled.map((m) => m.date)).size, "date")} is still filed ${[...new Set(coverage.misfiled.map((m) => (m.branchId === branch ? `under ${channelName(m.channel)}` : `at ${m.branchId ?? "no branch"}`)))].join(" and ")}.`
        : `No successor spend in the window is filed under another channel or at another branch; ${dollars(carried)} ${stored ? "was" : "is"} filed as ${label} at ${branch}.`,
      coverage.misfiled.length > 0 ? "bad" : "good",
    ],
    [
      "Decision",
      held
        ? `Held by this incident until every required date is covered and nothing is misfiled.${otherHolds.length ? ` Also held by ${otherHolds.map((h) => `#${h.exceptionId}`).join(", ")}.` : ""}`
        : otherHolds.length
          ? `No longer held by this incident; still held by ${otherHolds.map((h) => `#${h.exceptionId}`).join(", ")}.`
          : `No open incident holds ${branch}'s budget decision. Decision Lab weighs the rest (data integrity, customers, freshness). Nothing here approves a budget change.`,
      held || otherHolds.length ? "bad" : "good",
    ],
  ];
  const DOT = { good: "bg-good", warn: "bg-warn", bad: "bg-bad", neutral: "bg-faint" } as const;
  const original = status.original;

  // One next action per state: while the window is open, the records of the dates that need it;
  // once verified, Decision Lab.
  const needsRecords = held || historical;
  const next = held
    ? `${open.length ? dateRanges(open) : "The misfiled dates"} must arrive as ${label} spend, re-sent by the source or re-mapped in Fix & approval below. The hold lifts by itself once every date is covered; closing the case does not lift it.`
    : historical
      ? `${open.length ? dateRanges(open) : "Part of the window"} no longer ${open.length === 1 ? "has" : "have"} ${label} spend. Reconciliation reopens this incident under the same id while the window is within 60 days of the spend feed's latest date.`
      : "See in Decision Lab whether the budget decision can go to a person for review. Nothing here approves a budget change.";
  const showBack = links.back !== null && (!needsRecords || links.back !== links.records.href);

  return (
    <Card id="recovery" title={<span data-testid="recovery-headline">{status.conclusion}</span>}>
      <div className="space-y-4" data-testid="gap-recovery" data-state={state}>
        {status.change && (
          <p className="text-sm leading-6 text-text" data-testid="recovery-change">
            {status.change}
          </p>
        )}
        {!held && otherHolds.length > 0 && (
          <p className="text-sm font-medium text-text" data-testid="recovery-other-holds">
            The budget decision is still held by {otherHolds.map((h) => `#${h.exceptionId}`).join(", ")}.
          </p>
        )}

        <div className="space-y-2 border-t border-border pt-3">
          <p className="text-sm text-muted" data-testid="recovery-next">
            <span className="font-medium text-text">Next: </span>
            {next}
          </p>
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
            {needsRecords ? (
              <ButtonLink href={links.records.href} variant="primary" testId="recovery-records">
                Open the records for {links.records.week}
              </ButtonLink>
            ) : (
              <ButtonLink href={links.decisions} variant="primary" testId="recovery-decisions">
                Open Decision Lab
              </ButtonLink>
            )}
            {showBack && (
              <Link href={links.back!} className="text-sm font-medium text-accent hover:underline" data-testid="recovery-back">
                Back to the daily evidence
              </Link>
            )}
          </div>
        </div>

        <details className="group rounded-md border border-border" data-testid="recovery-details">
          <summary className="cursor-pointer rounded-md px-3 py-2 text-sm font-medium text-text hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            Verification details
          </summary>
          <div className="space-y-4 border-t border-border p-3">
            <p className="text-xs leading-5 text-muted">
              Decision window (verification scope): every date from the gap&apos;s start to the spend feed&apos;s latest date, for {label} at {branch}; once verified, the dates that were verified. Correction scope: whatever a delivery or re-map sent. The week picked on the Overview only chooses what to look at.
            </p>
            {historical && verification && (
              <Callout tone="warn" title="The stored verification no longer describes the records">
                It was true when it was recorded ({dateTime(verification.verifiedAt)}); a later version changed a date in the verified window. Reconciliation reopens this incident under the same id while that window is within 60 days of the spend feed&apos;s latest date; after that, only this page shows it.
              </Callout>
            )}
            <dl className="grid gap-x-4 gap-y-2 text-sm sm:grid-cols-[max-content_1fr]" data-testid="recovery-statements">
              {statements.map(([term, text, tone]) => (
                <div key={term} className="contents">
                  <dt className="flex items-center gap-2 font-medium text-text">
                    <span aria-hidden className={`size-2 shrink-0 rounded-full ${DOT[tone]}`} />
                    {term}
                  </dt>
                  <dd className="text-muted" data-testid={`recovery-${term.toLowerCase().replaceAll(" ", "-")}`}>
                    {text}
                  </dd>
                </div>
              ))}
            </dl>
            <div className="text-sm" data-testid="recovery-original">
              <p className="font-medium text-text">Original finding, first detected {dateTime(exception.firstDetectedAt)}</p>
              <p className="mt-0.5 text-muted">
                {exception.summary.replace(/\.$/, "")}.
                {original ? ` ${original.campaigns} carried ${dollars(original.cents)} from ${dateRanges([coverage.window.from])}, filed as ${original.filedAs}.` : ""}
              </p>
            </div>
            {runs.length > 0 && (
              <TableWrap label={stored ? "Delivery runs the verification rests on" : "Delivery runs behind the covered dates"} minWidth={560} testId="recovery-runs">
                <thead>
                  <tr>
                    <Th>Run</Th>
                    <Th>Filed by</Th>
                    <Th>Source revision (fetched)</Th>
                    <Th>Dates</Th>
                    <Th align="right">Spend</Th>
                  </tr>
                </thead>
                <tbody>
                  {runs.map((r) => (
                    <tr key={`${r.runId}-${r.adapterVersion}`}>
                      <Td className="whitespace-nowrap">
                        {r.runId === null ? (
                          "stored without a run"
                        ) : links.run ? (
                          <Link href={links.run(r.runId)} className="font-medium text-accent hover:underline" data-testid="recovery-run-link">
                            ingestion run #{r.runId}
                          </Link>
                        ) : (
                          `ingestion run #${r.runId}`
                        )}
                      </Td>
                      <Td className="whitespace-nowrap font-mono text-xs">{r.adapterVersion}</Td>
                      <Td className="text-xs">{r.fetchedAt.first ? (r.fetchedAt.first === r.fetchedAt.last ? dateTime(r.fetchedAt.first) : `${dateTime(r.fetchedAt.first)} to ${dateTime(r.fetchedAt.last!)}`) : "—"}</Td>
                      <Td className="text-xs">{dateRanges(r.dates)}</Td>
                      <Td align="right" className="tabular-nums">{dollars(r.cents)}</Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
          </div>
        </details>
      </div>
    </Card>
  );
}
