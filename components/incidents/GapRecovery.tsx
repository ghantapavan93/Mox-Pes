import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ButtonLink, Callout, TableWrap, Td, Th } from "@/components/ui";
import { DecisionWindow, type StripDay } from "./DecisionWindow";
import { dateTime } from "@/lib/format";
import type { DecisionHold } from "@/lib/metrics/decision";
import { dollars } from "@/lib/metrics/movement-copy";
import type { ExceptionRow } from "@/lib/queries";
import { dateRanges, runDates, type GapCoverage, type StoredVerification } from "@/lib/reconcile/gap-coverage";
import type { WindowFacts } from "@/lib/reconcile/gap-days";
import type { GapStatus } from "@/lib/reconcile/gap-status";
import { CHANNEL_BY_CODE } from "@/lib/reference";

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? "" : "s"}`;
const channelName = (code: string) => CHANNEL_BY_CODE.get(code as never)?.label ?? code;

/**
 * A channel coverage gap's recovery, for its incident page, in the order a reader needs it
 * (docs/agent-work/HOLD-TO-DECISION.md §9): one verdict, the incident's status in the same words the
 * Overview, the daily evidence and Decision Lab use (lib/reconcile/gap-status.ts), with one primary
 * action beside it; the decision window as a strip of dates, the picked week beside the window, and
 * the selected date's evidence; then what moved, as a diff. The composition is the same in every
 * state: only the evidence changes.
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
  branchSpend,
  strip,
  links,
}: {
  exception: ExceptionRow;
  coverage: GapCoverage;
  status: GapStatus;
  /** Open incidents other than this one that hold the branch's budget decision. */
  otherHolds: DecisionHold[];
  /** The branch's paid media spend in the period the reader came with, counted now (verified state). */
  branchSpend: { periodLabel: string; cents: number } | null;
  /** The window's dates with their evidence, the two facts, and the date selected first (lib/reconcile/gap-days.ts). */
  strip: { days: StripDay[]; facts: WindowFacts; defaultDate: string | null };
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
      : otherHolds.length > 0
        ? `The coverage hold cleared, but the budget decision is still held by ${otherHolds.map((h) => `#${h.exceptionId}`).join(", ")}. Open decision readiness for every check still open. No budget change was approved.`
        : "Open decision readiness for every check still open. No budget change was approved.";
  const showBack = links.back !== null && (!needsRecords || links.back !== links.records.href);

  return (
    <section id="recovery" aria-labelledby="recovery-headline" className="scroll-mt-28 space-y-4" data-testid="gap-recovery" data-state={state}>
      {/* The verdict: the strongest line on the page, in ink in every state. A lifted coverage hold
          is not an approval, so it never turns into a green banner. The action sits under its
          reason at every width, never off at the far edge. */}
      <div className="space-y-3">
        <div className="min-w-0 max-w-3xl space-y-2">
          <h2 id="recovery-headline" className="text-[26px] font-semibold leading-8 tracking-tight text-text sm:text-[28px] sm:leading-9" data-testid="recovery-headline">
            {status.label}
          </h2>
          <p className="text-[15px] leading-6 text-text" data-testid="recovery-status">
            {status.statusText}
          </p>
          {!original && status.change && (
            <p className="text-sm leading-6 text-text" data-testid="recovery-change">
              {status.change}
            </p>
          )}
          <p className="text-sm leading-6 text-muted" data-testid="recovery-next">
            <span className="font-medium text-text">Next: </span>
            {next}
          </p>
          {!held && otherHolds.length > 0 && (
            <p className="text-sm font-medium text-text" data-testid="recovery-other-holds">
              The budget decision is still held by {otherHolds.map((h) => `#${h.exceptionId}`).join(", ")}.
            </p>
          )}
          {held && verification && (
            // Reopened under the same id (rule 6a): the earlier verification is history, never a clearance.
            <p className="text-sm text-muted" data-testid="recovery-history">
              This window was verified {dateTime(verification.verifiedAt)}, then a later revision un-covered {open.length ? dateRanges(open) : "part of it"}, so the hold is back on this incident. That verification is kept below as history; it is not a clearance.
            </p>
          )}
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {needsRecords ? (
            <ButtonLink href={links.records.href} variant="primary" testId="recovery-records" icon={<ArrowRight aria-hidden className="order-last size-4" />}>
              Open the records for {links.records.week}
            </ButtonLink>
          ) : (
            <ButtonLink href={links.decisions} variant="primary" testId="recovery-decisions" icon={<ArrowRight aria-hidden className="order-last size-4" />}>
              Open decision readiness
            </ButtonLink>
          )}
          {showBack && (
            <Link href={links.back!} className="text-sm font-medium text-accent hover:underline" data-testid="recovery-back">
              Back to the daily evidence
            </Link>
          )}
        </div>
      </div>

      <DecisionWindow days={strip.days} facts={strip.facts} defaultDate={strip.defaultDate} verifiedNote={state === "verified" && verification ? `verified ${dateTime(verification.verifiedAt)}` : null} />

      {original && <MoneyMoved status={status} coverage={coverage} branch={branch} branchSpend={branchSpend} />}

      <div className="rounded-xl bg-surface ring-1 ring-text/10">
        <details className="group" data-testid="recovery-details">
          <summary className="cursor-pointer rounded-xl px-4 py-3 text-sm font-medium text-text hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            Verification details
          </summary>
          <div className="space-y-4 border-t border-border p-4">
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
    </section>
  );
}

interface MoveTile {
  sign: string;
  tone: "bad" | "good" | "muted" | "ink";
  label: string;
  cents: number | null;
  note: string | null;
  testId: string;
  /** The branch total, proven unchanged: the tile the verified state leads with. */
  strong?: boolean;
}
const SIGN_TONE = { bad: "text-bad", good: "text-good", muted: "text-muted", ink: "text-text" } as const;

/**
 * What moved, in a diff's grammar and money type: out of the channel it was filed under, into the
 * channel it belongs to, and a third fact. That is the branch total "unchanged" only with the proof
 * (`status.reclassified`: verified, nothing misfiled, every day's amount kept); before it, what is
 * still filed elsewhere, or the amounts that changed. Amounts stay in ink and only the sign carries
 * the diff colour, so a move never reads as a loss or a gain. The incident's own sentence
 * (`status.change`) stays above the tiles, word for word.
 */
function MoneyMoved({ status, coverage, branch, branchSpend }: { status: GapStatus; coverage: GapCoverage; branch: string; branchSpend: { periodLabel: string; cents: number } | null }) {
  const original = status.original!;
  const moved = coverage.coveredCents;
  const verified = status.state === "verified";
  const changes = coverage.amountChanges;
  const changeList = changes
    .slice(0, 3)
    .map((a) => `${dateRanges([a.date])}: ${dollars(a.beforeCents)} → ${dollars(a.afterCents)}`)
    .join(" · ");
  const tiles: MoveTile[] = [];
  // Before anything moves there is no out/in pair: "Into Google Local Services $0.00" would read as
  // recorded zero spend, which a missing record never is. Only what is still filed elsewhere shows.
  if (moved > 0) {
    tiles.push(
      { sign: "−", tone: "bad", label: `Out of ${original.filedAs}`, cents: verified ? original.cents : moved, note: verified ? null : "moved so far", testId: "moved-out" },
      { sign: "+", tone: "good", label: `Into ${coverage.channelLabel}`, cents: moved, note: null, testId: "moved-in" },
    );
  }
  if (status.reclassified && branchSpend) {
    tiles.push({ sign: "=", tone: "ink", label: `${branch} paid media spend, ${branchSpend.periodLabel.split(",")[0]}`, cents: branchSpend.cents, note: "unchanged", testId: "moved-total", strong: true });
  } else if (coverage.misfiledCents > 0) {
    tiles.push({ sign: "·", tone: "muted", label: `Still filed as ${original.filedAs}`, cents: coverage.misfiledCents, note: dateRanges([...new Set(coverage.misfiled.map((m) => m.date))]), testId: "moved-still" });
  } else if (changes.length > 0) {
    tiles.push({ sign: "≠", tone: "bad", label: "Amounts changed", cents: null, note: changeList, testId: "moved-changed" });
  }
  // Under the tiles, the amounts, unless a tile already says them or nothing has moved.
  const amounts = moved === 0 || status.reclassified || tiles.some((t) => t.testId === "moved-changed") ? null : changes.length > 0 ? `Amounts changed: ${changeList}.` : "No amount changed on the dates moved.";
  return (
    <section aria-labelledby="moved-title" className="rounded-xl bg-surface p-4 ring-1 ring-text/10 sm:p-5" data-testid="money-moved" data-reclassified={status.reclassified}>
      <div className="flex flex-wrap items-center justify-between gap-x-6 gap-y-1">
        <h3 id="moved-title" className="text-[15px] font-semibold leading-6 tracking-tight text-text">
          What moved
        </h3>
        <span className="rounded-md bg-surface-2 px-2 py-0.5 text-xs font-semibold text-text ring-1 ring-text/10" data-testid="moved-label">
          {status.reclassified ? "Reclassified, not added" : verified ? "Verified, with changed amounts" : moved > 0 ? "Correction in progress" : "Nothing moved yet"}
        </span>
      </div>
      {status.change && (
        <p className="mt-1 max-w-3xl text-sm leading-6 text-text" data-testid="recovery-change">
          {status.change}
          {status.reclassified && branchSpend && (
            <span data-testid="recovery-total">
              {" "}
              {branch}&apos;s paid media spend in {branchSpend.periodLabel} stayed {dollars(branchSpend.cents)}.
            </span>
          )}
        </p>
      )}
      {/* Three columns in every state, so a tile keeps its size and place as the evidence changes. */}
      <ul className="mt-3 grid gap-2 sm:grid-cols-3" aria-label={`Spend moved between channels at ${branch}`} data-testid="moved-rows">
        {tiles.map((t) => (
          <li key={t.testId} className={`min-w-0 rounded-lg px-3.5 py-3 ${t.strong ? "bg-surface ring-1 ring-text/20" : "bg-surface-2"}`} data-testid={t.testId}>
            <p className="flex items-start gap-1.5 text-xs font-medium leading-4 text-muted">
              <span aria-hidden className={`w-3 shrink-0 text-center font-mono text-sm font-semibold leading-4 ${SIGN_TONE[t.tone]}`}>
                {t.sign}
              </span>
              <span className="min-w-0">{t.label}</span>
            </p>
            <p className="mt-1.5 flex flex-wrap items-baseline gap-x-2 text-[22px] font-semibold leading-7 tracking-tight tabular-nums text-text">
              {t.cents === null ? "—" : dollars(t.cents)}
              {t.strong && t.note && <span className="rounded-md bg-surface-2 px-1.5 py-0.5 text-xs font-semibold leading-4 tracking-normal text-text">{t.note}</span>}
            </p>
            {!t.strong && t.note && <p className="mt-0.5 text-xs leading-5 text-muted [overflow-wrap:anywhere]">{t.note}</p>}
          </li>
        ))}
      </ul>
      {amounts && <p className="mt-2.5 text-xs leading-5 text-muted">{amounts}</p>}
      {!status.held && (
        <p className="mt-3 border-t border-border pt-2.5 text-xs leading-5 text-muted">
          A cleared coverage hold lets a person review the decision. It moves no budget; Decision Lab weighs the rest.
        </p>
      )}
    </section>
  );
}
