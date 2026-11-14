import Link from "next/link";
import { ButtonLink, Callout, Card, TableWrap, Td, Th } from "@/components/ui";
import { dateTime } from "@/lib/format";
import type { DecisionHold } from "@/lib/metrics/decision";
import { dollars } from "@/lib/metrics/movement-copy";
import type { ExceptionRow } from "@/lib/queries";
import { dateRanges, runDates, type GapCoverage, type StoredVerification } from "@/lib/reconcile/gap-coverage";
import { CHANNEL_BY_CODE } from "@/lib/reference";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const channelName = (code: string) => CHANNEL_BY_CODE.get(code as never)?.label ?? code;

/**
 * A channel coverage gap's recovery, for its incident page: the business conclusion first, then
 * four statements that are never merged — the source delivered records, the required dates are
 * covered, the correction reconciles, the decision is no longer held by this incident — then the
 * delivery runs behind them and one next action. Everything comes from the accepted records (live)
 * and the verification reconciliation stored once; nothing here clears, approves or changes anything.
 */
export function GapRecovery({
  exception,
  coverage,
  otherHolds,
  links,
}: {
  exception: ExceptionRow;
  coverage: GapCoverage;
  /** Open incidents other than this one that hold the branch's budget decision. */
  otherHolds: DecisionHold[];
  links: { records: string; back: string | null; decisions: string };
}) {
  const branch = exception.branchId ?? coverage.branchId;
  const label = coverage.channelLabel;
  const verification = (exception.evidence as { verification?: StoredVerification }).verification ?? null;
  const open = [...coverage.missing, ...coverage.recordedZero].sort();
  const held = exception.status !== "resolved";
  const historical = !held && verification !== null && !coverage.complete;
  const window = `${dateRanges([coverage.window.from])} to ${dateRanges([coverage.window.to])}`;

  const headline = held
    ? coverage.covered.length === 0
      ? `Decision held: none of the ${coverage.required.length} required dates (${window}) has ${label} spend at ${branch} yet.`
      : `Decision still held: ${coverage.covered.length} of ${coverage.required.length} required dates have ${label} spend at ${branch}; ${open.length > 0 ? `${dateRanges(open)} still ${open.length === 1 ? "has" : "have"} none` : "successor spend in the window is still filed under another channel"}.`
    : verification
      ? historical
        ? `Verified ${dateTime(verification.verifiedAt)}, but the current records no longer cover ${open.length > 0 ? dateRanges(open) : "the whole window"}: that verification is historical.`
        : `Original blocker cleared: every required date (${window}) has ${label} spend at ${branch}, verified ${dateTime(verification.verifiedAt)}.`
      : `Resolved: ${exception.resolution ?? "condition no longer detected"}.`;

  // One source per state: the stored verification while it still describes the records, the live records otherwise.
  const stored = !held && !historical && verification !== null;
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

  return (
    <Card
      id="recovery"
      title={<span data-testid="recovery-headline">{headline}</span>}
      subtitle={`Verification scope: every date from the gap's start to the spend feed's latest date, for ${label} at ${branch}. Correction scope: whatever a delivery or re-map sent. The week picked on the Overview only chooses what to look at.`}
    >
      <div className="space-y-4" data-testid="gap-recovery" data-state={held ? (coverage.covered.length ? "partial" : "missing") : historical ? "historical" : verification ? "verified" : "resolved"}>
        {historical && (
          <Callout tone="warn" title="The stored verification no longer describes the records">
            It was true when it was recorded; a later version changed a date in the verified window. Reconciliation reopens this incident under the same id while that window is within 60 days of the spend feed&apos;s latest date; after that, only this page shows it.
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

        {runs.length > 0 && (
          <TableWrap label={verification && !held && !historical ? "Delivery runs the verification rests on" : "Delivery runs behind the covered dates"} minWidth={560} testId="recovery-runs">
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
                  <Td className="whitespace-nowrap">{r.runId === null ? "stored without a run" : `ingestion run #${r.runId}`}</Td>
                  <Td className="whitespace-nowrap font-mono text-xs">{r.adapterVersion}</Td>
                  <Td className="text-xs">{r.fetchedAt.first ? (r.fetchedAt.first === r.fetchedAt.last ? dateTime(r.fetchedAt.first) : `${dateTime(r.fetchedAt.first)} to ${dateTime(r.fetchedAt.last!)}`) : "—"}</Td>
                  <Td className="text-xs">{dateRanges(r.dates)}</Td>
                  <Td align="right" className="tabular-nums">{dollars(r.cents)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}

        <div className="flex flex-wrap items-center gap-2 border-t border-border pt-3 text-sm">
          <span className="font-medium text-text">Next:</span>
          <span className="text-muted" data-testid="recovery-next">
            {held
              ? `restore ${open.length ? dateRanges(open) : "the misfiled dates"} (the source re-fetching them, or the stored records re-mapped in the case below). The incident clears by itself once the accepted records cover the window; closing the case by hand does not lift the hold.`
              : "see in Decision Lab whether the budget decision can go to a person for review."}
          </span>
          {held ? <ButtonLink href={links.records} testId="recovery-records">Open the daily records</ButtonLink> : <ButtonLink href={links.decisions} variant="primary" testId="recovery-decisions">Open Decision Lab</ButtonLink>}
          {held ? (
            <Link href={links.decisions} className="text-sm font-medium text-accent hover:underline" data-testid="recovery-decisions-link">
              Decision readiness →
            </Link>
          ) : (
            <Link href={links.records} className="text-sm font-medium text-accent hover:underline" data-testid="recovery-records-link">
              The daily records →
            </Link>
          )}
          {links.back && (
            <Link href={links.back} className="text-sm font-medium text-accent hover:underline" data-testid="recovery-back">
              Back to the daily evidence
            </Link>
          )}
        </div>
      </div>
    </Card>
  );
}
