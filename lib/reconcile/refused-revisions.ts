import type { Queryable } from "@/lib/db";
import { dateTime } from "@/lib/format";
import { dollars } from "@/lib/metrics/movement-copy";
import { CHANNEL_BY_CODE } from "@/lib/reference";
import { dateRanges } from "./gap-coverage";

/**
 * A newer spend revision the active mapper refused (docs/agent-work/HOLD-TO-DECISION.md; R-54).
 *
 * The source sends a new revision of a campaign-day; intake refuses it (fractional conversions,
 * another currency). The ledger keeps the revision it already counts, so the amount does not move,
 * but the source no longer stands behind it: the budget decision that reads that campaign-day is
 * held for the campaign's branch, for the period that contains the date, until a newer revision is
 * accepted or the refused one is.
 *
 * Which records these are is decided once, in SQL (migration 0034, v_refused_spend_revisions:
 * identity from the record's platform, campaign id and date; order from the source's fetch time).
 * Reconciliation files them as the branch's quarantine incident (rule 1) with each revision in its
 * evidence; this module reads that evidence for the gate, Decision Lab, the incident and the daily
 * evidence, and phrases it. It decides nothing itself.
 *
 * Four facts stay apart in every sentence: the accepted amount (what the ledger counts), whether
 * the evidence is complete (the source's newest revision is the counted one), whether the decision
 * may be reviewed, and whether spend caused anything (never claimed here).
 */

/**
 * One held campaign-day: its newest refused revision beside the revision the ledger counts for it.
 * The source re-fetches recent days, so one campaign-day can be refused many times; it is still one
 * entry, with one counted amount, and every refused delivery is kept in `refusedRawEventIds`
 * (EGM review 2026-11-18, K1).
 */
export interface RefusedRevision {
  /** The newest refused revision of the campaign-day. */
  rawEventId: number;
  /** Every refused delivery of the campaign-day, oldest fetch first; it includes `rawEventId`. */
  refusedRawEventIds: number[];
  campaignId: number;
  externalCampaignId: string;
  platform: string;
  /** The campaign-day's date (ISO). */
  date: string;
  /** The counted revision's channel. */
  channel: string;
  errorDetail: string | null;
  refusedFetchedAt: string;
  refusedRunId: number | null;
  /** What the refused revision said, never counted; null when its amount is unreadable. */
  refusedCents: number | null;
  acceptedRawEventId: number;
  acceptedFetchedAt: string;
  acceptedRunId: number | null;
  /** What the ledger counts for the campaign-day: the last accepted amount. */
  acceptedCents: number;
}

/** How a refused revision stopped holding the decision. */
export interface RevisionCorrection extends RefusedRevision {
  correction: {
    /**
     * newer_accepted: the source sent a newer revision and intake accepted it.
     * accepted_itself: the refused revision is now accepted (a replay through a mapper that takes it).
     * no_longer_counted: the ledger counts no revision of the campaign-day any more.
     * other: the counted revision or the campaign's mapping changed in another way.
     */
    how: "newer_accepted" | "accepted_itself" | "no_longer_counted" | "other";
    rawEventId: number | null;
    runId: number | null;
    replayId: number | null;
    fetchedAt: string | null;
    /** What the ledger counts now; null when it counts nothing. */
    cents: number | null;
    branchId: string | null;
    at: string;
  };
}

const num = (v: unknown) => (v === null || v === undefined || v === "" ? null : Number(v));
const str = (v: unknown) => (typeof v === "string" ? v : v === null || v === undefined ? null : String(v));

/** The identity of a held campaign-day: the campaign the ledger counts, and the date. */
export const dayKey = (r: Pick<RefusedRevision, "campaignId" | "date">) => `${r.campaignId}|${r.date}`;

function parseRevision(v: Record<string, unknown>): RefusedRevision | null {
  const rawEventId = num(v.rawEventId);
  const date = str(v.date);
  if (rawEventId === null || !date) return null;
  // Evidence stored before 2026-11-18 has one entry per refused delivery and no list of them.
  const deliveries = Array.isArray(v.refusedRawEventIds) ? v.refusedRawEventIds.map(Number).filter(Number.isFinite) : [];
  return {
    rawEventId,
    refusedRawEventIds: deliveries.length > 0 ? deliveries : [rawEventId],
    campaignId: Number(v.campaignId),
    externalCampaignId: String(v.externalCampaignId),
    platform: String(v.platform),
    date: date.slice(0, 10),
    channel: String(v.channel),
    errorDetail: str(v.errorDetail),
    refusedFetchedAt: String(v.refusedFetchedAt),
    refusedRunId: num(v.refusedRunId),
    refusedCents: num(v.refusedCents),
    acceptedRawEventId: Number(v.acceptedRawEventId),
    acceptedFetchedAt: String(v.acceptedFetchedAt),
    acceptedRunId: num(v.acceptedRunId),
    acceptedCents: Number(v.acceptedCents),
  };
}

/** Newer first: the source's fetch time, then the later delivery. */
const newer = (a: RefusedRevision, b: RefusedRevision) => b.refusedFetchedAt.localeCompare(a.refusedFetchedAt) || b.rawEventId - a.rawEventId;

/**
 * The campaign-days a quarantine incident holds the decision on, one entry each, oldest date first;
 * [] for any other incident. Entries for the same campaign-day (evidence stored one per refused
 * delivery) are merged: the newest refusal speaks for the day, and every delivery is kept.
 */
export function revisionsOf(evidence: Record<string, unknown> | null | undefined): RefusedRevision[] {
  const list = evidence?.revisions;
  if (!Array.isArray(list)) return [];
  const byDay = new Map<string, RefusedRevision[]>();
  for (const r of list.map((v) => parseRevision(v as Record<string, unknown>))) {
    if (r) byDay.set(dayKey(r), [...(byDay.get(dayKey(r)) ?? []), r]);
  }
  return [...byDay.values()]
    .map((entries) => {
      const [newest] = [...entries].sort(newer);
      const deliveries = [...entries].sort((a, b) => -newer(a, b)).flatMap((e) => e.refusedRawEventIds);
      return { ...newest, refusedRawEventIds: [...new Set(deliveries)] };
    })
    .sort((a, b) => a.date.localeCompare(b.date) || a.campaignId - b.campaignId);
}

/** The campaign-days of this incident that stopped holding, and how. Each lift is kept once. */
export function correctionsOf(evidence: Record<string, unknown> | null | undefined): RevisionCorrection[] {
  const list = evidence?.corrected;
  if (!Array.isArray(list)) return [];
  const out: RevisionCorrection[] = [];
  const seen = new Set<string>();
  for (const v of list as Array<Record<string, unknown>>) {
    const r = parseRevision(v);
    const c = v.correction as Record<string, unknown> | undefined;
    if (!r || !c) continue;
    // Evidence stored one entry per refused delivery recorded one lift per delivery: the same lift.
    const lift = `${dayKey(r)}|${String(c.how)}|${String(c.rawEventId)}|${String(c.at)}`;
    if (seen.has(lift)) continue;
    seen.add(lift);
    out.push({
      ...r,
      correction: {
        how: (["newer_accepted", "accepted_itself", "no_longer_counted"].includes(String(c.how)) ? c.how : "other") as RevisionCorrection["correction"]["how"],
        rawEventId: num(c.rawEventId),
        runId: num(c.runId),
        replayId: num(c.replayId),
        fetchedAt: str(c.fetchedAt),
        cents: num(c.cents),
        branchId: str(c.branchId),
        at: String(c.at),
      },
    });
  }
  return out;
}

/** Is this incident a hold on refused spend revisions (as opposed to held lead records)? */
export const isRefusedRevisionHold = (evidence: Record<string, unknown> | null | undefined) => Array.isArray(evidence?.spendDates);

/**
 * The gate's period rule, in SQL, for an exceptions row aliased `e`: an incident that names spend
 * dates holds a decision only for a period containing one of them. Every other incident is as
 * before, whatever the period. `$from` and `$to` are timestamptz parameters (the period's bounds).
 */
export function refusedDatesInPeriod(from: string, to: string): string {
  return `(not (e.evidence ? 'spendDates') or exists (
     select 1 from jsonb_array_elements_text(e.evidence -> 'spendDates') d
     where d::date >= (${from}::timestamptz at time zone 'UTC')::date and d::date < (${to}::timestamptz at time zone 'UTC')::date))`;
}

/** The refused revisions inside a period, as the gate returns them with each blocker (same rule as above, in SQL). */
export function refusedRevisionsInPeriod(from: string, to: string): string {
  return `(select jsonb_agg(r order by r ->> 'date') from jsonb_array_elements(case when jsonb_typeof(e.evidence -> 'revisions') = 'array' then e.evidence -> 'revisions' else '[]'::jsonb end) r
     where (r ->> 'date')::date >= (${from}::timestamptz at time zone 'UTC')::date and (r ->> 'date')::date < (${to}::timestamptz at time zone 'UTC')::date)`;
}

const channelName = (code: string) => CHANNEL_BY_CODE.get(code as never)?.label ?? code;
const list = (items: string[]) => (items.length <= 1 ? (items[0] ?? "") : `${items.slice(0, -1).join(", ")} and ${items[items.length - 1]}`);
const unique = <T,>(items: T[]) => [...new Set(items)];

/** Why intake refused it, in plain words, from the mapper's own detail. */
export function refusalReason(r: Pick<RefusedRevision, "errorDetail">): string {
  const d = r.errorDetail ?? "";
  const fractional = d.match(/([\d.]+) platform conversions/);
  if (fractional) return `it reports ${fractional[1]} conversions and the ledger stores whole numbers only`;
  const currency = d.match(/account currency ([A-Z]{3})/);
  if (currency) return `it is billed in ${currency[1]} and only US dollars are summed`;
  return d.replace(/^spend_day [^:]+: /, "") || "it failed validation";
}

/** The incident page lists at most this many held campaign-days; the incident keeps them all. */
export const LISTED_DAYS = 50;

/**
 * The money an incident shows, once per campaign-day however many times the day was refused: what
 * the ledger still counts for the held days, and, for the days that stopped holding, what it counts
 * now. A day the ledger counts no revision of any more is not $0.00: its counted amount left the
 * total (`notCounted`, and a negative change).
 */
export interface HoldMoney {
  heldCents: number;
  countedNowCents: number;
  notCounted: number;
  /** Against what was counted before the lift: positive when the correction raised it. */
  changeCents: number;
  /** Days whose counted amount changed or left the total. */
  changedDays: number;
}

export function holdMoney(revisions: RefusedRevision[], corrections: RevisionCorrection[]): HoldMoney {
  const days = new Map(revisions.map((r) => [dayKey(r), r]));
  const out: HoldMoney = { heldCents: [...days.values()].reduce((t, r) => t + r.acceptedCents, 0), countedNowCents: 0, notCounted: 0, changeCents: 0, changedDays: 0 };
  for (const c of corrections) {
    if (c.correction.cents === null) {
      out.notCounted += 1;
      out.changeCents -= c.acceptedCents;
      out.changedDays += 1;
    } else {
      out.countedNowCents += c.correction.cents;
      if (c.correction.cents !== c.acceptedCents) {
        out.changeCents += c.correction.cents - c.acceptedCents;
        out.changedDays += 1;
      }
    }
  }
  return out;
}

/** "Oct 20 (Google Local Services)": the held campaign-days, by channel. */
export function heldDaysLabel(revisions: RefusedRevision[]): string {
  const byChannel = unique(revisions.map((r) => r.channel));
  return list(byChannel.map((ch) => `${dateRanges(revisions.filter((r) => r.channel === ch).map((r) => r.date))} (${channelName(ch)})`));
}

/**
 * The hold in one sentence, for a blocker line: what was refused, what still counts, what is held.
 * "A newer revision of Oct 20's Google Local Services spend (pmax-lsa-B09) was refused: it reports
 * 2.5 conversions and the ledger stores whole numbers only. The ledger still counts the earlier
 * $120.91, so Oct 20 is not confirmed."
 */
export function holdSentence(revisions: RefusedRevision[]): string {
  if (revisions.length === 0) return "";
  const days = unique(revisions.map((r) => `${r.date}|${r.campaignId}`)).length;
  if (days === 1) {
    const newest = [...revisions].sort((a, b) => b.refusedFetchedAt.localeCompare(a.refusedFetchedAt))[0];
    const day = dateRanges([newest.date]);
    return `A newer revision of ${day}'s ${channelName(newest.channel)} spend (${newest.externalCampaignId}) was refused: ${refusalReason(newest)}. The ledger still counts the earlier ${dollars(newest.acceptedCents)}, so ${day} is not confirmed.`;
  }
  const counted = unique(revisions.map((r) => `${r.date}|${r.campaignId}`)).map((k) => revisions.find((r) => `${r.date}|${r.campaignId}` === k)!);
  const cents = counted.reduce((t, r) => t + r.acceptedCents, 0);
  return `Newer revisions of ${days} campaign-days were refused (${heldDaysLabel(revisions)}). The ledger still counts their earlier amounts, ${dollars(cents)} in all, so those dates are not confirmed.`;
}

/**
 * Only an accepted revision corrects a hold: a newer one, or the refused one itself. A day the
 * ledger stops counting, or a campaign mapped to another branch, leaves the hold without anything
 * being corrected (EGM review 2026-11-18, K2).
 */
export const isCorrection = (c: RevisionCorrection) => c.correction.how === "newer_accepted" || c.correction.how === "accepted_itself";

/**
 * One lift, in words: "Oct 20: ingestion run #680 accepted a newer revision (fetched …): $120.91
 * became $400.00". `heldAt` is the branch whose incident held the day, to say when the campaign's
 * mapping moved the hold elsewhere.
 */
export function correctionClause(c: RevisionCorrection, heldAt: string | null = null): string {
  const day = dateRanges([c.date]);
  const change = c.correction.cents === null ? "" : c.correction.cents === c.acceptedCents ? `; ${dollars(c.acceptedCents)}, unchanged` : `: ${dollars(c.acceptedCents)} became ${dollars(c.correction.cents)}`;
  switch (c.correction.how) {
    case "newer_accepted":
      return `${day}: ${c.correction.runId === null ? "a delivery" : `ingestion run #${c.correction.runId}`} accepted a newer revision (fetched ${dateTime(c.correction.fetchedAt)})${change}`;
    case "accepted_itself":
      return `${day}: the refused revision itself is now accepted${c.correction.replayId === null ? "" : ` (replay #${c.correction.replayId})`}${change}`;
    case "no_longer_counted":
      // Not a $0.00 day: nothing is counted for it, and since 2026-11-17 held spend holds its channel.
      return `${day}: the ledger no longer counts any revision of this campaign-day, so the ${dollars(c.acceptedCents)} it counted left the total; the day is held spend now, which Decision Lab holds on its own`;
    default:
      return c.correction.branchId !== null && c.correction.branchId !== heldAt
        ? `${day}: the campaign is now mapped to ${c.correction.branchId}, so the hold moved there with it`
        : `${day}: the counted revision changed without a newer revision being accepted`;
  }
}

/** The resolution stored when no campaign-day holds the decision any more. "Corrected" only when every one was. */
export function correctedResolution(lifts: RevisionCorrection[], heldAt: string | null = null): string {
  const clauses = lifts.map((c) => correctionClause(c, heldAt)).join("; ");
  const handedOn = lifts.filter((c) => !isCorrection(c));
  return handedOn.length === 0
    ? `Corrected. ${clauses}.`
    : `No longer held by this incident; nothing was corrected for ${dateRanges([...new Set(handedOn.map((c) => c.date))])}. ${clauses}.`;
}

/**
 * Why refused spend records in a company-level quarantine incident hold no branch's decision, one
 * count per reason (HOLD-TO-DECISION.md §1.4, scenario 5). Read for a company-wide viewer only: the
 * incident has no branch, so no scoped viewer can open it.
 *   unidentified   no campaign id, date or fetch time the mapper could identify;
 *   unknownCampaign  a campaign id the ledger has never counted (no campaign record);
 *   unmapped       a campaign the ledger counts but maps to no branch;
 *   heldDay        a mapped campaign's day the ledger counts no revision of (never, or no longer):
 *                  held spend, which holds its channel's decision through eligibility (350fb45);
 *   sameInstant    the counted revision has the same fetch time: neither is newer.
 */
export interface UnattributedSpend {
  unidentified: number;
  unknownCampaign: number;
  unmapped: number;
  heldDay: { count: number; branchIds: string[] };
  sameInstant: number;
}

export async function unattributedSpend(db: Queryable, rawEventIds: number[]): Promise<UnattributedSpend> {
  const { rows } = await db.query<{ reason: string; n: string; branch_ids: string[] | null }>(
    `select reason, count(*) as n, array_agg(distinct branch_id) filter (where branch_id is not null) as branch_ids from (
       select case
                when re.entity_id = 'unidentified' then 'unidentified'
                when v.standing = 'same_instant' then 'sameInstant'
                when c.id is null then 'unknownCampaign'
                when m.branch_id is null then 'unmapped'
                else 'heldDay' end as reason,
              m.branch_id
       from raw_events re
       left join v_refused_spend_revisions v on v.raw_event_id = re.id
       left join ad_campaigns c on c.platform = re.payload ->> 'platform' and c.external_campaign_id = re.payload ->> 'campaignId'
       left join campaign_branch_map m on m.campaign_id = c.id
       where re.id = any($1::bigint[])) x
     group by reason`,
    [rawEventIds],
  );
  const n = (reason: string) => Number(rows.find((r) => r.reason === reason)?.n ?? 0);
  return {
    unidentified: n("unidentified"),
    unknownCampaign: n("unknownCampaign"),
    unmapped: n("unmapped"),
    heldDay: { count: n("heldDay"), branchIds: (rows.find((r) => r.reason === "heldDay")?.branch_ids ?? []).sort() },
    sameInstant: n("sameInstant"),
  };
}

/** The scenario-5 statement for a company-level incident of refused spend records. */
export function unattributedSentence(u: UnattributedSpend): string {
  const records = (n: number) => `${n} record${n === 1 ? "" : "s"}`;
  const cannot = [
    u.unidentified ? `${records(u.unidentified)} cannot be identified (no campaign id, date or fetch time)` : "",
    u.unknownCampaign ? `${records(u.unknownCampaign)} name a campaign the ledger has never counted` : "",
    u.unmapped ? `${records(u.unmapped)} name a campaign the ledger maps to no branch` : "",
    u.sameInstant ? `${records(u.sameInstant)} carry the same fetch time as the revision the ledger counts, so neither is newer` : "",
  ].filter(Boolean);
  const parts = [
    cannot.length ? `Which branch's decision these affect cannot be verified: ${list(cannot)}. A campaign's name or its ad account is not taken as proof of a branch.` : "",
    // A held day may have been counted before (a newer revision removed it), so never "never counted";
    // and since 2026-11-17 held spend holds its channel's decision (EGM review 2026-11-18, K2).
    u.heldDay.count
      ? `${records(u.heldDay.count)} ${u.heldDay.count === 1 ? "is a day" : "are days"} the ledger counts no revision of at ${list(u.heldDay.branchIds)}: held spend, which holds that channel's decision in Decision Lab until a revision is accepted.`
      : "",
    // Held days hold through eligibility already; only the unattributable records are undecided.
    `No branch's budget decision is held by this incident.${cannot.length ? " Whether records like these should hold one has not been decided." : ""}`,
  ];
  return parts.filter(Boolean).join(" ");
}

/**
 * How each refused revision that no longer holds the decision was resolved, read from the ledger
 * now: the revision counted for its campaign-day, the run that delivered it, and any replay that
 * accepted the refused record itself. Reconciliation stores the result on the incident.
 */
export async function correctionsFor(db: Queryable, revisions: RefusedRevision[], now: Date): Promise<RevisionCorrection[]> {
  const out: RevisionCorrection[] = [];
  for (const r of revisions) {
    const { rows } = await db.query<{ raw_event_id: string | null; cost_cents: string | null; fetched_at: Date | null; run_id: string | null; branch_id: string | null; replay_id: string | null }>(
      `select s.raw_event_id, s.cost_cents, acc.occurred_at as fetched_at, acc.ingestion_run_id as run_id, m.branch_id,
              (select max(p.id) from replays p where p.dry_run = false and p.requested_ids && $3::bigint[]) as replay_id
       from (select $1::bigint as campaign_id, $2::date as d) k
       left join ad_spend_daily s on s.campaign_id = k.campaign_id and s.spend_date = k.d
       left join raw_events acc on acc.id = s.raw_event_id
       left join campaign_branch_map m on m.campaign_id = k.campaign_id`,
      [r.campaignId, r.date, r.refusedRawEventIds],
    );
    const row = rows[0];
    const counted = row?.raw_event_id === null || row?.raw_event_id === undefined ? null : Number(row.raw_event_id);
    const fetchedAt = row?.fetched_at ? new Date(row.fetched_at).toISOString() : null;
    const how: RevisionCorrection["correction"]["how"] =
      counted === null
        ? "no_longer_counted"
        : r.refusedRawEventIds.includes(counted)
          ? "accepted_itself"
          : fetchedAt !== null && fetchedAt > new Date(r.refusedFetchedAt).toISOString()
            ? "newer_accepted"
            : "other";
    out.push({
      ...r,
      correction: {
        how,
        rawEventId: counted,
        runId: how === "newer_accepted" && row?.run_id ? Number(row.run_id) : null,
        replayId: how === "accepted_itself" && row?.replay_id ? Number(row.replay_id) : null,
        fetchedAt,
        cents: row?.cost_cents === null || row?.cost_cents === undefined ? null : Number(row.cost_cents),
        branchId: row?.branch_id ?? null,
        at: now.toISOString(),
      },
    });
  }
  return out;
}
