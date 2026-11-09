import type { Queryable } from "@/lib/db";

/**
 * Every metric is computed here, from the database, on request. Nothing on screen is
 * stored or hardcoded. All queries take the same scope: a half-open period [from, to)
 * and an optional list of branches. Branch scoping happens in SQL, so a scoped caller
 * cannot receive another branch's rows.
 */
export interface Scope {
  from: Date;
  to: Date;
  /** null = every branch. An empty array = no branches (returns nothing). */
  branchIds: string[] | null;
}

export interface BranchRow {
  branchId: string;
  name: string;
  region: string;
  paidSpendCents: number;
  platformClaimed: number;
  rawLeads: number;
  prospects: number;
  paidProspects: number;
  sold: number;
  acquired: number;
  paidAcquired: number;
  unknownAcquired: number;
  channelConflicts: number;
  /** Collected to date from customers first serviced in the period. */
  newCustomerCollectedCents: number;
  /** Booked annual contract value of those customers' active plans — booked, NOT revenue. */
  newCustomerAcvCents: number;
  /** All collected revenue in the period, including the existing customer base. */
  collectedCents: number;
  refundsCents: number;
  openExceptions: number;
  atRiskCents: number;
}

/**
 * Exception kinds whose customers ARE tied to a lead, branch and channel, but where two
 * sources disagree about who gets the credit: the lead's branch vs the servicing branch, or
 * the first paid touch vs the door-to-door rep who signed the sale. Their revenue is
 * "credit disputed", not "untied". Every other kind that references customers (held source
 * records, payments without a ticket, conflicting payloads) leaves revenue untied.
 */
export const CREDIT_DISPUTE_KINDS = ["branch_mismatch", "channel_conflict"] as const;

export interface Totals extends Omit<BranchRow, "branchId" | "name" | "region"> {
  /**
   * The part of atRiskCents from customers referenced by at least one open exception that is
   * NOT a credit dispute: revenue that cannot yet be tied to a lead, branch or channel.
   * Invariant: untiedCents + creditDisputedCents = atRiskCents (distinct customers, once).
   */
  untiedCents: number;
  /** The part of atRiskCents from customers whose only open exceptions are credit disputes. */
  creditDisputedCents: number;
  unallocatedSpendCents: number;
  paidCacCents: number | null;
  unknownShare: number | null;
}

const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

const scopeParams = (s: Scope) => [s.from, s.to, s.branchIds];

export async function branchRows(db: Queryable, scope: Scope): Promise<BranchRow[]> {
  const { rows } = await db.query(
    `with p as (select $1::timestamptz as t0, $2::timestamptz as t1),
     b as (select id from branches where $3::text[] is null or id = any($3::text[])),
     spend as (
       select m.branch_id, sum(s.cost_cents) as cost, sum(s.platform_conversions) as claimed
       from ad_spend_daily s
       join campaign_branch_map m on m.campaign_id = s.campaign_id
       join channels ch on ch.code = s.channel_code and ch.cost_basis = 'media', p
       where s.spend_date >= (p.t0 at time zone 'UTC')::date and s.spend_date < (p.t1 at time zone 'UTC')::date
       group by m.branch_id),
     leadagg as (
       select l.effective_branch_id as branch_id, count(*) as raw_leads, count(distinct l.prospect_key) as prospects,
              count(distinct l.prospect_key) filter (where ch.is_paid) as paid_prospects
       from v_leads l join channels ch on ch.code = l.channel_code, p
       where l.occurred_at >= p.t0 and l.occurred_at < p.t1
       group by 1),
     sold as (
       select a.branch_id, count(*) as sold from v_acquisitions a, p
       where a.sold_at >= p.t0 and a.sold_at < p.t1 group by 1),
     acq as (
       select a.branch_id, count(*) as acquired,
              count(*) filter (where ch.is_paid) as paid_acquired,
              count(*) filter (where a.channel_code = 'unknown') as unknown_acquired,
              count(*) filter (where a.channel_conflict) as conflicts,
              coalesce(sum(r.collected_cents), 0) as new_collected,
              coalesce(sum(a.annual_value_cents) filter (where a.subscription_status = 'active'), 0) as new_acv
       from v_acquisitions a join channels ch on ch.code = a.channel_code
       left join v_customer_revenue r on r.crm_customer_id = a.crm_customer_id, p
       where a.initial_status = 'completed' and a.initial_completed_at >= p.t0 and a.initial_completed_at < p.t1
       group by 1),
     rev as (
       select br.id as branch_id, sum(pm.amount_cents) as net, -coalesce(sum(pm.amount_cents) filter (where pm.amount_cents < 0), 0) as refunds
       from crm_payments pm join branches br on br.crm_office_id = pm.office_id, p
       where pm.status = 'successful' and pm.paid_at >= p.t0 and pm.paid_at < p.t1
       group by 1),
     exc as (
       select branch_id, count(*) as open_exceptions
       from exceptions where status = 'open' and branch_id is not null group by 1),
     risk as (
       -- revenue of DISTINCT customers referenced by open exceptions (no double counting)
       select x.branch_id, sum(coalesce(r.collected_cents, 0)) as at_risk
       from (select distinct e.branch_id, unnest(e.customer_ids) as customer_id
             from exceptions e where e.status = 'open' and e.branch_id is not null) x
       left join v_customer_revenue r on r.crm_customer_id = x.customer_id
       group by 1)
     select br.id, br.name, br.region,
            spend.cost, spend.claimed, leadagg.raw_leads, leadagg.prospects, leadagg.paid_prospects, sold.sold,
            acq.acquired, acq.paid_acquired, acq.unknown_acquired, acq.conflicts, acq.new_collected, acq.new_acv,
            rev.net, rev.refunds,
            exc.open_exceptions, risk.at_risk
     from b join branches br on br.id = b.id
     left join spend on spend.branch_id = br.id
     left join leadagg on leadagg.branch_id = br.id
     left join sold on sold.branch_id = br.id
     left join acq on acq.branch_id = br.id
     left join rev on rev.branch_id = br.id
     left join exc on exc.branch_id = br.id
     left join risk on risk.branch_id = br.id
     order by br.id`,
    scopeParams(scope),
  );
  return rows.map((r) => ({
    branchId: r.id,
    name: r.name,
    region: r.region,
    paidSpendCents: num(r.cost),
    platformClaimed: num(r.claimed),
    rawLeads: num(r.raw_leads),
    prospects: num(r.prospects),
    paidProspects: num(r.paid_prospects),
    sold: num(r.sold),
    acquired: num(r.acquired),
    paidAcquired: num(r.paid_acquired),
    unknownAcquired: num(r.unknown_acquired),
    channelConflicts: num(r.conflicts),
    newCustomerCollectedCents: num(r.new_collected),
    newCustomerAcvCents: num(r.new_acv),
    collectedCents: num(r.net),
    refundsCents: num(r.refunds),
    openExceptions: num(r.open_exceptions),
    atRiskCents: num(r.at_risk),
  }));
}

export function paidCac(spendCents: number, paidAcquired: number): number | null {
  return paidAcquired > 0 ? Math.round(spendCents / paidAcquired) : null;
}

export async function totals(db: Queryable, scope: Scope, rows?: BranchRow[]): Promise<Totals> {
  const branches = rows ?? (await branchRows(db, scope));
  const sum = (k: keyof BranchRow) => branches.reduce((acc, r) => acc + (r[k] as number), 0);
  // Distinct counts are not additive across branches: recompute them globally.
  const distinct = await db.query(
    `select count(distinct l.prospect_key) as prospects,
            count(distinct l.prospect_key) filter (where ch.is_paid) as paid_prospects
     from v_leads l join channels ch on ch.code = l.channel_code
     where l.occurred_at >= $1 and l.occurred_at < $2 and ($3::text[] is null or l.effective_branch_id = any($3::text[]))`,
    scopeParams(scope),
  );
  const unallocated =
    scope.branchIds === null
      ? await db.query(
          `select coalesce(sum(s.cost_cents), 0) as cost
           from ad_spend_daily s left join campaign_branch_map m on m.campaign_id = s.campaign_id
           where m.campaign_id is null and s.spend_date >= ($1::timestamptz at time zone 'UTC')::date and s.spend_date < ($2::timestamptz at time zone 'UTC')::date`,
          [scope.from, scope.to],
        )
      : { rows: [{ cost: 0 }] };
  // Exceptions are counted in scope, including company-wide ones (no branch) for an
  // unscoped viewer; revenue at risk is over distinct customers across all of them. The
  // untied part is over distinct customers named by a non-dispute exception, so a customer
  // in both a dispute and a held-records exception counts once, as untied.
  const exc = await db.query(
    `with scoped as (
       select * from exceptions e
       where e.status = 'open' and ($1::text[] is null or e.branch_id = any($1::text[])))
     select (select count(*) from scoped) as open_exceptions,
            (select coalesce(sum(r.collected_cents), 0)
               from (select distinct unnest(customer_ids) as customer_id from scoped) x
               join v_customer_revenue r on r.crm_customer_id = x.customer_id) as at_risk,
            (select coalesce(sum(r.collected_cents), 0)
               from (select distinct unnest(customer_ids) as customer_id from scoped
                     where kind <> all($2::text[])) x
               join v_customer_revenue r on r.crm_customer_id = x.customer_id) as untied`,
    [scope.branchIds, [...CREDIT_DISPUTE_KINDS]],
  );
  const atRiskCents = num(exc.rows[0].at_risk);
  const untiedCents = num(exc.rows[0].untied);
  const paidSpendCents = sum("paidSpendCents");
  const paidAcquired = sum("paidAcquired");
  const acquired = sum("acquired");
  const unknownAcquired = sum("unknownAcquired");
  return {
    paidSpendCents,
    platformClaimed: sum("platformClaimed"),
    rawLeads: sum("rawLeads"),
    prospects: num(distinct.rows[0].prospects),
    paidProspects: num(distinct.rows[0].paid_prospects),
    sold: sum("sold"),
    acquired,
    paidAcquired,
    unknownAcquired,
    channelConflicts: sum("channelConflicts"),
    newCustomerCollectedCents: sum("newCustomerCollectedCents"),
    newCustomerAcvCents: sum("newCustomerAcvCents"),
    collectedCents: sum("collectedCents"),
    refundsCents: sum("refundsCents"),
    openExceptions: num(exc.rows[0].open_exceptions),
    atRiskCents,
    untiedCents,
    creditDisputedCents: atRiskCents - untiedCents,
    unallocatedSpendCents: num(unallocated.rows[0].cost),
    paidCacCents: paidCac(paidSpendCents, paidAcquired),
    unknownShare: acquired > 0 ? unknownAcquired / acquired : null,
  };
}

export interface ChannelRow {
  channelCode: string;
  label: string;
  isPaid: boolean;
  costBasis: string;
  spendCents: number;
  prospects: number;
  acquired: number;
  revenueFromAcquiredCents: number;
  cacCents: number | null;
}

/** Channel economics for a scope. Revenue = collected revenue to date from customers acquired in the period. */
export async function channelRows(db: Queryable, scope: Scope): Promise<ChannelRow[]> {
  const { rows } = await db.query(
    `with spend as (
       select s.channel_code, sum(s.cost_cents) as cost
       from ad_spend_daily s
       join campaign_branch_map m on m.campaign_id = s.campaign_id
       where s.spend_date >= ($1::timestamptz at time zone 'UTC')::date and s.spend_date < ($2::timestamptz at time zone 'UTC')::date and ($3::text[] is null or m.branch_id = any($3::text[]))
       group by 1),
     pros as (
       select l.channel_code, count(distinct l.prospect_key) as prospects from v_leads l
       where l.occurred_at >= $1 and l.occurred_at < $2 and ($3::text[] is null or l.effective_branch_id = any($3::text[]))
       group by 1),
     -- Materialised first: with a branch filter pushed into the view, the planner otherwise
     -- re-aggregated revenue per customer row (33 s on the demo data; see docs/testing.md).
     scoped as materialized (
       select a.channel_code, a.crm_customer_id from v_acquisitions a
       where a.initial_status = 'completed' and a.initial_completed_at >= $1 and a.initial_completed_at < $2
         and ($3::text[] is null or a.branch_id = any($3::text[]))),
     acq as (
       select s.channel_code, count(*) as acquired, coalesce(sum(r.collected), 0) as revenue
       from scoped s
       left join lateral (
         select sum(p.amount_cents) as collected from crm_payments p
         where p.crm_customer_id = s.crm_customer_id and p.status = 'successful') r on true
       group by 1)
     select ch.code, ch.label, ch.is_paid, ch.cost_basis, spend.cost, pros.prospects, acq.acquired, acq.revenue
     from channels ch
     left join spend on spend.channel_code = ch.code
     left join pros on pros.channel_code = ch.code
     left join acq on acq.channel_code = ch.code
     order by ch.is_paid desc, coalesce(acq.acquired, 0) desc`,
    scopeParams(scope),
  );
  return rows.map((r) => {
    const spendCents = num(r.cost);
    const acquired = num(r.acquired);
    return {
      channelCode: r.code,
      label: r.label,
      isPaid: r.is_paid,
      costBasis: r.cost_basis,
      spendCents,
      prospects: num(r.prospects),
      acquired,
      revenueFromAcquiredCents: num(r.revenue),
      cacCents: r.cost_basis === "media" ? paidCac(spendCents, acquired) : null,
    };
  });
}

export interface Bridge {
  platformClaimed: number;
  paidLeadRecords: number;
  paidProspects: number;
  existingCustomers: number;
  notSold: number;
  creditedElsewhere: number;
  soldNotServiced: number;
  serviced: number;
}

/**
 * "Where did the conversions go?" — from what the ad platforms claim to verified paid
 * customers, one prospect at a time. Every prospect lands in exactly one bucket, so the
 * steps add up: paidProspects = existing + notSold + creditedElsewhere + soldNotServiced + serviced.
 */
export async function conversionBridge(db: Queryable, scope: Scope): Promise<Bridge> {
  const { rows } = await db.query(
    `with paid_leads as (
       select l.* from v_leads l join channels ch on ch.code = l.channel_code and ch.is_paid
       where l.occurred_at >= $1 and l.occurred_at < $2 and ($3::text[] is null or l.effective_branch_id = any($3::text[]))),
     prospects as (
       select prospect_key, min(occurred_at) as first_at from paid_leads group by prospect_key),
     acq as materialized (
       select a.lead_id, a.channel_code, a.initial_status, a.sold_at from v_acquisitions a where a.lead_id is not null),
     credited as (
       -- the acquisition (if any) credited to a lead of this prospect, and its channel
       select distinct on (pr.prospect_key) pr.prospect_key, a.channel_code, a.initial_status, ch.is_paid
       from prospects pr
       join v_leads l on l.prospect_key = pr.prospect_key
       join acq a on a.lead_id = l.id
       join channels ch on ch.code = a.channel_code
       order by pr.prospect_key, a.sold_at),
     classified as (
       select pr.prospect_key,
         case
           when c.prospect_key is not null and c.is_paid and c.initial_status = 'completed' then 'serviced'
           when c.prospect_key is not null and c.is_paid then 'sold_not_serviced'
           when c.prospect_key is not null then 'credited_elsewhere'
           when exists (
             select 1 from crm_customers cu
             join crm_subscriptions s on s.crm_customer_id = cu.crm_customer_id
             where (cu.phone_hash = pr.prospect_key or cu.email_hash = pr.prospect_key)
               and s.sold_at < pr.first_at - interval '1 day') then 'existing'
           else 'not_sold'
         end as outcome
       from prospects pr left join credited c on c.prospect_key = pr.prospect_key)
     select
       (select coalesce(sum(s.platform_conversions), 0) from ad_spend_daily s
          join campaign_branch_map m on m.campaign_id = s.campaign_id
          where s.spend_date >= ($1::timestamptz at time zone 'UTC')::date and s.spend_date < ($2::timestamptz at time zone 'UTC')::date
            and ($3::text[] is null or m.branch_id = any($3::text[]))) as claimed,
       (select count(*) from paid_leads) as lead_records,
       count(*) as prospects,
       count(*) filter (where outcome = 'existing') as existing,
       count(*) filter (where outcome = 'not_sold') as not_sold,
       count(*) filter (where outcome = 'credited_elsewhere') as credited_elsewhere,
       count(*) filter (where outcome = 'sold_not_serviced') as sold_not_serviced,
       count(*) filter (where outcome = 'serviced') as serviced
     from classified`,
    scopeParams(scope),
  );
  const r = rows[0];
  return {
    platformClaimed: num(r.claimed),
    paidLeadRecords: num(r.lead_records),
    paidProspects: num(r.prospects),
    existingCustomers: num(r.existing),
    notSold: num(r.not_sold),
    creditedElsewhere: num(r.credited_elsewhere),
    soldNotServiced: num(r.sold_not_serviced),
    serviced: num(r.serviced),
  };
}

export interface StreamFreshness {
  stream: string;
  source: string;
  lastRunAt: Date | null;
  lastRunStatus: string | null;
  lastSuccessAt: Date | null;
  latestEventAt: Date | null;
  quarantined: number;
}

export async function freshness(db: Queryable): Promise<StreamFreshness[]> {
  const { rows } = await db.query(
    `select r.stream, r.source,
            max(r.started_at) as last_run_at,
            (array_agg(r.status order by r.started_at desc))[1] as last_status,
            max(r.finished_at) filter (where r.status = 'succeeded') as last_success_at
     from ingestion_runs r group by r.stream, r.source order by r.stream`,
  );
  const events = await db.query(
    `select source, max(occurred_at) as latest, count(*) filter (where status = 'quarantined') as quarantined
     from raw_events group by source`,
  );
  const bySource = new Map(events.rows.map((e) => [e.source as string, e]));
  return rows.map((r) => ({
    stream: r.stream,
    source: r.source,
    lastRunAt: r.last_run_at,
    lastRunStatus: r.last_status,
    lastSuccessAt: r.last_success_at,
    latestEventAt: bySource.get(r.source)?.latest ?? null,
    quarantined: num(bySource.get(r.source)?.quarantined),
  }));
}
