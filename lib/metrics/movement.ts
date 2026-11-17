import { getNow, type Queryable } from "@/lib/db";
import { feedFreshness, staleReason } from "@/lib/decision/verdicts";
import { PERIODS, type Period } from "@/lib/period";
import { gapStatusesAt, type GapStatus } from "@/lib/reconcile/gap-status";
import { BRANCH_BY_ID } from "@/lib/reference";
import { canSeeBranch, type Viewer } from "@/lib/viewer";
import { decisionHolds, evidenceHolds, type DecisionHold, type EvidenceHold } from "./decision";

/**
 * "What changed": paid media spend per week, by channel, for one scope (a branch, a brand's
 * branches, or everything the viewer may see), with what a reviewer needs to decide whether a
 * movement is business or a number to investigate.
 *
 * The metric is the scorecard's paid media spend (definition `paidSpend`: cost of paid-media
 * campaigns mapped to the branch, by spend date), split by channel and by week (Monday–Sunday,
 * UTC). The weeks always cover the whole window (Sep 1 – Oct 30) so a movement has its before;
 * the selected period is highlighted, not cut out.
 *
 * Every cell says what the stored records support, never more:
 *   recorded       a spend record for every day of the week that the feed has delivered
 *   partial        records for some of those days only (the others have no record)
 *   zero           records that report $0.00: a real zero, not a missing one
 *   missing        no record on any delivered day, while the channel has records elsewhere in
 *                  the window: shown as a gap, never as $0
 *   not_delivered  the ads feed has not delivered that far yet: unknown, not missing
 *
 * Reads only. Branch scope is the caller's (resolved from the viewer): a branch outside it is
 * refused before this runs.
 */

export const WINDOW: Period = PERIODS.all;

export type CellStatus = "recorded" | "partial" | "zero" | "missing" | "not_delivered";

export interface WeekInfo {
  /** Monday, ISO date. */
  start: string;
  /** Last day of the week inside the window (ISO date). */
  end: string;
  /** Days of this week inside the window. */
  days: number;
  /** Of those, days the ads feed has delivered (spend dates up to `deliveredThrough`). */
  delivered: number;
  /** Overlaps the selected period. */
  inPeriod: boolean;
}

export interface Cell {
  week: string;
  /** Sum of the records, or null when there is none. */
  cents: number | null;
  /** Distinct spend dates with a record. */
  daysWithRecord: number;
  /** Days the feed has delivered in this week (the most there could be). */
  daysDelivered: number;
  status: CellStatus;
  /** Lead records of this channel at this scope in the week (context, another unit). */
  leads: number;
}

export interface Series {
  channel: string;
  label: string;
  cells: Cell[];
  /** The channel's spend in the selected period, and in the comparison period (October vs September only). */
  periodCents: number;
  compareCents: number | null;
}

export interface Marker {
  exceptionId: number;
  status: string;
  /** The stored date the incident's evidence gives (a coverage gap's first day). */
  date: string;
  week: string;
  channel: string;
  channelLabel: string;
  successors: Array<{ externalCampaignId: string; classifiedAs: string[]; spendSinceCents: number; firstSpendDate: string | null }>;
}

export interface Movement {
  scope: { branchId: string | null; branchIds: string[] | null };
  period: { key: Period["key"]; label: string; compareLabel: string | null };
  weeks: WeekInfo[];
  series: Series[];
  /** Only for a single branch: an incident's stored date and scope are the chart's own. */
  markers: Marker[];
  /**
   * The marked coverage gaps that are open or were verified, with their decision window as the
   * records cover it now (lib/reconcile/gap-status.ts): the same status the incident and Decision
   * Lab show. Single branch only.
   */
  recoveries?: GapStatus[];
  /** Open incidents in scope that change what a paid channel cost (the Overview's hold rule). */
  holds: DecisionHold[];
  /**
   * Recommendations the records hold with no incident to say so (held spend, none recorded, cost
   * counted at another branch): the Overview's other hold rule (lib/metrics/decision.ts).
   */
  evidenceHolds?: EvidenceHold[];
  /** The last spend date the ads feed has delivered, for any campaign. */
  deliveredThrough: string | null;
  /** Why the ads feed is stale now, or null. */
  feedStale: string | null;
  totals: { periodCents: number; compareCents: number | null };
}

const iso = (d: Date) => d.toISOString().slice(0, 10);
const addDays = (isoDate: string, n: number) => iso(new Date(Date.parse(`${isoDate}T00:00:00Z`) + n * 86_400_000));
const mondayOf = (isoDate: string) => {
  const d = new Date(`${isoDate}T00:00:00Z`);
  return addDays(isoDate, -((d.getUTCDay() + 6) % 7));
};

/** The window's weeks, Monday first, with how many of their days fall inside the window and the period. */
export function windowWeeks(period: Period, deliveredThrough: string | null): WeekInfo[] {
  const first = iso(WINDOW.from);
  const lastExclusive = iso(WINDOW.to);
  const pFrom = iso(period.from);
  const pTo = iso(period.to);
  const weeks: WeekInfo[] = [];
  for (let start = mondayOf(first); start < lastExclusive; start = addDays(start, 7)) {
    let days = 0;
    let delivered = 0;
    let end = start;
    let inPeriod = false;
    for (let i = 0; i < 7; i++) {
      const day = addDays(start, i);
      if (day < first || day >= lastExclusive) continue;
      days += 1;
      end = day;
      if (deliveredThrough !== null && day <= deliveredThrough) delivered += 1;
      if (day >= pFrom && day < pTo) inPeriod = true;
    }
    weeks.push({ start, end, days, delivered, inPeriod });
  }
  return weeks;
}

/** What a week's records support for one channel. */
export function cellStatus(daysWithRecord: number, daysDelivered: number, cents: number | null): CellStatus {
  if (daysDelivered === 0) return "not_delivered";
  if (daysWithRecord === 0) return "missing";
  // Missing days come first: three days that report $0.00 and four with no record is a partial
  // week, not a zero one. "zero" means every delivered day reported $0.00.
  if (daysWithRecord < daysDelivered) return "partial";
  if (cents === 0) return "zero";
  return "recorded";
}

/**
 * Coverage-gap incidents at one branch whose stored evidence gives a date and a channel: the only
 * events the chart marks, because their date and scope are stored, not inferred from the line.
 */
export async function coverageMarkers(db: Queryable, branchId: string): Promise<Marker[]> {
  const [gaps, labels] = await Promise.all([
    db.query<{ id: string; status: string; evidence: Record<string, unknown> }>(
      `select id, status, evidence from exceptions
       where kind = 'channel_coverage_gap' and branch_id = $1 and evidence ? 'gapStart' and evidence ? 'channel' order by id`,
      [branchId],
    ),
    db.query<{ code: string; label: string }>("select code, label from channels"),
  ]);
  const label = new Map(labels.rows.map((r) => [r.code, r.label]));
  return gaps.rows
    .map((r) => {
      const e = r.evidence as { gapStart: string; channel: string; channelLabel?: string; successors?: Array<Record<string, unknown>> };
      return {
        exceptionId: Number(r.id),
        status: r.status,
        date: e.gapStart,
        week: mondayOf(e.gapStart),
        channel: e.channel,
        channelLabel: e.channelLabel ?? label.get(e.channel) ?? e.channel,
        successors: (e.successors ?? []).map((x) => ({
          externalCampaignId: String(x.externalCampaignId ?? ""),
          classifiedAs: ((x.classifiedAs as string[] | undefined) ?? []).map((c) => label.get(c) ?? c),
          spendSinceCents: Number(x.spendSinceGapCents ?? 0),
          firstSpendDate: (x.firstSpendDate as string | null | undefined) ?? null,
        })),
      };
    })
    .filter((m) => /^\d{4}-\d{2}-\d{2}$/.test(m.date));
}

/**
 * The weekly paid media spend by channel at one branch (`branchId`) or across `branchIds` (null =
 * all branches), with what the takeaway needs. `holds`, when given, are the decision holds the
 * caller already read for this same scope: they are used as they are, so the panel and the page
 * that shows it name the same holds, and the slowest of these reads (about 0.45 s across all
 * branches) is not run twice.
 */
export async function movement(
  db: Queryable,
  args: { branchId: string | null; branchIds: string[] | null; period: Period; holds?: DecisionHold[]; evidenceHolds?: EvidenceHold[] },
): Promise<Movement> {
  const scope = args.branchId ? [args.branchId] : args.branchIds;
  const from = iso(WINDOW.from);
  const to = iso(WINDOW.to);
  const compare = args.period.key === "oct" ? PERIODS.sep : null;

  const [spend, leads, delivered, labels, totals, holds, held, gaps, feeds, now] = await Promise.all([
    db.query<{ w: string; channel_code: string; cents: string; days: string }>(
      `select to_char(date_trunc('week', s.spend_date), 'YYYY-MM-DD') as w, s.channel_code, sum(s.cost_cents) as cents, count(distinct s.spend_date) as days
       from ad_spend_daily s
       join campaign_branch_map m on m.campaign_id = s.campaign_id
       join channels ch on ch.code = s.channel_code and ch.cost_basis = 'media'
       where s.spend_date >= $1::date and s.spend_date < $2::date and ($3::text[] is null or m.branch_id = any($3::text[]))
       group by 1, 2`,
      [from, to, scope],
    ),
    db.query<{ w: string; channel_code: string; n: string }>(
      `select to_char(date_trunc('week', l.occurred_at at time zone 'UTC'), 'YYYY-MM-DD') as w, l.channel_code, count(*) as n
       from v_leads l join channels ch on ch.code = l.channel_code and ch.cost_basis = 'media'
       where l.occurred_at >= $1 and l.occurred_at < $2 and ($3::text[] is null or l.effective_branch_id = any($3::text[]))
       group by 1, 2`,
      [WINDOW.from, WINDOW.to, scope],
    ),
    db.query<{ through: string | null }>("select to_char(max(spend_date), 'YYYY-MM-DD') as through from ad_spend_daily"),
    db.query<{ code: string; label: string }>("select code, label from channels where cost_basis = 'media'"),
    db.query<{ channel_code: string; period: string | null; compare: string | null }>(
      `select s.channel_code,
              sum(s.cost_cents) filter (where s.spend_date >= $1::date and s.spend_date < $2::date) as period,
              sum(s.cost_cents) filter (where $3::date is not null and s.spend_date >= $3::date and s.spend_date < $4::date) as compare
       from ad_spend_daily s
       join campaign_branch_map m on m.campaign_id = s.campaign_id
       join channels ch on ch.code = s.channel_code and ch.cost_basis = 'media'
       where ($5::text[] is null or m.branch_id = any($5::text[]))
       group by 1`,
      [iso(args.period.from), iso(args.period.to), compare ? iso(compare.from) : null, compare ? iso(compare.to) : null, scope],
    ),
    args.holds ? Promise.resolve(args.holds) : decisionHolds(db, scope, 8, args.period),
    args.evidenceHolds ? Promise.resolve(args.evidenceHolds) : evidenceHolds(db, scope, args.period),
    args.branchId ? coverageMarkers(db, args.branchId) : Promise.resolve([] as Marker[]),
    feedFreshness(db),
    getNow(db),
  ]);

  const deliveredThrough = delivered.rows[0]?.through ?? null;
  const weeks = windowWeeks(args.period, deliveredThrough);
  const label = new Map(labels.rows.map((r) => [r.code, r.label]));
  const key = (w: string, ch: string) => `${w}|${ch}`;
  const spendBy = new Map(spend.rows.map((r) => [key(r.w, r.channel_code), { cents: Number(r.cents), days: Number(r.days) }]));
  const leadsBy = new Map(leads.rows.map((r) => [key(r.w, r.channel_code), Number(r.n)]));
  const totalsBy = new Map(totals.rows.map((r) => [r.channel_code, r]));
  // A channel is drawn when it has a spend record somewhere in the window, at this scope.
  const channels = [...new Set(spend.rows.map((r) => r.channel_code))];

  const series: Series[] = channels.map((channel) => {
    const t = totalsBy.get(channel);
    return {
      channel,
      label: label.get(channel) ?? channel,
      cells: weeks.map((w) => {
        const s = spendBy.get(key(w.start, channel));
        const daysWithRecord = s?.days ?? 0;
        const cents = s ? s.cents : null;
        return { week: w.start, cents, daysWithRecord, daysDelivered: w.delivered, status: cellStatus(daysWithRecord, w.delivered, cents), leads: leadsBy.get(key(w.start, channel)) ?? 0 };
      }),
      periodCents: Number(t?.period ?? 0),
      compareCents: compare ? Number(t?.compare ?? 0) : null,
    };
  });
  // Largest spend first, so the legend reads in the order the lines stack.
  series.sort((a, b) => b.periodCents - a.periodCents || a.label.localeCompare(b.label));

  // Only a date inside the window, on a channel the chart draws.
  const markers = gaps.filter((m) => m.date >= from && m.date < to && channels.includes(m.channel));
  // The branch passed the caller's scope check; read only for the incidents the chart marks.
  const recoveries = args.branchId && markers.length > 0 ? await gapStatusesAt(db, args.branchId, { ids: markers.map((m) => m.exceptionId) }) : [];

  const ads = feeds.filter((f) => f.source === "ads");
  const feedStale = ads.map((f) => staleReason(f, now)).find((r) => r !== null) ?? null;

  return {
    scope: { branchId: args.branchId, branchIds: scope },
    period: { key: args.period.key, label: args.period.label, compareLabel: compare ? compare.label : null },
    weeks,
    series,
    markers,
    recoveries,
    holds,
    evidenceHolds: held,
    deliveredThrough,
    feedStale,
    totals: {
      periodCents: series.reduce((t, s) => t + s.periodCents, 0),
      compareCents: compare ? series.reduce((t, s) => t + (s.compareCents ?? 0), 0) : null,
    },
  };
}

export interface SpendDay {
  date: string;
  /** Records on that day (one per campaign of the channel); empty = no record. */
  records: Array<{
    externalCampaignId: string;
    name: string;
    platform: string;
    /** The counted amount: the last accepted revision. */
    cents: number;
    rawEventId: number;
    /**
     * Newer revisions of this campaign-day that intake refused (migration 0034): never counted,
     * and while one is newer than the counted revision, the decision reading this day is held by
     * `exceptionId` (HOLD-TO-DECISION.md).
     */
    refused: Array<{ rawEventId: number; fetchedAt: string; cents: number | null; errorDetail: string | null; exceptionId: number | null }>;
  }>;
}

/**
 * The stored spend records behind one point of the chart: one channel, one week, one branch. Every
 * day of the week inside the window, with its records or none. The caller has checked the branch
 * is in the viewer's scope.
 */
export async function spendDays(db: Queryable, args: { branchId: string; channel: string; week: string }): Promise<SpendDay[]> {
  const first = iso(WINDOW.from);
  const lastExclusive = iso(WINDOW.to);
  const { rows } = await db.query<{ spend_date: string; external_campaign_id: string; name: string; platform: string; cost_cents: string; raw_event_id: string; refused: SpendDay["records"][number]["refused"] | null }>(
    `select to_char(s.spend_date, 'YYYY-MM-DD') as spend_date, c.external_campaign_id, c.name, c.platform, s.cost_cents, s.raw_event_id,
            (select jsonb_agg(jsonb_build_object('rawEventId', v.raw_event_id, 'fetchedAt', v.refused_fetched_at, 'cents', v.refused_cents,
                      'errorDetail', v.error_detail,
                      'exceptionId', (select min(e.id) from exceptions e where e.kind = 'quarantined_source_records' and e.status = 'open'
                                        and e.evidence -> 'revisions' @> jsonb_build_array(jsonb_build_object('rawEventId', v.raw_event_id))))
                    order by v.refused_fetched_at)
             from v_refused_spend_revisions v
             where v.campaign_id = s.campaign_id and v.spend_date = s.spend_date and v.standing = 'newer') as refused
     from ad_spend_daily s
     join campaign_branch_map m on m.campaign_id = s.campaign_id
     join ad_campaigns c on c.id = s.campaign_id
     join channels ch on ch.code = s.channel_code and ch.cost_basis = 'media'
     where m.branch_id = $1 and s.channel_code = $2 and s.spend_date >= $3::date and s.spend_date < $4::date
     order by s.spend_date, c.external_campaign_id`,
    [args.branchId, args.channel, args.week, addDays(args.week, 7)],
  );
  const days: SpendDay[] = [];
  for (let i = 0; i < 7; i++) {
    const date = addDays(args.week, i);
    if (date < first || date >= lastExclusive) continue;
    days.push({
      date,
      records: rows
        .filter((r) => r.spend_date === date)
        .map((r) => ({
          externalCampaignId: r.external_campaign_id,
          name: r.name,
          platform: r.platform,
          cents: Number(r.cost_cents),
          rawEventId: Number(r.raw_event_id),
          refused: (r.refused ?? []).map((x) => ({ rawEventId: Number(x.rawEventId), fetchedAt: String(x.fetchedAt), cents: x.cents === null ? null : Number(x.cents), errorDetail: x.errorDetail ?? null, exceptionId: x.exceptionId === null ? null : Number(x.exceptionId) })),
        })),
    });
  }
  return days;
}

/** A week parameter from a URL: a Monday inside the window, or null. */
export function parseWeek(value: unknown): string | null {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  if (Number.isNaN(Date.parse(`${value}T00:00:00Z`)) || mondayOf(value) !== value) return null;
  return windowWeeks(WINDOW, null).some((w) => w.start === value) ? value : null;
}

/** A channel parameter from a URL: a code's shape (the caller checks it is drawn). */
export function parseChannel(value: unknown): string | null {
  return typeof value === "string" && /^[a-z][a-z0-9_]{1,40}$/.test(value) ? value : null;
}

export type MovementState =
  | { kind: "ready"; movement: Movement }
  | { kind: "outside_scope"; branchId: string }
  | { kind: "unknown_branch"; branchId: string };

/**
 * The Overview's "What changed" for this viewer: one branch (`?branch=`), or everything the Overview
 * shows (the brand slice or the viewer's scope; a single-branch viewer gets that branch). A branch
 * outside the viewer's scope is refused here, before any read, and nothing about it is returned.
 *
 * `pageHolds` are the holds the Overview read for its own scope (`brandBranchIds ?? viewer.branchIds`).
 * Without `branchParam` that is this panel's scope too, so they are reused. A chosen branch reads
 * its own: the page's list is capped and ranked across every branch in view.
 */
export async function overviewMovement(
  db: Queryable,
  viewer: Viewer,
  args: { branchParam: string | null; brandBranchIds: string[] | null; period: Period; pageHolds?: DecisionHold[]; pageEvidenceHolds?: EvidenceHold[] },
): Promise<MovementState> {
  if (args.branchParam) {
    if (!BRANCH_BY_ID.has(args.branchParam)) return { kind: "unknown_branch", branchId: args.branchParam };
    if (!canSeeBranch(viewer, args.branchParam)) return { kind: "outside_scope", branchId: args.branchParam };
    return { kind: "ready", movement: await movement(db, { branchId: args.branchParam, branchIds: null, period: args.period }) };
  }
  const inView = args.brandBranchIds ?? viewer.branchIds;
  if (inView && inView.length === 1) return { kind: "ready", movement: await movement(db, { branchId: inView[0], branchIds: null, period: args.period, holds: args.pageHolds, evidenceHolds: args.pageEvidenceHolds }) };
  return { kind: "ready", movement: await movement(db, { branchId: null, branchIds: inView, period: args.period, holds: args.pageHolds, evidenceHolds: args.pageEvidenceHolds }) };
}

/**
 * The drillthrough for one point (a channel's week at one branch): its day-by-day records, the
 * channel's name, the coverage-gap incidents of that channel at that branch, and the status of
 * those that are open or were verified (their decision window, as on the incident). Null for a
 * channel that is not a paid-media channel. The caller has checked the branch is in scope.
 */
export async function selectionEvidence(
  db: Queryable,
  args: { branchId: string; channel: string; week: string },
): Promise<{ channelLabel: string; days: SpendDay[]; markers: Marker[]; recoveries: GapStatus[] } | null> {
  const ch = await db.query<{ label: string }>("select label from channels where code = $1 and cost_basis = 'media'", [args.channel]);
  if (!ch.rows[0]) return null;
  const [days, all] = await Promise.all([spendDays(db, args), coverageMarkers(db, args.branchId)]);
  const markers = all.filter((m) => m.channel === args.channel);
  const recoveries = markers.length > 0 ? await gapStatusesAt(db, args.branchId, { ids: markers.map((m) => m.exceptionId) }) : [];
  return { channelLabel: ch.rows[0].label, days, markers, recoveries };
}
