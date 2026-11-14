import type { Queryable } from "@/lib/db";
import { dateTime } from "@/lib/format";
import { dollars } from "@/lib/metrics/movement-copy";
import { CHANNEL_BY_CODE } from "@/lib/reference";
import { dateRanges, gapCoverage, type GapCoverage, type StoredVerification } from "./gap-coverage";

/**
 * One coverage gap's decision status in words, for every view that shows it: the Overview's
 * "What changed", the daily evidence, the incident and Decision Lab. Built only from what the
 * incident stores (its status, its original finding, any verification) and from its window as the
 * accepted records cover it now (gapCoverage). It decides nothing: the hold is the incident's own
 * status, set by reconciliation (lib/reconcile/reconcile.ts, rules 6 and 6a). Pure, except
 * `gapStatusesAt`, which reads.
 *
 * Two scopes stay apart in every sentence:
 *   the decision window  the dates the incident requires before it clears (its verification scope);
 *   a selected week      a viewing filter from the Overview's chart, never the decision rule.
 * A date with no record is never $0.00: a recorded $0.00 is named apart.
 */

export type GapState = "missing" | "partial" | "verified" | "historical" | "resolved";

export interface GapStatus {
  exceptionId: number;
  /**
   * missing: open, no required date covered. partial: open, some covered. verified: resolved with a
   * stored verification the records still support. historical: resolved with a verification the
   * records no longer support. resolved: resolved without a verification (before rule 6a).
   */
  state: GapState;
  /** The incident is open: it holds the branch's budget decision. */
  held: boolean;
  branchId: string;
  channel: string;
  channelLabel: string;
  /** The decision window (inclusive), in words ("Oct 13–Oct 30"), and how many dates it requires. */
  window: { from: string; to: string; label: string; dates: number };
  covered: string[];
  /** Required dates with no record in the channel at the branch. */
  missing: string[];
  /** Required dates whose only record says $0.00. */
  recordedZero: string[];
  /** The covered and the open dates (no record, or $0.00) in words: "Oct 26–Oct 30". */
  coveredLabel: string;
  openLabel: string;
  verifiedAt: string | null;
  /** The successor spend the original finding recorded under another channel, as it was recorded. */
  original: { cents: number; filedAs: string; campaigns: string } | null;
  coveredCents: number;
  misfiledCents: number;
  /** Verified, nothing misfiled, and the window carries exactly the amount the original finding recorded elsewhere. */
  reclassified: boolean;
  /** "5 of 18 dates in the decision window (Oct 13–Oct 30) have …; Oct 13–Oct 25 still have none" (no capital, no stop). */
  progress: string;
  /** The state in plain words, for a label that does not rely on colour: "Decision still held". */
  label: string;
  /** The conclusion, one sentence: the label, then why. */
  conclusion: string;
  /** The conclusion without its label, as a sentence: for a line that shows the label apart. */
  statusText: string;
  /** The most useful before/after fact, one or two sentences; null when there is none. */
  change: string | null;
}

/** Plain words for the state, for a label that does not rely on colour. */
export const GAP_STATE_LABEL: Record<GapState, string> = {
  missing: "Decision held",
  partial: "Decision still held",
  verified: "Coverage hold cleared",
  historical: "Verification historical",
  resolved: "Resolved",
};

const channelName = (code: string) => CHANNEL_BY_CODE.get(code as never)?.label ?? code;
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const hasHave = (dates: string[]) => (dates.length === 1 ? "has" : "have");
const capital = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const unique = <T,>(items: T[]) => [...new Set(items)];

/** "Oct 13–Oct 30": the window's own dates (a range only collapses consecutive days). */
const windowLabel = (c: GapCoverage) => dateRanges(c.required.length ? c.required : [c.window.from]);

/** Where the successor spend in the window is filed instead: "as Google Search", "at B13". */
function misfiledWhere(c: GapCoverage): string {
  return list(unique(c.misfiled.map((m) => (m.branchId === c.branchId ? `as ${channelName(m.channel)}` : `at ${m.branchId ?? "no branch"}`))));
}

/** The open dates, a recorded $0.00 told apart from no record. */
function openPhrase(c: GapCoverage): string {
  if (c.recordedZero.length === 0) return `${dateRanges(c.missing)} still ${hasHave(c.missing)} none`;
  if (c.missing.length === 0) return `${dateRanges(c.recordedZero)} recorded $0.00`;
  return `${dateRanges(c.missing)} ${hasHave(c.missing)} no record and ${dateRanges(c.recordedZero)} recorded $0.00`;
}

/**
 * The decision window as the accepted records cover it now, in one clause. Decision Lab's
 * readiness reasons, the incident, the daily evidence and the Overview all use this one.
 */
export function windowProgress(c: GapCoverage): string {
  const n = c.required.length;
  const W = windowLabel(c);
  const where = `${c.channelLabel} spend at ${c.branchId}`;
  if (n === 0) return `the decision window has no required date yet`;
  const head =
    c.covered.length === n
      ? `all ${n} dates in the decision window (${W}) have ${where}`
      : c.covered.length === 0
        ? `none of the ${n} dates in the decision window (${W}) has ${where}`
        : `${c.covered.length} of ${n} dates in the decision window (${W}) have ${where}`;
  const open = c.missing.length + c.recordedZero.length;
  const tail =
    open === 0 || (c.covered.length === 0 && c.recordedZero.length === 0)
      ? ""
      : c.covered.length === 0
        ? `; ${dateRanges(c.recordedZero)} recorded $0.00 and the rest have no record`
        : `; ${openPhrase(c)}`;
  const misfiled = c.misfiled.length > 0 && open === 0 ? `, but ${dollars(c.misfiledCents)} of successor spend in it is still filed ${misfiledWhere(c)}` : "";
  return `${head}${tail}${misfiled}`;
}

/** The successor spend the incident recorded under another channel when it was detected (its evidence). */
function originalFinding(evidence: Record<string, unknown>, channel: string): GapStatus["original"] {
  const successors = (evidence.successors as Array<{ externalCampaignId?: unknown; spendSinceGapCents?: unknown; classifiedAs?: unknown }> | null) ?? [];
  const filed = successors.filter((s) => Array.isArray(s.classifiedAs) && (s.classifiedAs as string[]).some((ch) => ch !== channel) && Number(s.spendSinceGapCents) > 0);
  if (filed.length === 0) return null;
  return {
    cents: filed.reduce((t, s) => t + Number(s.spendSinceGapCents), 0),
    filedAs: list(unique(filed.flatMap((s) => (s.classifiedAs as string[]).filter((ch) => ch !== channel))).map(channelName)),
    campaigns: list(unique(filed.map((s) => String(s.externalCampaignId)))),
  };
}

/** What the window carries now, part by part: re-filed, still filed elsewhere, no record, a recorded $0.00. */
function nowParts(c: GapCoverage): string[] {
  const misfiledDates = unique(c.misfiled.map((m) => m.date)).sort();
  const elsewhere = new Set(misfiledDates);
  const noRecord = c.missing.filter((d) => !elsewhere.has(d));
  const zero = c.recordedZero.filter((d) => !elsewhere.has(d));
  return [
    c.coveredCents > 0 ? `${dollars(c.coveredCents)} (${dateRanges(c.covered)}) is filed as ${c.channelLabel}` : "",
    c.misfiled.length > 0 ? `${dollars(c.misfiledCents)} (${dateRanges(misfiledDates)}) is still filed ${misfiledWhere(c)}` : "",
    noRecord.length > 0 ? `${dateRanges(noRecord)} ${hasHave(noRecord)} no ${c.channelLabel} record` : "",
    zero.length > 0 ? `${dateRanges(zero)} recorded $0.00` : "",
  ].filter(Boolean);
}

/** One coverage-gap incident's status, from the incident and its coverage now. */
export function gapStatus(e: { id: number; status: string; evidence: Record<string, unknown>; resolution?: string | null }, c: GapCoverage): GapStatus {
  const held = e.status !== "resolved";
  const verification = (e.evidence.verification as StoredVerification | undefined) ?? null;
  const state: GapState = held ? (c.covered.length > 0 ? "partial" : "missing") : verification ? (c.complete ? "verified" : "historical") : "resolved";
  const original = originalFinding(e.evidence, c.channel);
  const reclassified = state === "verified" && original !== null && c.misfiled.length === 0 && c.coveredCents === original.cents;
  const progress = windowProgress(c);
  const verifiedAt = verification?.verifiedAt ?? null;

  // The conclusion is the label, then why; the body alone serves a line that shows the label apart.
  const body =
    state === "missing"
      ? progress
      : state === "partial"
        ? c.complete
          ? `${progress}; it clears once reconciliation verifies it`
          : progress
        : state === "verified"
          ? `${progress}, verified ${dateTime(verifiedAt)}`
          : state === "historical"
            ? `verified ${dateTime(verifiedAt)}, but now ${progress}`
            : (e.resolution ?? "condition no longer detected").replace(/\.$/, "");
  const label = GAP_STATE_LABEL[state];
  const conclusion = `${label}: ${body}.`;

  const misfiledCampaigns = list(unique(c.misfiled.map((m) => m.externalCampaignId)));
  let change: string | null = null;
  if (state === "missing") {
    change =
      c.misfiled.length > 0
        ? `Since ${dateRanges([c.window.from])}, ${dollars(c.misfiledCents)} has been spent under ${misfiledCampaigns}, which is filed ${misfiledWhere(c)}; none of it is filed as ${c.channelLabel}.`
        : original
          ? `The original finding recorded ${dollars(original.cents)} under ${original.campaigns}, filed as ${original.filedAs}; no record covers the window now.`
          : null;
  } else if (state === "partial" || state === "historical") {
    const now = nowParts(c);
    change = `${original ? `Originally ${dollars(original.cents)} was filed as ${original.filedAs}. ` : ""}${now.length ? `Now ${now.join("; ")}.` : ""}`.trim() || null;
  } else if (state === "verified") {
    change = reclassified
      ? `Reclassified, not added: the ${dollars(original!.cents)} first filed as ${original!.filedAs} is now filed as ${c.channelLabel}.`
      : original
        ? `The window now carries ${dollars(c.coveredCents)} filed as ${c.channelLabel}; the original finding recorded ${dollars(original.cents)} filed as ${original.filedAs}.`
        : `The window carries ${dollars(c.coveredCents)} filed as ${c.channelLabel}.`;
  }

  return {
    exceptionId: e.id,
    state,
    held,
    branchId: c.branchId,
    channel: c.channel,
    channelLabel: c.channelLabel,
    window: { from: c.window.from, to: c.window.to, label: windowLabel(c), dates: c.required.length },
    covered: c.covered,
    missing: c.missing,
    recordedZero: c.recordedZero,
    coveredLabel: dateRanges(c.covered),
    openLabel: dateRanges([...c.missing, ...c.recordedZero]),
    verifiedAt,
    original,
    coveredCents: c.coveredCents,
    misfiledCents: c.misfiledCents,
    reclassified,
    progress,
    label,
    conclusion,
    statusText: `${capital(body)}.`,
    change,
  };
}

/**
 * A selected week (the Overview's viewing filter) against the decision window, in one or two
 * sentences: the two are never the same thing. Null for an incident without a window to speak of.
 */
export function weekAgainstWindow(s: GapStatus, week: { start: string; end: string }): string | null {
  if (s.state === "resolved" || s.window.dates === 0) return null;
  const W = s.window.label;
  if (week.end < s.window.from || week.start > s.window.to) return `This week is outside the decision window (${W}).`;
  if (s.state === "verified") return `The decision window (${W}) has ${s.channelLabel} spend on all ${s.window.dates} dates, verified ${dateTime(s.verifiedAt)}.`;
  const stays = s.held ? " The decision stays held." : "";
  const open = [...s.missing, ...s.recordedZero].sort();
  if (open.length === 0) return `${capital(s.progress)}.${stays}`;
  const openHere = open.filter((d) => d >= week.start && d <= week.end);
  if (openHere.length === 0) return `This week's dates in the decision window are covered, but the window (${W}) is not: ${dateRanges(open)} still ${hasHave(open)} no ${s.channelLabel} spend.${stays}`;
  if (s.covered.length === 0) return `None of the ${s.window.dates} dates in the decision window (${W}) has ${s.channelLabel} spend, this week's included.${stays}`;
  return `The decision window (${W}) has ${s.channelLabel} spend on ${s.covered.length} of ${s.window.dates} dates; ${dateRanges(open)} still ${hasHave(open)} none, ${openHere.length === open.length ? "all of them" : dateRanges(openHere)} in this week.${stays}`;
}

/**
 * The coverage-gap incidents at one branch as statuses: every open one, and every resolved one with a
 * stored verification. `ids` narrows to those incidents; `range` keeps resolved ones whose verified
 * window overlaps it (an open one always counts: it holds the decision whatever the period). Read
 * one at a time, since `db` may be one transaction client. The caller has checked the branch is in
 * the viewer's scope.
 */
export async function gapStatusesAt(db: Queryable, branchId: string, opts: { ids?: number[]; range?: { from: string; to: string } } = {}): Promise<GapStatus[]> {
  const { rows } = await db.query<{ id: string; status: string; evidence: Record<string, unknown>; resolution: string | null }>(
    `select id, status, evidence, resolution from exceptions
     where kind = 'channel_coverage_gap' and branch_id = $1
       and ($2::bigint[] is null or id = any($2::bigint[]))
       and (status <> 'resolved'
            or (evidence ? 'verification'
                and ($3::date is null or (evidence #>> '{verification,window,to}')::date >= $3::date)
                and ($4::date is null or (evidence #>> '{verification,window,from}')::date < $4::date)))
     order by id`,
    [branchId, opts.ids ?? null, opts.range?.from ?? null, opts.range?.to ?? null],
  );
  const out: GapStatus[] = [];
  for (const r of rows) {
    const coverage = await gapCoverage(db, r.evidence, branchId);
    if (coverage) out.push(gapStatus({ id: Number(r.id), status: r.status, evidence: r.evidence, resolution: r.resolution }, coverage));
  }
  return out;
}
