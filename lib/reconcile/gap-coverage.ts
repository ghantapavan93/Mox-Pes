import type { Queryable } from "@/lib/db";

/**
 * What a channel coverage gap (lib/reconcile/reconcile.ts, rule 6) requires before it may clear,
 * and what the accepted source records show now. One computation for reconciliation, the incident
 * page and Decision Lab, so none of them can disagree about it.
 *
 * Two scopes, deliberately apart:
 *   correction scope    what a delivery re-sent (a re-fetch of some dates, a re-map of others);
 *   verification scope  the incident's required dates, for its branch and channel:
 *     from  the gap's start, or its successor campaign's first spend when that came later. Rule 6
 *           counts a successor that starts up to a week after the stop as the same migration, so
 *           the days between are its transition: no record in either campaign. They are listed,
 *           not required; no correction could supply them.
 *     to    the spend feed's latest date, while the incident is open. Once verified, the window
 *           is the one that was verified and does not grow: a later feed day is not a regression.
 *   The incident's anchor (the channel's last spend date when it was detected) never moves, so
 *   neither does its identity.
 *
 * A required date is covered when the branch has spend in the channel that day: more than $0.00,
 * the definition the detector itself uses. A date with no record is missing, never $0.00; a record
 * of $0.00 is listed apart. Successor spend in the window that is filed under another channel, or
 * at another branch, is misfiled. The gap is verified only when every required date is covered and
 * nothing is misfiled. A successful delivery proves neither.
 *
 * Reads only accepted records (ad_spend_daily, the newest version of each campaign-day) and their
 * lineage: the raw event, the ingestion run that delivered it, the source's fetch time and the
 * mapper version that filed it.
 */

export interface GapRun {
  /** The ingestion run that delivered these records (null: stored before runs were recorded, or by a replay). */
  runId: number | null;
  adapterVersion: string;
  /** The source's fetch times of the accepted versions (its revision stamps). */
  fetchedAt: { first: string | null; last: string | null };
  dates: string[];
  cents: number;
}

export interface GapCoverage {
  branchId: string;
  channel: string;
  channelLabel: string;
  lastSpendDate: string;
  /** The verification scope (inclusive). Frozen at the verified window once the incident was verified. */
  window: { from: string; to: string };
  /** True when the window is the stored verified one, not the feed's latest date. */
  frozen: boolean;
  /** Days between the stop and the successor's first spend: the transition, not required. */
  transition: string[];
  required: string[];
  covered: string[];
  missing: string[];
  recordedZero: string[];
  misfiled: Array<{ date: string; externalCampaignId: string; channel: string; branchId: string | null; cents: number }>;
  /** The accepted records behind the covered dates, by the run that delivered them. */
  runs: GapRun[];
  coveredCents: number;
  misfiledCents: number;
  complete: boolean;
  /**
   * Covered dates whose accepted revision changed the amount of the revision it replaced: a
   * correction that restated money, not only its channel. Empty when every covered date kept its
   * amount, which is what "reclassified, not added" needs (HOLD-TO-DECISION.md, scenario 6).
   */
  amountChanges: Array<{ date: string; externalCampaignId: string; beforeCents: number; afterCents: number }>;
}

/** What reconciliation stores when it verifies a gap. */
export interface StoredVerification {
  verifiedAt: string;
  window: { from: string; to: string };
  requiredDates: number;
  coveredDates: number;
  coveredCents: number;
  runs: GapRun[];
  rule: string;
}

interface Row {
  date: string;
  external_campaign_id: string;
  campaign_id: string;
  channel_code: string;
  cost_cents: string;
  branch_id: string | null;
  run_id: string | null;
  fetched_at: string | null;
  adapter_version: string | null;
  replaced_cents: string | null;
}

const addDays = (date: string, n: number) => new Date(Date.parse(`${date}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

function datesBetween(from: string, to: string): string[] {
  const out: string[] = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

const isoDate = (v: unknown) => (typeof v === "string" && /^\d{4}-\d{2}-\d{2}/.test(v) ? v.slice(0, 10) : null);

/** Coverage of one coverage-gap exception's window, from its stored evidence. Null when the evidence names no anchor. */
export async function gapCoverage(db: Queryable, evidence: Record<string, unknown>, branchId: string): Promise<GapCoverage | null> {
  const channel = typeof evidence.channel === "string" ? evidence.channel : null;
  const lastSpendDate = isoDate(evidence.lastSpendDate);
  if (!channel || !lastSpendDate) return null;
  const successorRefs = (evidence.successors as Array<{ campaignId?: number; firstSpendDate?: string }> | null) ?? [];
  const successors = successorRefs.map((s) => Number(s.campaignId)).filter((n) => Number.isFinite(n));
  const gapStart = addDays(lastSpendDate, 1);
  // The transition: a successor that started after the gap's start had no day before it to re-file.
  const firstSuccessorSpend = successorRefs.map((s) => isoDate(s.firstSpendDate)).filter((d): d is string => d !== null).sort()[0] ?? null;
  const from = firstSuccessorSpend && firstSuccessorSpend > gapStart ? firstSuccessorSpend : gapStart;
  const verifiedTo = isoDate((evidence.verification as StoredVerification | undefined)?.window?.to);
  // The detector's own reference: the newest date the spend feed delivered, for any campaign.
  const ref = (await db.query<{ d: string | null }>("select max(spend_date)::text as d from ad_spend_daily")).rows[0].d;
  const to = verifiedTo ?? ref ?? lastSpendDate;
  const transition = from > gapStart ? datesBetween(gapStart, addDays(from, -1)) : [];
  const required = to >= from ? datesBetween(from, to) : [];

  // The channel's records at the branch, and every successor record wherever it is mapped now.
  // replaced_cents: the amount of the revision this one replaced when it was delivered, the newest
  // the source had sent before it (by its own clock) that intake accepted. Null when there was none,
  // and for a record re-mapped in place (projected again after it arrived), since a re-map reads
  // the same payload and cannot change its amount.
  const { rows } = await db.query<Row>(
    `select s.spend_date::text as date, c.external_campaign_id, s.campaign_id, s.channel_code, s.cost_cents, m.branch_id,
            re.ingestion_run_id as run_id, re.payload ->> 'fetchedAt' as fetched_at, re.adapter_version, prev.cents as replaced_cents
     from ad_spend_daily s
     join ad_campaigns c on c.id = s.campaign_id
     left join campaign_branch_map m on m.campaign_id = s.campaign_id
     left join raw_events re on re.id = s.raw_event_id
     left join lateral (
       select case when p.payload ->> 'costMicros' ~ '^[0-9]{1,18}$' then div((p.payload ->> 'costMicros')::numeric + 5000, 10000)::bigint end as cents
       from raw_events p
       where p.source = re.source and p.entity = re.entity and p.entity_id = re.entity_id and p.id <> re.id
         and p.status = 'projected' and p.received_at < re.received_at and p.occurred_at < re.occurred_at
         and re.projected_at <= re.received_at + interval '1 second'
       order by p.occurred_at desc, p.id desc
       limit 1) prev on true
     where s.spend_date between $2::date and $3::date
       and ((m.branch_id = $1 and s.channel_code = $4) or s.campaign_id = any($5::bigint[]))
     order by s.spend_date, s.campaign_id`,
    [branchId, from, to, channel, successors],
  );

  const atBranch = (r: Row) => r.branch_id === branchId;
  const inChannel = rows.filter((r) => atBranch(r) && r.channel_code === channel);
  const spendByDate = new Map<string, number>();
  for (const r of inChannel) spendByDate.set(r.date, (spendByDate.get(r.date) ?? 0) + Number(r.cost_cents));
  const covered = required.filter((d) => (spendByDate.get(d) ?? 0) > 0);
  const recordedZero = required.filter((d) => spendByDate.has(d) && spendByDate.get(d) === 0);
  const missing = required.filter((d) => !spendByDate.has(d));
  const misfiled = rows
    .filter((r) => successors.includes(Number(r.campaign_id)) && Number(r.cost_cents) > 0 && (r.channel_code !== channel || !atBranch(r)))
    .map((r) => ({ date: r.date, externalCampaignId: r.external_campaign_id, channel: r.channel_code, branchId: r.branch_id, cents: Number(r.cost_cents) }));

  const coveredSet = new Set(covered);
  const byRun = new Map<string, GapRun>();
  for (const r of inChannel.filter((x) => coveredSet.has(x.date) && Number(x.cost_cents) > 0)) {
    const key = `${r.run_id ?? "none"}|${r.adapter_version ?? "unknown"}`;
    const run = byRun.get(key) ?? { runId: r.run_id === null ? null : Number(r.run_id), adapterVersion: r.adapter_version ?? "unknown", fetchedAt: { first: null, last: null }, dates: [], cents: 0 };
    if (!run.dates.includes(r.date)) run.dates.push(r.date);
    run.cents += Number(r.cost_cents);
    if (r.fetched_at) {
      if (!run.fetchedAt.first || r.fetched_at < run.fetchedAt.first) run.fetchedAt.first = r.fetched_at;
      if (!run.fetchedAt.last || r.fetched_at > run.fetchedAt.last) run.fetchedAt.last = r.fetched_at;
    }
    byRun.set(key, run);
  }
  const runs = [...byRun.values()].sort((a, b) => (a.dates[0] ?? "").localeCompare(b.dates[0] ?? "") || (a.runId ?? 0) - (b.runId ?? 0));
  const coveredCents = runs.reduce((t, r) => t + r.cents, 0);
  const misfiledCents = misfiled.reduce((t, m) => t + m.cents, 0);
  const amountChanges = inChannel
    .filter((r) => coveredSet.has(r.date) && r.replaced_cents !== null && Number(r.replaced_cents) !== Number(r.cost_cents))
    .map((r) => ({ date: r.date, externalCampaignId: r.external_campaign_id, beforeCents: Number(r.replaced_cents), afterCents: Number(r.cost_cents) }));
  return {
    branchId,
    channel,
    channelLabel: typeof evidence.channelLabel === "string" ? evidence.channelLabel : channel,
    lastSpendDate,
    window: { from, to },
    frozen: verifiedTo !== null,
    transition,
    required,
    covered,
    missing,
    recordedZero,
    misfiled,
    runs,
    coveredCents,
    misfiledCents,
    complete: required.length > 0 && covered.length === required.length && misfiled.length === 0,
    amountChanges,
  };
}

/** "Oct 13–Oct 25, Oct 28" from ISO dates: runs of consecutive days as ranges. */
export function dateRanges(dates: string[]): string {
  const label = (d: string) => new Date(`${d}T00:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
  const out: string[] = [];
  let start: string | null = null;
  let prev: string | null = null;
  for (const d of [...new Set(dates)].sort()) {
    if (start && prev && addDays(prev, 1) === d) {
      prev = d;
      continue;
    }
    if (start && prev) out.push(start === prev ? label(start) : `${label(start)}–${label(prev)}`);
    start = d;
    prev = d;
  }
  if (start && prev) out.push(start === prev ? label(start) : `${label(start)}–${label(prev)}`);
  return out.join(", ");
}

/** Distinct dates the runs carry (a date two campaigns cover is one date). */
export const runDates = (runs: GapRun[]) => new Set(runs.flatMap((r) => r.dates)).size;

/** The verification stored on the incident when its whole window is covered: what was verified, once per recovery. */
export function verificationOf(c: GapCoverage, at: Date): StoredVerification {
  return {
    verifiedAt: at.toISOString(),
    window: c.window,
    requiredDates: c.required.length,
    coveredDates: c.covered.length,
    coveredCents: c.coveredCents,
    runs: c.runs,
    rule: "every required date has spend in the channel at the branch, and no successor spend in the window is filed under another channel or at another branch",
  };
}

export const verifiedResolution = (c: GapCoverage) =>
  `Verified: all ${c.required.length} required dates (${dateRanges(c.required)}) have ${c.channelLabel} spend at ${c.branchId} in the accepted source records, from ${c.runs.length} delivery run(s); no successor spend in that window is filed under another channel or at another branch.`;
