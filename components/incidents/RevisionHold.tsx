import Link from "next/link";
import { ArrowRight } from "lucide-react";
import { ButtonLink, TableWrap, Td, Th } from "@/components/ui";
import { dateTime } from "@/lib/format";
import { dollars } from "@/lib/metrics/movement-copy";
import type { ExceptionRow } from "@/lib/queries";
import { dateRanges } from "@/lib/reconcile/gap-coverage";
import {
  LISTED_DAYS,
  correctionClause,
  dayKey,
  holdMoney,
  holdSentence,
  isCorrection,
  refusalReason,
  type RefusedRevision,
  type RevisionCorrection,
} from "@/lib/reconcile/refused-revisions";
import { CHANNEL_BY_CODE } from "@/lib/reference";

const channelName = (code: string) => CHANNEL_BY_CODE.get(code as never)?.label ?? code;
const month = (iso: string) => new Date(`${iso}T00:00:00Z`).toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
/** "raw #121, #122, #123" for a few deliveries; "raw #121 … #176" for many. */
const refusalIds = (ids: number[]) => (ids.length <= 4 ? `raw ${ids.map((id) => `#${id}`).join(", ")}` : `raw #${ids[0]} … #${ids[ids.length - 1]}`);

/**
 * A hold on refused spend revisions, for its incident page (docs/agent-work/HOLD-TO-DECISION.md):
 * the decision, why it holds or cleared, and one next action, before anything else. The amount the
 * ledger counts and the revision intake refused are always told apart: the refused amount is shown
 * only as refused, never summed, and a held date is never $0. The revisions and their deliveries
 * sit one click away in "Revision details". Nothing here lifts the hold or approves anything.
 */
export function RevisionHold({
  exception,
  revisions,
  corrections,
  branchSpend,
  links,
}: {
  exception: ExceptionRow;
  /** The refused revisions that still hold the decision (empty once corrected). */
  revisions: RefusedRevision[];
  /** The revisions that stopped holding it, and how. */
  corrections: RevisionCorrection[];
  /** The branch's paid media spend in the period the reader came with, counted now. */
  branchSpend: { periodLabel: string; cents: number } | null;
  /** `records`: the daily evidence of the first held date's week; `run`: a delivery run's row, or null for a viewer who may not open the pipeline. */
  links: { records: { href: string; week: string } | null; decisions: string; run: ((runId: number) => string) | null };
}) {
  const branch = exception.branchId ?? "this branch";
  const held = exception.status !== "resolved" && revisions.length > 0;
  const months = list([...new Set(revisions.map((r) => month(r.date)))]);
  // Counted once per campaign-day (K1); a day no longer counted left the total, it is not $0.00 (K2).
  const money = holdMoney(revisions, corrections);
  // Only an accepted revision corrects a hold. The others hand it on: the day became held spend, or
  // the campaign is mapped to another branch, whose incident holds it now (K2).
  const corrected = corrections.every((c) => isCorrection(c));
  const moved = corrections.filter((c) => c.correction.how === "other" && c.correction.branchId !== null && c.correction.branchId !== exception.branchId);
  const headline = held
    ? "Hold the budget decision"
    : !corrected
      ? "No longer held by this incident"
      : corrections.every((c) => c.correction.how === "newer_accepted")
        ? "Hold lifted · a newer revision was accepted"
        : corrections.every((c) => c.correction.how === "accepted_itself")
          ? "Hold lifted · the refused revision was accepted"
          : "Hold lifted";
  const listed = revisions.slice(0, LISTED_DAYS);
  const run = (id: number | null, testId: string) =>
    id === null ? "no run" : links.run ? (
      <Link href={links.run(id)} className="font-medium text-accent hover:underline" data-testid={testId}>
        ingestion run #{id}
      </Link>
    ) : (
      `ingestion run #${id}`
    );

  return (
    // The same composition as a coverage gap's recovery: one verdict in ink, why, one action, then
    // the records one click away. A lifted hold never turns into a green banner.
    <section id="recovery" aria-labelledby="hold-headline" className="scroll-mt-28 space-y-4" data-testid="revision-hold" data-state={held ? "held" : "lifted"}>
      <div className="space-y-3">
        <div className="min-w-0 max-w-3xl space-y-2">
          <h2 id="hold-headline" className="text-[26px] font-semibold leading-8 tracking-tight text-text sm:text-[28px] sm:leading-9" data-testid="hold-headline">
            {headline}
          </h2>
          {held ? (
            <>
              <p className="text-[15px] leading-6 text-text" data-testid="hold-reason">
                {holdSentence(revisions)} {branch}&apos;s {months} budget decision is held until a newer revision is accepted.
              </p>
              {corrections.length > 0 && (
                // A campaign-day already corrected in this incident stays visible, with its delivery.
                <p className="text-sm leading-6 text-muted" data-testid="hold-corrected">
                  Already lifted, and no longer holding it: {corrections.map((c) => correctionClause(c, exception.branchId)).join("; ")}.
                </p>
              )}
            </>
          ) : (
            <div className="space-y-1.5 text-[15px] leading-6 text-text" data-testid="hold-reason">
              <p>{corrections.length > 0 ? `${corrections.map((c) => correctionClause(c, exception.branchId)).join("; ")}.` : (exception.resolution ?? "No refused revision holds this decision any more.")}</p>
              {branchSpend && (
                <p data-testid="hold-total">
                  {money.changedDays === 0 && moved.length === 0
                    ? `No amount changed: ${branch}'s paid media spend in ${branchSpend.periodLabel} is ${dollars(branchSpend.cents)}.`
                    : // An accepted correction keeps its sentence; a hand-off says what left the total, and where it went.
                      `${corrected ? "The correction changed the amount, so " : ""}${branch}'s paid media spend in ${branchSpend.periodLabel} is now ${dollars(branchSpend.cents)}${
                        money.changeCents === 0 ? "" : `, ${money.changeCents >= 0 ? "+" : "−"}${dollars(Math.abs(money.changeCents))} against the amount counted before it`
                      }${moved.length === 0 ? "" : `; ${list(moved.map((c) => `${dateRanges([c.date])}'s ${dollars(c.acceptedCents)} now counts at ${c.correction.branchId}`))}`}.`}
                </p>
              )}
            </div>
          )}
          <p className="text-sm leading-6 text-muted" data-testid="hold-next">
            <span className="font-medium text-text">Next: </span>
            {held
              ? `The source has to send a newer revision of ${dateRanges(revisions.map((r) => r.date))} that intake accepts; the hold then lifts by itself. Nothing on this page lifts it, and closing the case does not.`
              : corrected
                ? "See in Decision Lab what still prevents a decision. Lifting this hold approves no budget change."
                : "See in Decision Lab what holds the decision now. Nothing here was corrected, and nothing approves a budget change."}
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          {held && links.records ? (
            <ButtonLink href={links.records.href} variant="primary" testId="hold-records" icon={<ArrowRight aria-hidden className="order-last size-4" />}>
              Open the records for {links.records.week}
            </ButtonLink>
          ) : (
            <ButtonLink href={links.decisions} variant="primary" testId="hold-decisions" icon={<ArrowRight aria-hidden className="order-last size-4" />}>
              Open decision readiness
            </ButtonLink>
          )}
        </div>
      </div>

      <div className="rounded-xl bg-surface ring-1 ring-text/10">
        <details className="group" data-testid="hold-details">
          <summary className="cursor-pointer rounded-xl px-4 py-3 text-sm font-medium text-text hover:bg-surface-2 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent">
            Revision details
          </summary>
          <div className="space-y-4 border-t border-border p-3">
            <p className="text-xs leading-5 text-muted">
              A campaign-day is one campaign&apos;s spend on one date, as the platform names it (platform, campaign id, date). Revisions are ordered by the source&apos;s own fetch time, never by arrival. The ledger counts the newest revision intake accepted; a refused one is stored as evidence and never counted.
            </p>
            {revisions.length > 0 && (
              <TableWrap label="Refused revisions that hold the decision" minWidth={560} testId="hold-revisions">
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th>Counted now</Th>
                    <Th>Refused revision (not counted)</Th>
                  </tr>
                </thead>
                <tbody>
                  {listed.map((r) => (
                    <tr key={dayKey(r)} data-date={r.date}>
                      <Td className="whitespace-nowrap">
                        {dateRanges([r.date])}
                        <span className="block text-xs text-muted">
                          {r.externalCampaignId} · {channelName(r.channel)}
                        </span>
                      </Td>
                      <Td className="text-xs">
                        <span className="text-sm font-medium tabular-nums text-text">{dollars(r.acceptedCents)}</span>
                        <span className="block text-muted">
                          fetched {dateTime(r.acceptedFetchedAt)} · {run(r.acceptedRunId, "hold-accepted-run")} · <span className="font-mono">raw #{r.acceptedRawEventId}</span>
                        </span>
                      </Td>
                      <Td className="text-xs">
                        <span className="text-sm tabular-nums text-text">{r.refusedCents === null ? "amount unreadable" : `said ${dollars(r.refusedCents)}`}</span>
                        <span className="block text-muted">
                          fetched {dateTime(r.refusedFetchedAt)} · {run(r.refusedRunId, "hold-refused-run")} · <span className="font-mono">raw #{r.rawEventId}</span>
                        </span>
                        {r.refusedRawEventIds.length > 1 && (
                          // Every delivery stays on record; the counted amount is still one amount.
                          <span className="block text-muted" data-testid="hold-refusals">
                            refused {r.refusedRawEventIds.length} times: <span className="font-mono">{refusalIds(r.refusedRawEventIds)}</span>
                          </span>
                        )}
                        <span className="block text-text">Refused because {refusalReason(r)}.</span>
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            )}
            {revisions.length > listed.length && (
              <p className="text-xs leading-5 text-muted" data-testid="hold-unlisted">
                {revisions.length - listed.length} more held campaign-days are not listed here. The incident holds every one of them, and the records list below shows each refused delivery.
              </p>
            )}
            {corrections.length > 0 && (
              <TableWrap label="How each campaign-day stopped holding" minWidth={560} testId="hold-corrections">
                <thead>
                  <tr>
                    <Th>Date</Th>
                    <Th align="right">Counted before</Th>
                    <Th align="right">Counted after</Th>
                    <Th>By</Th>
                  </tr>
                </thead>
                <tbody>
                  {corrections.map((c) => (
                    <tr key={`${dayKey(c)}|${c.correction.at}`} data-date={c.date}>
                      <Td className="whitespace-nowrap">
                        {dateRanges([c.date])}
                        <span className="block text-xs text-muted">{c.externalCampaignId}</span>
                      </Td>
                      <Td align="right" className="tabular-nums">{dollars(c.acceptedCents)}</Td>
                      <Td align="right" className="tabular-nums">{c.correction.cents === null ? "not counted" : dollars(c.correction.cents)}</Td>
                      <Td className="text-xs">
                        {c.correction.how === "newer_accepted" ? (
                          <>
                            {run(c.correction.runId, "hold-correction-run")}, a revision fetched {dateTime(c.correction.fetchedAt)}
                          </>
                        ) : c.correction.how === "accepted_itself" ? (
                          `the refused revision itself${c.correction.replayId === null ? "" : `, replay #${c.correction.replayId}`}`
                        ) : c.correction.how === "no_longer_counted" ? (
                          "the ledger no longer counts this campaign-day; not a correction"
                        ) : c.correction.branchId !== null && c.correction.branchId !== exception.branchId ? (
                          `the campaign is mapped to ${c.correction.branchId} now; not a correction`
                        ) : (
                          "the counted revision changed; not a correction"
                        )}
                      </Td>
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
