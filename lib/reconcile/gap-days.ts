import { dateTime } from "@/lib/format";
import { dollars } from "@/lib/metrics/movement-copy";
import { CHANNEL_BY_CODE } from "@/lib/reference";
import { dateRanges, type GapCoverage, type GapDay, type GapDayRecord } from "./gap-coverage";

/**
 * A coverage gap's decision window, one date at a time, in words: what the system received for
 * the date, why it did or did not count, and what would clear it. Built only from the window's
 * accepted records (`GapCoverage.days`); it decides nothing (the hold is the incident's status) and
 * computes no verdict. Pure, so the strip on the incident page and its tests read the same text.
 *
 * Three marks, each with a word beside it, never colour alone:
 *   verified  the date has the channel's spend at the branch (more than $0.00);
 *   missing   no record of the channel at the branch (its spend may be filed elsewhere);
 *   zero      the only record says $0.00, which is not spend.
 */

export type DayMark = "verified" | "missing" | "zero";

export interface DayEvidence {
  date: string;
  dayOfMonth: number;
  /** "Tue, Oct 13" */
  long: string;
  mark: DayMark;
  /** The mark in words: "Verified", "No record", "Recorded $0.00". */
  stateLabel: string;
  /** Unresolved: not verified, or verified while successor spend that day is still filed elsewhere. */
  unresolved: boolean;
  /** For assistive technology, one sentence: the date, its state and where its spend is. */
  ariaLabel: string;
  /** What the system received for the date: each accepted record, or that nothing arrived. */
  received: Array<{ text: string; rawEventId: number | null }>;
  /** Why it counts, or why it does not. */
  why: string;
  /** What clears it; for a verified date, that nothing is left. */
  clears: string;
}

const MARK_LABEL: Record<DayMark, string> = { verified: "Verified", missing: "No record", zero: "Recorded $0.00" };
const channelName = (code: string) => CHANNEL_BY_CODE.get(code as never)?.label ?? code;
const longDate = (date: string) => new Date(`${date}T00:00:00Z`).toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric", timeZone: "UTC" });

/** "pmax-lsa-B09: $106.48, fetched Oct 15, 6:00 AM UTC, run #412 (ads@1.0)" */
function recordText(r: GapDayRecord, filedAs: string): string {
  const run = r.runId === null ? "stored without a run" : `run #${r.runId}`;
  return `${r.externalCampaignId}: ${dollars(r.cents)} filed as ${filedAs}, fetched ${dateTime(r.fetchedAt)}, ${run}${r.adapterVersion ? ` (${r.adapterVersion})` : ""}`;
}

/** Where a misfiled record sits, in words: "Google Search", or "Google Local Services at B13". */
function filedWhere(r: GapDayRecord, branchId: string): string {
  return r.branchId === branchId ? channelName(r.channel) : `${channelName(r.channel)} at ${r.branchId ?? "no branch"}`;
}

export function dayEvidence(day: GapDay, ctx: { branchId: string; channelLabel: string }): DayEvidence {
  const { branchId, channelLabel } = ctx;
  const mark: DayMark = day.state === "covered" ? "verified" : day.state;
  const misfiled = day.misfiled;
  const elsewhere = [...new Set(misfiled.map((m) => filedWhere(m, branchId)))].join(" and ");
  const received = [
    ...day.records.map((r) => ({ text: recordText(r, channelLabel), rawEventId: r.rawEventId })),
    ...misfiled.map((m) => ({ text: recordText(m, filedWhere(m, branchId)), rawEventId: m.rawEventId })),
  ];
  const mappers = [...new Set(misfiled.map((m) => m.adapterVersion).filter((v): v is string => Boolean(v)))];

  let why: string;
  let clears: string;
  if (mark === "verified" && misfiled.length === 0) {
    why = `It counts: ${channelLabel} spend at ${branchId} on this date.`;
    clears = "Nothing is left for this date.";
  } else if (mark === "verified") {
    why = `${channelLabel} has spend here, but more of the successor's spend that day is filed as ${elsewhere}, so the window is not reconciled.`;
    clears = `That spend filed as ${channelLabel} at ${branchId}.`;
  } else if (mark === "zero") {
    why = "The record says $0.00. A recorded zero is not spend, and the window needs spend on every date.";
    clears = "A revision of this date with spend above $0.00.";
  } else if (misfiled.length > 0) {
    why = `Its spend is filed as ${elsewhere}, not ${channelLabel}, so ${channelLabel} has no record for this date.${mappers.length ? ` The mapper that filed it (${mappers.join(", ")}) read the campaign that way.` : ""}`;
    clears = `A record of this date filed as ${channelLabel} at ${branchId}: re-sent by the source, or re-mapped in Fix & approval.`;
  } else {
    why = `Nothing for ${channelLabel} at ${branchId} arrived for this date.`;
    clears = `A ${channelLabel} record of this date from the source.`;
  }
  if (received.length === 0) received.push({ text: `No spend record for ${channelLabel} at ${branchId}, and none filed elsewhere.`, rawEventId: null });

  const long = longDate(day.date);
  return {
    date: day.date,
    dayOfMonth: Number(day.date.slice(8, 10)),
    long,
    mark,
    stateLabel: MARK_LABEL[mark],
    unresolved: mark !== "verified" || misfiled.length > 0,
    ariaLabel: `${long}: ${mark === "verified" ? `${channelLabel} spend recorded` : mark === "zero" ? "recorded $0.00, not spend" : `no ${channelLabel} record`}${misfiled.length ? `; spend filed as ${elsewhere}` : ""}`,
    received,
    why,
    clears,
  };
}

/**
 * Sentry's rule for the default selection: the first unresolved date. With none left, no date opens
 * by itself: there is nothing to explain, and what moved takes the first screen instead.
 */
export const defaultDay = (days: DayEvidence[]): string | null => days.find((d) => d.unresolved)?.date ?? null;

export interface WindowFacts {
  counts: Record<DayMark, number>;
  /** The decision window, as the incident requires it. */
  window: { label: string; total: number; verified: number; complete: boolean; openLabel: string };
  /** The week the reader picked on the Overview, read against the same dates; null when none was picked or it misses the window. */
  week: { label: string; total: number; verified: number; complete: boolean } | null;
}

/**
 * The two facts the incident sets side by side: the selected week (a viewing filter) and the
 * decision window (the rule). A covered week inside an incomplete window must read as both.
 */
export function windowFacts(c: GapCoverage, week: { start: string; end: string } | null): WindowFacts {
  const counts: Record<DayMark, number> = { verified: 0, missing: 0, zero: 0 };
  for (const d of c.days) counts[d.state === "covered" ? "verified" : d.state] += 1;
  const open = c.days.filter((d) => d.state !== "covered").map((d) => d.date);
  const inWeek = week ? c.days.filter((d) => d.date >= week.start && d.date <= week.end) : [];
  const weekVerified = inWeek.filter((d) => d.state === "covered" && d.misfiled.length === 0).length;
  return {
    counts,
    window: { label: dateRanges(c.required.length ? c.required : [c.window.from]), total: c.required.length, verified: c.covered.length, complete: c.complete, openLabel: dateRanges(open) },
    week: inWeek.length ? { label: dateRanges(inWeek.map((d) => d.date)), total: inWeek.length, verified: weekVerified, complete: weekVerified === inWeek.length } : null,
  };
}
