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

/** One refused revision beside the revision the ledger counts for the same campaign-day. */
export interface RefusedRevision {
  rawEventId: number;
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

function parseRevision(v: Record<string, unknown>): RefusedRevision | null {
  const rawEventId = num(v.rawEventId);
  const date = str(v.date);
  if (rawEventId === null || !date) return null;
  return {
    rawEventId,
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

/** The refused revisions a quarantine incident holds the decision on; [] for any other incident. */
export function revisionsOf(evidence: Record<string, unknown> | null | undefined): RefusedRevision[] {
  const list = evidence?.revisions;
  if (!Array.isArray(list)) return [];
  return list.map((v) => parseRevision(v as Record<string, unknown>)).filter((r): r is RefusedRevision => r !== null);
}

/** The refused revisions of this incident that were corrected, and how. */
export function correctionsOf(evidence: Record<string, unknown> | null | undefined): RevisionCorrection[] {
  const list = evidence?.corrected;
  if (!Array.isArray(list)) return [];
  const out: RevisionCorrection[] = [];
  for (const v of list as Array<Record<string, unknown>>) {
    const r = parseRevision(v);
    const c = v.correction as Record<string, unknown> | undefined;
    if (!r || !c) continue;
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

/** One correction, in words: "Oct 20: ingestion run #680 accepted a newer revision (fetched …): $120.91 became $400.00". */
export function correctionClause(c: RevisionCorrection): string {
  const day = dateRanges([c.date]);
  const change = c.correction.cents === null ? "" : c.correction.cents === c.acceptedCents ? `; ${dollars(c.acceptedCents)}, unchanged` : `: ${dollars(c.acceptedCents)} became ${dollars(c.correction.cents)}`;
  switch (c.correction.how) {
    case "newer_accepted":
      return `${day}: ${c.correction.runId === null ? "a delivery" : `ingestion run #${c.correction.runId}`} accepted a newer revision (fetched ${dateTime(c.correction.fetchedAt)})${change}`;
    case "accepted_itself":
      return `${day}: the refused revision itself is now accepted${c.correction.replayId === null ? "" : ` (replay #${c.correction.replayId})`}${change}`;
    case "no_longer_counted":
      return `${day}: the ledger no longer counts a revision of this campaign-day`;
    default:
      return `${day}: the counted revision or the campaign's mapping changed${c.correction.branchId ? ` (now mapped to ${c.correction.branchId})` : ""}`;
  }
}

/** The resolution stored when every held campaign-day was corrected. */
export const correctedResolution = (corrected: RevisionCorrection[]) => `Corrected. ${corrected.map(correctionClause).join("; ")}.`;

/**
 * Why refused spend records in a company-level quarantine incident hold no branch's decision, one
 * count per reason (HOLD-TO-DECISION.md §1.4, scenario 5). Read for a company-wide viewer only: the
 * incident has no branch, so no scoped viewer can open it.
 *   unidentified   no campaign id, date or fetch time the mapper could identify;
 *   unknownCampaign  a campaign id the ledger has never counted (no campaign record);
 *   unmapped       a campaign the ledger counts but maps to no branch;
 *   heldDay        a mapped campaign's day the ledger never counted: held spend, a limitation in
 *                  verified readiness (N1), not a hold;
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
    u.heldDay.count
      ? `${records(u.heldDay.count)} ${u.heldDay.count === 1 ? "is a day" : "are days"} the ledger never counted at ${list(u.heldDay.branchIds)}: held spend, which Decision Lab's verified readiness lists as a limitation, not a hold.`
      : "",
    "No branch's budget decision is held by this incident. Whether records like these should hold one has not been decided.",
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
              (select max(p.id) from replays p where p.dry_run = false and $3::bigint = any(p.requested_ids)) as replay_id
       from (select $1::bigint as campaign_id, $2::date as d) k
       left join ad_spend_daily s on s.campaign_id = k.campaign_id and s.spend_date = k.d
       left join raw_events acc on acc.id = s.raw_event_id
       left join campaign_branch_map m on m.campaign_id = k.campaign_id`,
      [r.campaignId, r.date, r.rawEventId],
    );
    const row = rows[0];
    const counted = row?.raw_event_id === null || row?.raw_event_id === undefined ? null : Number(row.raw_event_id);
    const fetchedAt = row?.fetched_at ? new Date(row.fetched_at).toISOString() : null;
    const how: RevisionCorrection["correction"]["how"] =
      counted === null
        ? "no_longer_counted"
        : counted === r.rawEventId
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
