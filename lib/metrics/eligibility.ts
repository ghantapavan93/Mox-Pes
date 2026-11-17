import type { Queryable } from "@/lib/db";
import { dateRanges } from "@/lib/reconcile/gap-coverage";
import { HELD_SPEND, paidCac, type Scope } from "@/lib/metrics/scorecard";

/**
 * Whether a paid channel's cost per customer at a branch can carry a budget action, and if not, why,
 * in the records' own terms. It is the first of three separate outcomes (docs/metric-definitions.md,
 * "Decision boundary"):
 *
 *   1. a FACT is displayable: spend, customers, and a CAC or the reason there is none (this module);
 *   2. a COMPARISON between two channels is valid when neither is excluded here and no open incident
 *      touches either (`budgetSignal`, lib/metrics/decision.ts);
 *   3. a RECOMMENDATION (a branch-wide shift) can still be held: by an open incident, or by a left-out
 *      channel whose missing evidence could change which channel is cheapest or most expensive.
 *
 * The reasons are kept apart because they permit different things (2026-11-17, from the held-LSA case
 * at B03, docs/agent-work/product-audit/BUSINESS-FIT.md): held spend and an unmapped campaign wait
 * for records a person can release and hold any move involving the channel; spend counted at another
 * branch is a branch-credit question (D-2) that no record settles; no spend at all is unexplained; a
 * source-recorded $0.00 is evidence, not a gap, and holds nothing. A refused revision is added by the
 * gate from its incident (`budgetSignal`). Nothing here moves spend or customers between branches.
 */

export type EligibilityCode = "held" | "refused" | "unmapped" | "elsewhere" | "no_spend" | "recorded_zero" | "incident";

export interface EligibilityReason {
  code: EligibilityCode;
  /** The reason in full, in the records' own terms. */
  text: string;
  /** For a table cell beside the figure: "held at intake", "$0.00 recorded". */
  short: string;
  /**
   * The records name what releases it (held spend accepted, a newer revision accepted, the campaign
   * mapped, the incident resolved): an unresolved blocker. False when nothing in the records does:
   * a branch-credit question, an unexplained gap, a recorded zero. Every reason, either way, keeps
   * this channel's cost from carrying a move (its readiness fails).
   */
  holds: boolean;
  /**
   * Evidence is missing that could change which channel is cheapest or most expensive, so a
   * branch-wide ranking that leaves this channel out is not one. A recorded zero is evidence.
   */
  couldChange: boolean;
  /** Where the evidence lives, when a page holds it. */
  href?: string;
}

export interface ChannelEligibility {
  branchId: string;
  channelCode: string;
  label: string;
  spendCents: number;
  acquired: number;
  cacCents: number | null;
  /** Why this channel's CAC cannot carry an action. Empty: it can, subject to the gate and the minimum. */
  reasons: EligibilityReason[];
  /** What the figure mixes, shown beside it; never a reason to leave it out (rule 4: no ownership is invented). */
  limitations: string[];
}

/** The records behind one branch × paid-media channel × period, read once in SQL. */
export interface ChannelEvidence {
  branchId: string;
  channelCode: string;
  label: string;
  /** Counted spend of campaigns mapped to the branch, by the channel each record was classified into. */
  spendCents: number;
  countedDays: number;
  /** Counted campaign-days the source recorded at $0.00. */
  zeroDays: number;
  /** Campaign-days of campaigns mapped to the branch with a held record and no counted one, in the period. */
  heldDates: string[];
  /** The newest held record's own reason: code, detail and the ad account it names. */
  heldCode: string | null;
  heldDetail: string | null;
  heldAccount: string | null;
  heldStatus: "excluded" | "quarantined" | null;
  /** Customers serviced at the branch in the period, credited to this channel. */
  acquired: number;
  /** Of those: their campaign's spend is all held (none ever counted). */
  heldCustomers: number;
  /** Of those: their campaign has held days in the period. */
  partlyHeldCustomers: number;
  /** Of those: their campaign is mapped to no branch (its cost is unallocated spend). */
  unmappedCustomers: number;
  /** Of those: their campaign is mapped to another branch, which counts its cost. */
  elsewhereCustomers: number;
  elsewhereAt: string[];
  /** Customers of this branch's campaigns serviced at another branch in the period. */
  servedElsewhere: number;
  servedElsewhereAt: string[];
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/**
 * The evidence for every paid-media channel at the branches in scope (null = all). Spend and customers
 * are the channel rows' own (lib/metrics/scorecard.ts `channelRows`): spend by the mapped branch,
 * customers by the servicing branch. Held days come from the same held-spend rule the scorecard uses
 * (HELD_SPEND); a campaign is the one on the platform the lead's own record names (v_lead_campaigns, R-46).
 */
export async function channelEvidence(db: Queryable, scope: Scope): Promise<ChannelEvidence[]> {
  const { rows } = await db.query(
    `with p as (select $1::timestamptz as t0, $2::timestamptz as t1,
                       ($1::timestamptz at time zone 'UTC')::date as d0, ($2::timestamptz at time zone 'UTC')::date as d1),
     ${HELD_SPEND},
     media as (select code from channels where cost_basis = 'media'),
     spend as (
       select m.branch_id, s.channel_code, sum(s.cost_cents) as cost, count(*) as days, count(*) filter (where s.cost_cents = 0) as zero_days
       from ad_spend_daily s join campaign_branch_map m on m.campaign_id = s.campaign_id, p
       where s.spend_date >= p.d0 and s.spend_date < p.d1 and s.channel_code in (select code from media)
         and ($3::text[] is null or m.branch_id = any($3::text[]))
       group by 1, 2),
     -- The held records themselves, each status read on its own (the partial indexes apply), with
     -- their own reason: the newest held record of a held day is the reason shown for it.
     held_rows as (
       select re.id, re.status, re.exclusion_code as code, re.exclusion_detail as detail, re.payload ->> 'accountId' as account,
              re.payload ->> 'platform' as platform, re.payload ->> 'campaignId' as ext, try_date(re.payload ->> 'date') as day
       from raw_events re where re.source = 'ads' and re.status = 'excluded'
       union all
       select re.id, re.status, re.error_code, re.error_detail, re.payload ->> 'accountId',
              re.payload ->> 'platform', re.payload ->> 'campaignId', try_date(re.payload ->> 'date')
       from raw_events re where re.source = 'ads' and re.status = 'quarantined'),
     held_spend as (
       -- Held campaign-days of campaigns mapped to the branch, in the period, by the campaign's channel.
       select m.branch_id, c.channel_code, array_agg(distinct hd.day::text) as dates,
              (array_agg(h.code order by h.id desc))[1] as code, (array_agg(h.detail order by h.id desc))[1] as detail,
              (array_agg(h.account order by h.id desc))[1] as account, (array_agg(h.status order by h.id desc))[1] as status
       from held_days hd
       join ad_campaigns c on c.platform = hd.platform and c.external_campaign_id = hd.ext
       join campaign_branch_map m on m.campaign_id = c.id
       join held_rows h on h.platform = hd.platform and h.ext = hd.ext and h.day = hd.day, p
       where hd.day >= p.d0 and hd.day < p.d1 and c.channel_code in (select code from media)
         and ($3::text[] is null or m.branch_id = any($3::text[]))
       group by 1, 2),
     -- For a branch scope, the customers who may have come from its campaigns but are serviced
     -- elsewhere: those whose phone or email matches a lead naming one of its campaigns. A superset,
     -- narrowed below by the credited campaign itself; it lets the attribution view run per customer
     -- (37 ms for one branch) instead of for every branch (300 ms on the demo world).
     branch_ext as (
       select distinct c.external_campaign_id from ad_campaigns c join campaign_branch_map m on m.campaign_id = c.id
       where $3::text[] is not null and m.branch_id = any($3::text[])),
     naming as materialized (
       select l.phone_hash, l.email_hash from leads l where l.campaign_external_id in (select external_campaign_id from branch_ext)),
     candidates as materialized (
       select cu.crm_customer_id from crm_customers cu where cu.phone_hash in (select phone_hash from naming where phone_hash is not null)
       union
       select cu.crm_customer_id from crm_customers cu where cu.email_hash in (select email_hash from naming where email_hash is not null)),
     -- The period's paid-media customers, first and on their own (the scorecard's planning note).
     period_acq as materialized (
       select a.branch_id, a.lead_id, a.channel_code, a.crm_customer_id from v_acquisitions a, p
       where a.initial_status = 'completed' and a.initial_completed_at >= p.t0 and a.initial_completed_at < p.t1
         and a.channel_code in (select code from media) and ($3::text[] is null or a.branch_id = any($3::text[]))
       union
       select a.branch_id, a.lead_id, a.channel_code, a.crm_customer_id from v_acquisitions a, p
       where $3::text[] is not null and a.initial_status = 'completed' and a.initial_completed_at >= p.t0 and a.initial_completed_at < p.t1
         and a.channel_code in (select code from media) and a.crm_customer_id in (select crm_customer_id from candidates)),
     credited as materialized (
       select a.branch_id, a.channel_code, lc.campaign_id, m.branch_id as mapped_branch,
              exists (select 1 from held_campaigns hc where hc.platform = lc.platform and hc.external_campaign_id = lc.campaign_external_id) as campaign_held,
              exists (select 1 from held_days hd, p where hd.platform = lc.platform and hd.ext = lc.campaign_external_id and hd.day >= p.d0 and hd.day < p.d1) as days_held
       from period_acq a
       left join v_lead_campaigns lc on lc.lead_id = a.lead_id
       left join campaign_branch_map m on m.campaign_id = lc.campaign_id),
     cust as (
       select branch_id, channel_code, count(*) as acquired,
              count(*) filter (where campaign_held) as held,
              count(*) filter (where not campaign_held and days_held) as partly_held,
              count(*) filter (where campaign_id is not null and mapped_branch is null and not campaign_held) as unmapped,
              count(*) filter (where mapped_branch <> branch_id) as elsewhere,
              coalesce(array_agg(distinct mapped_branch) filter (where mapped_branch <> branch_id), '{}') as elsewhere_at
       from credited where $3::text[] is null or branch_id = any($3::text[])
       group by 1, 2),
     served as (
       select mapped_branch as branch_id, channel_code, count(*) as n, array_agg(distinct branch_id) as at
       from credited where mapped_branch <> branch_id and ($3::text[] is null or mapped_branch = any($3::text[]))
       group by 1, 2),
     keys as (
       select branch_id, channel_code from spend union select branch_id, channel_code from held_spend
       union select branch_id, channel_code from cust union select branch_id, channel_code from served)
     select k.branch_id, k.channel_code, ch.label,
            spend.cost, spend.days, spend.zero_days,
            held_spend.dates as held_dates, held_spend.code as held_code, held_spend.detail as held_detail,
            held_spend.account as held_account, held_spend.status as held_status,
            cust.acquired, cust.held, cust.partly_held, cust.unmapped, cust.elsewhere, cust.elsewhere_at,
            served.n as served_n, served.at as served_at
     from keys k join channels ch on ch.code = k.channel_code
     left join spend on spend.branch_id = k.branch_id and spend.channel_code = k.channel_code
     left join held_spend on held_spend.branch_id = k.branch_id and held_spend.channel_code = k.channel_code
     left join cust on cust.branch_id = k.branch_id and cust.channel_code = k.channel_code
     left join served on served.branch_id = k.branch_id and served.channel_code = k.channel_code
     order by k.branch_id, ch.code`,
    [scope.from, scope.to, scope.branchIds],
  );
  return rows.map((r) => ({
    branchId: r.branch_id,
    channelCode: r.channel_code,
    label: r.label,
    spendCents: num(r.cost),
    countedDays: num(r.days),
    zeroDays: num(r.zero_days),
    heldDates: ((r.held_dates as string[] | null) ?? []).sort(),
    heldCode: r.held_code ?? null,
    heldDetail: r.held_detail ?? null,
    heldAccount: r.held_account ?? null,
    heldStatus: r.held_status ?? null,
    acquired: num(r.acquired),
    heldCustomers: num(r.held),
    partlyHeldCustomers: num(r.partly_held),
    unmappedCustomers: num(r.unmapped),
    elsewhereCustomers: num(r.elsewhere),
    elsewhereAt: ((r.elsewhere_at as string[] | null) ?? []).sort(),
    servedElsewhere: num(r.served_n),
    servedElsewhereAt: ((r.served_at as string[] | null) ?? []).sort(),
  }));
}

const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
const list = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);
/** The page that releases a held record: currency rules for spend with no stated currency, else the quarantine. */
const heldHref = (e: Pick<ChannelEvidence, "heldStatus" | "heldCode">) =>
  e.heldCode === "CURRENCY_UNSTATED" ? "/integrations?view=pipeline#currency" : "/integrations?view=pipeline#quarantine";

/**
 * The channel's standing, from its evidence alone (no incident): the reasons its CAC cannot carry an
 * action and what the figure mixes. Pure, so every surface gets the same words from the same records.
 */
export function eligibilityOf(e: ChannelEvidence): ChannelEligibility {
  const reasons: EligibilityReason[] = [];
  const limitations: string[] = [];
  const at = e.branchId;
  const customers = plural(e.acquired, "customer");

  if (e.heldDates.length > 0) {
    const why = e.heldDetail ? `${e.heldDetail} (${[e.heldCode, e.heldAccount ? `account ${e.heldAccount}` : null].filter(Boolean).join(", ")})` : "the held records give no reason";
    const days = `${plural(e.heldDates.length, "day")} of the period (${dateRanges(e.heldDates)})`;
    reasons.push({
      code: "held",
      short: "held at intake",
      holds: true,
      couldChange: true,
      href: heldHref(e),
      text:
        e.spendCents === 0
          ? `Its spend at ${at} is held at intake on ${days}: ${why}. None of it is counted, so its ${customers} have no cost per customer until the held records are accepted.`
          : `Its spend at ${at} is held at intake on ${days}: ${why}. The counted spend leaves ${e.heldDates.length === 1 ? "that day" : "those days"} out, so its cost per customer is understated until the held records are accepted.`,
    });
  } else if (e.heldCustomers + e.partlyHeldCustomers > 0) {
    reasons.push({
      code: "held",
      short: "held at intake",
      holds: true,
      couldChange: true,
      text: `${(e.heldCustomers + e.partlyHeldCustomers).toLocaleString("en-US")} of its ${customers} came from a campaign whose spend is held at intake, so its cost per customer leaves their cost out until the held records are accepted.`,
    });
  }

  if (e.unmappedCustomers > 0) {
    reasons.push({
      code: "unmapped",
      short: "unmapped campaign",
      holds: true,
      couldChange: true,
      text: `${e.unmappedCustomers.toLocaleString("en-US")} of its ${customers} came from a campaign no branch is mapped to: their cost is unallocated spend, not in this figure, until someone maps the campaign.`,
    });
  }

  if (e.acquired > 0 && e.elsewhereCustomers === e.acquired) {
    reasons.push({
      code: "elsewhere",
      short: `cost at ${list(e.elsewhereAt)}`,
      holds: false,
      couldChange: true,
      text: `${e.acquired === 1 ? "Its only customer came from a campaign" : `All ${customers} came from campaigns`} mapped to ${list(e.elsewhereAt)}, which counts ${e.acquired === 1 ? "its" : "their"} cost (branch keys, D-2), so none of the spend counted here is theirs. Which branch carries that cost is a business decision.`,
    });
  } else if (e.elsewhereCustomers > 0) {
    limitations.push(
      `${e.elsewhereCustomers.toLocaleString("en-US")} of its ${customers} came from campaigns mapped to ${list(e.elsewhereAt)}; their cost is counted there, not in this figure (branch keys, D-2).`,
    );
  }
  if (e.servedElsewhere > 0) {
    limitations.push(
      `${plural(e.servedElsewhere, "customer")} of this branch's campaigns ${e.servedElsewhere === 1 ? "is" : "are"} serviced at ${list(e.servedElsewhereAt)}; their cost is counted here, the customers there (branch keys, D-2).`,
    );
  }

  if (e.acquired > 0 && e.spendCents === 0 && reasons.length === 0) {
    reasons.push(
      e.countedDays > 0
        ? {
            code: "recorded_zero",
            short: "$0.00 recorded",
            holds: false,
            couldChange: false,
            text: `The source recorded $0.00 for it at ${at} on all ${plural(e.countedDays, "counted day")} of the period: there is no cost per customer to act on. No record of it is held.`,
          }
        : {
            code: "no_spend",
            short: "no spend recorded",
            holds: false,
            couldChange: true,
            text: `No spend is recorded for it at ${at} in the period, and none is held: the records do not say what its ${customers} cost.`,
          },
    );
  }

  return {
    branchId: e.branchId,
    channelCode: e.channelCode,
    label: e.label,
    spendCents: e.spendCents,
    acquired: e.acquired,
    cacCents: paidCac(e.spendCents, e.acquired),
    reasons,
    limitations,
  };
}

/** Every paid-media channel's standing at the branches in scope, from its own evidence. */
export async function channelEligibility(db: Queryable, scope: Scope): Promise<ChannelEligibility[]> {
  return (await channelEvidence(db, scope)).map(eligibilityOf);
}
