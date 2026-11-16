import Link from "next/link";
import { ButtonLink, Callout, Card, TableWrap, Td, Th } from "@/components/ui";
import { dateTime } from "@/lib/format";
import { dollars, shortDay } from "@/lib/metrics/movement-copy";
import type { Marker, SpendDay } from "@/lib/metrics/movement";
import { dateRanges } from "@/lib/reconcile/gap-coverage";
import { weekAgainstWindow, type GapStatus } from "@/lib/reconcile/gap-status";
import { refusalReason } from "@/lib/reconcile/refused-revisions";

/** "Mon, Oct 19" (UTC). */
const dayName = (isoDate: string) => new Date(`${isoDate}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** The last day of a selected week that the evidence lists (the window can cut a week short). */
export const selectionEnd = (week: string, days: SpendDay[]) => days[days.length - 1]?.date ?? week;

/**
 * The drillthrough target of one point on the Overview's "What changed" chart: the stored spend
 * records of one channel, one week, one branch, day by day — a day without a record says so, and a
 * recorded $0.00 says that. The page's heading names the selected dates; this card leads with what
 * they show, and, when the channel has a coverage gap, how the week stands against the incident's
 * decision window (lib/reconcile/gap-status.ts): a complete week is not a complete window. Then the
 * records, then one action: the incident. It says what the records do not establish.
 */
export function OverviewSelection({
  branchId,
  channel,
  channelLabel,
  week,
  days,
  markers,
  recoveries,
  incidentQuery,
}: {
  branchId: string;
  channel: string;
  channelLabel: string;
  week: string;
  days: SpendDay[];
  markers: Marker[];
  /** The status of the channel's coverage gaps that are open or were verified (selectionEvidence). */
  recoveries: GapStatus[];
  /** The selection (period, channel, week), carried to the incident so it can send the reviewer back here. */
  incidentQuery: string;
}) {
  const withRecord = days.filter((d) => d.records.length > 0);
  const total = withRecord.reduce((t, d) => t + d.records.reduce((s, r) => s + r.cents, 0), 0);
  const end = selectionEnd(week, days);
  const missing = days.length - withRecord.length;
  const recorded = total === 0 ? "every one reports $0.00, a recorded zero" : `${dollars(total)} in all`;
  // Days whose counted record rests on an earlier revision because a newer one was refused: the
  // amount shown is the one counted, never the refused one, and the decision is held.
  const refusedDays = withRecord.filter((d) => d.records.some((r) => r.refused.length > 0)).map((d) => d.date);
  const hold = withRecord.flatMap((d) => d.records.flatMap((r) => r.refused)).find((x) => x.exceptionId !== null)?.exceptionId ?? null;
  const summary =
    withRecord.length === 0
      ? `No day of this week has a spend record for ${channelLabel} at ${branchId}. That is no record, not $0.`
      : missing === 0
        ? `All ${days.length} days have a spend record: ${recorded}.`
        : `${withRecord.length} of ${days.length} days ${withRecord.length === 1 ? "has" : "have"} a spend record (${recorded}); the other ${missing} ${missing === 1 ? "has" : "have"} none, which is not the same as $0.`;
  const refusedNote =
    refusedDays.length > 0
      ? `${dateRanges(refusedDays)} ${refusedDays.length === 1 ? "rests" : "rest"} on an earlier revision: the source sent a newer one and intake refused it, so the amount shown is the one still counted, and the budget decision that reads ${refusedDays.length === 1 ? "it" : "them"} is held${hold ? ` (incident #${hold})` : ""}.`
      : null;
  // The incident whose decision window this week is read against: an open one first (it holds the
  // decision), else a verified one. Another marked incident keeps its stored-finding note.
  const status = recoveries.find((r) => r.held) ?? recoveries.find((r) => r.state === "verified" || r.state === "historical") ?? null;
  const windowNote = status ? weekAgainstWindow(status, { start: week, end }) : null;
  const others = markers.filter((m) => m.channel === channel && m.date <= end && m.exceptionId !== status?.exceptionId);

  return (
    <Card id="selection" title="Daily records" subtitle={`${branchId} · the stored paid media spend records behind the point selected on the Overview`}>
      <div className="space-y-3" data-testid="overview-selection" data-channel={channel} data-week={week}>
        <div className="space-y-1.5">
          <p className="text-sm font-medium text-text" data-testid="selection-summary">
            {summary}
          </p>
          {refusedNote && (
            <p className="border-l-2 border-bad pl-2.5 text-sm font-medium text-text" data-testid="selection-refused">
              {refusedNote}
            </p>
          )}
          {windowNote && (
            <p className="border-l-2 border-border-strong pl-2.5 text-sm text-text" data-testid="selection-window">
              {windowNote}
            </p>
          )}
        </div>
        {/* Three columns that fit a 320 px phone: the amount, or "no spend record", sits beside the
            day in one column, so a recorded $0.00 and a missing day are told apart without
            scrolling the table sideways. Headers stay one short word (they do not wrap), and the
            campaign cell may break inside a long name or id. */}
        <TableWrap label="Spend records for the selected week" minWidth={0}>
          <thead>
            <tr>
              <Th>Day</Th>
              <Th align="right">Spend</Th>
              <Th>Campaign</Th>
            </tr>
          </thead>
          <tbody data-testid="selection-days">
            {days.flatMap((d) =>
              d.records.length === 0
                ? [
                    <tr key={d.date} data-day={d.date} data-record="none" className="border-t border-border">
                      <Td className="whitespace-nowrap tabular-nums">{dayName(d.date)}</Td>
                      <Td align="right" className="text-warn">no spend record</Td>
                      <Td className="text-faint">—</Td>
                    </tr>,
                  ]
                : d.records.map((r) => (
                    <tr key={`${d.date}-${r.externalCampaignId}`} data-day={d.date} data-record="present" data-zero={r.cents === 0} data-refused={r.refused.length > 0} className="border-t border-border">
                      <Td className="whitespace-nowrap tabular-nums">{dayName(d.date)}</Td>
                      <Td align="right" className="tabular-nums">
                        <span className="whitespace-nowrap">{dollars(r.cents)}</span>
                        {r.cents === 0 && <span className="block whitespace-nowrap text-xs text-muted">recorded zero</span>}
                        {r.refused.length > 0 && <span className="block whitespace-nowrap text-xs font-medium text-bad">counted · newer revision refused</span>}
                      </Td>
                      <Td className="[overflow-wrap:anywhere]">
                        <span className="font-medium">{r.externalCampaignId}</span>
                        <span className="block text-xs text-muted">
                          {r.name} · {r.platform} · <span className="font-mono">raw #{r.rawEventId}</span>
                        </span>
                        {r.refused.map((x) => (
                          <span key={x.rawEventId} className="mt-1 block text-xs text-text" data-testid="selection-refused-revision">
                            Refused, not counted: a newer revision fetched {dateTime(x.fetchedAt)}
                            {x.cents === null ? "" : ` said ${dollars(x.cents)}`}, because {refusalReason(x)} <span className="font-mono">(raw #{x.rawEventId})</span>.
                            {x.exceptionId !== null && (
                              <>
                                {" "}
                                <Link href={`/exceptions/${x.exceptionId}${incidentQuery}#recovery`} className="font-medium text-accent underline" data-testid="selection-refused-link">
                                  Hold: incident #{x.exceptionId}
                                </Link>
                              </>
                            )}
                          </span>
                        ))}
                      </Td>
                    </tr>
                  )),
            )}
          </tbody>
        </TableWrap>
        {/* One primary: the incident that holds the decision this week (a refused revision first,
            since it holds even when the coverage gap cleared), then the coverage gap's record. */}
        {hold !== null && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3" data-testid="selection-hold">
            <ButtonLink href={`/exceptions/${hold}${incidentQuery}#recovery`} variant="primary" testId="selection-hold-link">
              Open incident #{hold}
            </ButtonLink>
            <span className="text-sm text-muted">The hold: the refused revision beside the one still counted, and what lifts it.</span>
          </div>
        )}
        {status && (
          <div className="flex flex-wrap items-center gap-x-3 gap-y-2 border-t border-border pt-3" data-testid="selection-incident">
            <ButtonLink href={`/exceptions/${status.exceptionId}${incidentQuery}#recovery`} variant={hold !== null ? "secondary" : "primary"} testId="selection-incident-link">
              Open incident #{status.exceptionId}
            </ButtonLink>
            <span className="text-sm text-muted">
              {status.held ? "The coverage gap's record: which dates still need spend, and what a correction changed." : "The coverage gap's record: what was verified, and what the correction changed."}
            </span>
          </div>
        )}
        {others.map((m) => (
          <Callout key={m.exceptionId} tone={m.status === "open" ? "warn" : "info"} title={`Incident #${m.exceptionId} (${m.status}) records a coverage gap here from ${shortDay(m.date)}`} testId="selection-incident">
            {m.successors.length > 0
              ? `Its stored evidence: ${m.successors.map((s) => `${s.externalCampaignId} carries ${dollars(s.spendSinceCents)} since ${shortDay(s.firstSpendDate ?? m.date)}${s.classifiedAs.length ? `, filed as ${s.classifiedAs.join(" and ")}` : ""}`).join("; ")}.`
              : "Its stored evidence names no successor campaign."}{" "}
            <Link href={`/exceptions/${m.exceptionId}${incidentQuery}#recovery`} className="font-medium text-accent underline" data-testid="selection-incident-link">
              Open incident #{m.exceptionId}
            </Link>
          </Callout>
        ))}
        <p className="text-xs leading-5 text-muted" data-testid="selection-limits">
          What these records do not establish: why a campaign stopped or started, whether the money moved, or which customers a channel produced. The whole period&apos;s campaigns, with their mapping, are listed below.
        </p>
      </div>
    </Card>
  );
}
