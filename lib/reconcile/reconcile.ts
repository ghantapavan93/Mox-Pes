import type { Queryable } from "@/lib/db";
import { currentSnapshot, currentTxid, recordEvent } from "@/lib/events/outbox";
import { syncCases } from "@/lib/workflow/cases";
import { gapCoverage, verificationOf, verifiedResolution } from "./gap-coverage";
import { correctedResolution, correctionsFor, correctionsOf, dayKey, revisionsOf } from "./refused-revisions";

/**
 * Cross-system reconciliation. Each detector is one SQL statement that states a rule the
 * systems should agree on and returns every place they don't. Detection is idempotent:
 * an exception is keyed by a fingerprint (kind + subject), so re-running updates the same
 * row; when a condition clears, its exception resolves itself. Must run in a transaction.
 *
 * Invariants
 *   * exceptions.branch_id is a known branch or null — payloads that name an unknown branch
 *     are attributed through payload_branch(), which only returns known branches;
 *   * customer_ids lists every customer an exception touches, so revenue at risk can be
 *     summed over distinct customers instead of double counting across exception kinds;
 *   * an acknowledged exception stays acknowledged while its condition persists;
 *   * reconciliation is serialised (advisory lock): two concurrent runs cannot re-open
 *     what the other just resolved.
 */

/** Detector-managed kinds. payload_conflict is raised at ingest and closed by a person. */
export const DETECTED_KINDS = [
  "quarantined_source_records",
  "payment_without_ticket",
  "branch_mismatch",
  "unmapped_spend",
  "channel_conflict",
  "channel_coverage_gap",
] as const;

const RECONCILE_LOCK = 742_001;

/**
 * Every transaction that changes exceptions AND reconciles takes this lock FIRST, before
 * touching any exception row. Taking it after a row lock (as decisions once did) can
 * deadlock against a concurrent reconcile. Re-entrant within a transaction.
 */
export async function lockReconcile(tx: Queryable): Promise<void> {
  await tx.query("select pg_advisory_xact_lock($1)", [RECONCILE_LOCK]);
}

const DETECTORS: string[] = [
  // 1. Source records that failed validation, grouped by source + error + branch, with
  //    the business impact: customers whose only lead record is sitting in quarantine.
  //    The records and their branch come from v_quarantine_holds (migration 0034): a refused
  //    spend revision newer than the one the ledger counts holds its campaign's branch, and one
  //    a counted revision superseded holds nothing. Such a group's evidence names the
  //    campaign-days it holds, their dates and channels, and each refused revision beside the
  //    accepted one (HOLD-TO-DECISION.md; R-54).
  `insert into detected
   with q as (
     select h.id, h.source, h.error_code, h.error_detail, h.occurred_at, h.branch_id,
            (select array_agg(substr(v #>> '{}', 9))
               from jsonb_path_query(h.payload, 'strict $.** ? (@.type() == "string" && @ starts with "h:phone:")') v) as phone_hashes
     from v_quarantine_holds h),
   revisions as (
     select q.source, q.error_code, q.branch_id, count(*) as records, count(distinct v.entity_id) as days,
            jsonb_agg(distinct v.spend_date::text order by v.spend_date::text) as dates,
            jsonb_agg(distinct v.channel_code order by v.channel_code) as channels,
            min(v.external_campaign_id) as campaign, min(v.spend_date) as first_date, max(v.accepted_cents) as accepted_cents
     from q join v_refused_spend_revisions v on v.raw_event_id = q.id and v.standing = 'newer'
     group by 1, 2, 3),
   impact as (
     select distinct q.source, q.error_code, q.branch_id, a.crm_customer_id, coalesce(r.collected_cents, 0) as collected,
            a.annual_value_cents as acv
     from q
     join crm_customers c on c.phone_hash = any(q.phone_hashes)
     join acq a on a.crm_customer_id = c.crm_customer_id and a.attribution_basis = 'no_lead_record'
     left join v_customer_revenue r on r.crm_customer_id = c.crm_customer_id),
   impact_by_group as (
     select source, error_code, branch_id, count(*) as customers, sum(collected) as collected, sum(acv) as acv,
            array_agg(crm_customer_id order by crm_customer_id) as customer_ids
     from impact group by 1, 2, 3)
   select
     'quarantine:' || q.source || ':' || q.error_code || ':' || coalesce(q.branch_id, '-'),
     'quarantined_source_records',
     case when coalesce(i.customers, 0) > 0 then 'high' else 'medium' end,
     q.branch_id, 'quarantine_group', q.source || ':' || q.error_code || ':' || coalesce(q.branch_id, '-'),
     case
       -- Every record is a refused newer spend revision: say what it holds, never "N records".
       when rv.records = count(*) and rv.days = 1 then
         'A newer revision of ' || rv.campaign || '''s spend on ' || to_char(rv.first_date, 'Mon FMDD') || ' was refused ('
           || q.error_code || '); the earlier ' || to_char(rv.accepted_cents / 100.0, 'FM$999,999,990.00') || ' still counts'
       when rv.records = count(*) then
         'Newer revisions of ' || rv.days || ' campaign-days of spend were refused (' || q.error_code || '); the earlier accepted amounts still count'
       else count(*) || ' records from ' || q.source || ' quarantined (' || q.error_code || ')'
         || case when coalesce(i.customers, 0) > 0 then '; ' || i.customers || ' new customers lose their lead record' else '' end
     end,
     jsonb_build_object(
       'source', q.source, 'errorCode', q.error_code, 'sampleError', min(q.error_detail),
       'records', count(*), 'firstOccurredAt', min(q.occurred_at), 'lastOccurredAt', max(q.occurred_at),
       'sampleRawEventIds', (array_agg(q.id order by q.id))[1:10],
       'customersWithoutLead', coalesce(i.customers, 0), 'annualContractValueCents', coalesce(i.acv, 0))
     || case when rv.records is null then '{}'::jsonb else jsonb_build_object(
       'campaignDays', rv.days, 'spendDates', rv.dates, 'channels', rv.channels,
       -- One entry per campaign-day, oldest date first: its newest refused revision beside the
       -- counted one, and every refused delivery of that day (the source re-fetches recent days,
       -- so a lasting refusal repeats; EGM review 2026-11-18, K1). The list is bounded by
       -- campaign-days, not deliveries, and is not cut: rule 1a and the gate read every day, and the
       -- page lists the first LISTED_DAYS.
       'revisions', (select jsonb_agg(d.r || jsonb_build_object('refusedRawEventIds', d.ids) order by d.spend_date, d.campaign_id) from (
          select v.campaign_id, v.spend_date,
                 (array_agg(jsonb_build_object(
                    'rawEventId', v.raw_event_id, 'campaignId', v.campaign_id, 'externalCampaignId', v.external_campaign_id,
                    'platform', v.platform, 'date', v.spend_date, 'channel', v.channel_code, 'errorDetail', v.error_detail,
                    'refusedFetchedAt', v.refused_fetched_at, 'refusedRunId', v.refused_run_id, 'refusedCents', v.refused_cents,
                    'acceptedRawEventId', v.accepted_raw_event_id, 'acceptedFetchedAt', v.accepted_fetched_at,
                    'acceptedRunId', v.accepted_run_id, 'acceptedCents', v.accepted_cents)
                  order by v.refused_fetched_at desc, v.raw_event_id desc))[1] as r,
                 jsonb_agg(v.raw_event_id order by v.refused_fetched_at, v.raw_event_id) as ids
          from v_refused_spend_revisions v
          where v.standing = 'newer' and v.raw_event_id = any(array_agg(q.id))
          group by v.campaign_id, v.spend_date) d)) end,
     coalesce(i.collected, 0),
     coalesce(i.customer_ids, '{}')
   from q
   left join impact_by_group i
     on i.source = q.source and i.error_code = q.error_code and i.branch_id is not distinct from q.branch_id
   left join revisions rv
     on rv.source = q.source and rv.error_code = q.error_code and rv.branch_id is not distinct from q.branch_id
   group by q.source, q.error_code, q.branch_id, i.customers, i.collected, i.acv, i.customer_ids,
            rv.records, rv.days, rv.dates, rv.channels, rv.campaign, rv.first_date, rv.accepted_cents`,

  // 2. A successful payment applied to a ticket the CRM feed has not delivered. Usually
  //    ordering (the ticket arrives on the next run); persistent ones are real gaps.
  `insert into detected
   select 'payment_without_ticket:' || p.crm_payment_id, 'payment_without_ticket', 'low', b.id,
     'payment', p.crm_payment_id::text,
     'Payment ' || p.crm_payment_id || ' is applied to ticket ' || p.crm_ticket_id || ', which has not been received',
     jsonb_build_object('paymentId', p.crm_payment_id, 'ticketId', p.crm_ticket_id, 'customerId', p.crm_customer_id,
       'paidAt', p.paid_at, 'rawEventId', p.raw_event_id),
     abs(p.amount_cents),
     array[p.crm_customer_id]
   from crm_payments p
   left join crm_tickets t on t.crm_ticket_id = p.crm_ticket_id
   left join branches b on b.crm_office_id = p.office_id
   where p.status = 'successful' and p.crm_ticket_id is not null and t.crm_ticket_id is null`,

  // 3. The lead was captured for one branch, the customer is serviced by another.
  `insert into detected
   select 'branch_mismatch:lead:' || a.lead_id, 'branch_mismatch', 'medium', a.branch_id,
     'acquisition', a.crm_customer_id::text,
     'Lead captured for ' || a.lead_branch_id || ', customer serviced by ' || a.branch_id,
     jsonb_build_object('leadId', a.lead_id, 'leadBranch', a.lead_branch_id, 'crmBranch', a.branch_id,
       'customerId', a.crm_customer_id, 'customerZip', c.zip, 'territoryBranch', t.branch_id,
       'channel', a.channel_code),
     coalesce(r.collected_cents, 0),
     array[a.crm_customer_id]
   from acq a
   join crm_customers c on c.crm_customer_id = a.crm_customer_id
   left join branch_territories t on t.zip = c.zip
   left join v_customer_revenue r on r.crm_customer_id = a.crm_customer_id
   where a.lead_id is not null and a.lead_branch_id is distinct from a.branch_id`,

  // 4. Spend on a campaign nobody has mapped to a branch. amount_cents is SPEND here,
  //    not revenue; it is reported as unallocated spend, never as revenue at risk.
  `insert into detected
   select 'unmapped_spend:campaign:' || c.id, 'unmapped_spend',
     case when sum(s.cost_cents) >= 100000 then 'high' else 'medium' end, null,
     'campaign', c.id::text,
     'Campaign "' || c.name || '" has spend but no branch mapping',
     jsonb_build_object('campaignId', c.id, 'platform', c.platform, 'adAccountId', c.ad_account_id,
       'externalCampaignId', c.external_campaign_id, 'name', c.name, 'firstSpendDate', min(s.spend_date),
       'lastSpendDate', max(s.spend_date), 'days', count(*), 'spendCents', sum(s.cost_cents)),
     sum(s.cost_cents),
     '{}'::bigint[]
   from ad_campaigns c
   join ad_spend_daily s on s.campaign_id = c.id
   left join campaign_branch_map m on m.campaign_id = c.id
   where m.campaign_id is null
   group by c.id`,

  // 5. A paid touch reached the customer first, then a D2D rep signed them.
  `insert into detected
   select 'channel_conflict:customer:' || a.crm_customer_id, 'channel_conflict', 'low', a.branch_id,
     'acquisition', a.crm_customer_id::text,
     'Credited to ' || a.channel_code || ' (first touch), but a door-to-door rep signed the sale',
     jsonb_build_object('customerId', a.crm_customer_id, 'creditedChannel', a.channel_code, 'leadId', a.lead_id,
       'soldByRep', a.sold_by_rep, 'soldAt', a.sold_at),
     coalesce(r.collected_cents, 0),
     array[a.crm_customer_id]
   from acq a
   left join v_customer_revenue r on r.crm_customer_id = a.crm_customer_id
   where a.channel_conflict`,
];

/**
 * 6. A paid channel keeps producing leads at a branch while its spend stops. The spend has
 *    usually not stopped: it is arriving under another campaign, classified into another
 *    channel (for example a Local Services campaign that Google migrated into a Performance Max
 *    campaign). Nothing failed validation, so this is the only rule that sees it.
 *
 *    Measured against the spend feed's own latest date, so a late feed is not a gap. Evidence
 *    names the campaign that stopped and any campaign that started in the same ad account.
 *    amount_cents is the spend since the gap on those successor campaigns: misfiled spend,
 *    never revenue.
 */
const COVERAGE_GAP = `insert into detected
  with ref as (select max(spend_date) as d from ad_spend_daily),
  spend as (
    select m.branch_id, s.channel_code, s.campaign_id, s.spend_date, s.cost_cents
    from ad_spend_daily s
    join campaign_branch_map m on m.campaign_id = s.campaign_id
    join channels ch on ch.code = s.channel_code and ch.cost_basis = 'media'
    where s.cost_cents > 0 and s.spend_date > (select d from ref) - 60),
  gaps as (
    select branch_id, channel_code, max(spend_date) as last_spend
    from spend group by 1, 2
    having (select d from ref) - max(spend_date) >= 3),
  gap_leads as (
    select g.branch_id, g.channel_code, count(*) as leads, (array_agg(l.id order by l.occurred_at))[1:10] as sample_lead_ids
    from gaps g
    join v_leads l on l.effective_branch_id = g.branch_id and l.channel_code = g.channel_code
     and l.occurred_at >= ((g.last_spend + 1)::timestamp at time zone 'UTC')
    group by 1, 2 having count(*) >= 3),
  before_gap as (
    select g.branch_id, g.channel_code, sum(s.cost_cents) / 14 as avg_daily_cents
    from gaps g join spend s on s.branch_id = g.branch_id and s.channel_code = g.channel_code
     and s.spend_date > g.last_spend - 14 and s.spend_date <= g.last_spend
    group by 1, 2),
  pred as (
    select distinct g.branch_id, g.channel_code, g.last_spend, c.id, c.ad_account_id, c.external_campaign_id, c.name,
           c.platform, c.campaign_type
    from gaps g
    join spend s on s.branch_id = g.branch_id and s.channel_code = g.channel_code and s.spend_date = g.last_spend
    join ad_campaigns c on c.id = s.campaign_id),
  -- One row per ad account that held a stopped campaign. Joining successors to each predecessor
  -- instead counted a successor's spend once per predecessor in the same account (audit
  -- 2026-11-09: two stopped campaigns in one account doubled the exception amount).
  pred_account as (
    select branch_id, channel_code, last_spend, ad_account_id, array_agg(id) as pred_ids
    from pred group by 1, 2, 3, 4),
  succ as (
    select p.branch_id, p.channel_code, c.id, c.external_campaign_id, c.name, c.platform, c.campaign_type,
           c.local_services_enabled, min(s.spend_date) as first_spend,
           coalesce(sum(s.cost_cents) filter (where s.spend_date > p.last_spend), 0) as spend_since,
           count(*) filter (where s.spend_date > p.last_spend) as days_since,
           array_agg(distinct s.channel_code) filter (where s.spend_date > p.last_spend) as classified_as
    from pred_account p
    join ad_campaigns c on c.ad_account_id = p.ad_account_id and c.id <> all(p.pred_ids)
    join ad_spend_daily s on s.campaign_id = c.id
    group by p.branch_id, p.channel_code, p.last_spend, p.ad_account_id, c.id
    having min(s.spend_date) between p.last_spend - 3 and p.last_spend + 7),
  acq_gap as (
    select g.branch_id, g.channel_code, count(*) as acquisitions
    from gaps g join acq a on a.branch_id = g.branch_id and a.channel_code = g.channel_code
     and a.sold_at >= ((g.last_spend + 1)::timestamp at time zone 'UTC')
    group by 1, 2)
  select
    'channel_coverage_gap:' || g.branch_id || ':' || g.channel_code || ':' || g.last_spend,
    'channel_coverage_gap',
    case when gl.leads >= 10 then 'high' else 'medium' end,
    g.branch_id, 'branch_channel', g.branch_id || ':' || g.channel_code,
    ch.label || ' spend at ' || g.branch_id || ' stopped after ' || to_char(g.last_spend, 'Mon FMDD')
      || ', but ' || gl.leads || ' ' || ch.label || ' leads kept arriving'
      || case when exists (select 1 from succ x where x.branch_id = g.branch_id and x.channel_code = g.channel_code)
           then '; a new campaign in the same ad account started then' else '' end,
    jsonb_build_object(
      'branchId', g.branch_id, 'channel', g.channel_code, 'channelLabel', ch.label,
      'lastSpendDate', g.last_spend, 'gapStart', g.last_spend + 1, 'feedLatestDate', (select d from ref),
      'gapDays', (select d from ref) - g.last_spend,
      'leadsSinceGap', gl.leads, 'sampleLeadIds', gl.sample_lead_ids,
      'acquisitionsSinceGap', coalesce(ag.acquisitions, 0),
      'avgDailySpendBeforeCents', coalesce(bg.avg_daily_cents, 0),
      'predecessors', (select jsonb_agg(jsonb_build_object('campaignId', p.id, 'externalCampaignId', p.external_campaign_id,
          'name', p.name, 'platform', p.platform, 'campaignType', p.campaign_type, 'adAccountId', p.ad_account_id) order by p.id)
        from pred p where p.branch_id = g.branch_id and p.channel_code = g.channel_code),
      'successors', (select jsonb_agg(jsonb_build_object('campaignId', x.id, 'externalCampaignId', x.external_campaign_id,
          'name', x.name, 'platform', x.platform, 'campaignType', x.campaign_type,
          'localServicesEnabled', x.local_services_enabled, 'firstSpendDate', x.first_spend,
          'spendSinceGapCents', x.spend_since, 'daysSinceGap', x.days_since, 'classifiedAs', x.classified_as) order by x.id)
        from succ x where x.branch_id = g.branch_id and x.channel_code = g.channel_code)),
    coalesce((select sum(x.spend_since) from succ x where x.branch_id = g.branch_id and x.channel_code = g.channel_code), 0),
    '{}'::bigint[]
  from gaps g
  join gap_leads gl on gl.branch_id = g.branch_id and gl.channel_code = g.channel_code
  join channels ch on ch.code = g.channel_code
  left join before_gap bg on bg.branch_id = g.branch_id and bg.channel_code = g.channel_code
  left join acq_gap ag on ag.branch_id = g.branch_id and ag.channel_code = g.channel_code`;

/**
 * 6a. An open coverage gap stays open until its whole window is verified (lib/reconcile/
 *     gap-coverage.ts). Rule 6 alone tested only the channel's latest spend date, which is also
 *     the incident's fingerprint: re-filing the last few days cleared the hold while earlier
 *     dates were still missing, and re-filing a middle week resolved the incident and opened a new
 *     one (B09-RECOVERY.md).
 *
 *     Runs after rule 6. While rule 6 still finds an incident's own fingerprint (no spend after
 *     its last spend date), that fresh row stands, exactly as before. Otherwise each open gap, and
 *     each one verified within the detector's lookback, stays detected with the fingerprint,
 *     summary and evidence it last had, and any row rule 6 filed for the same branch and channel
 *     under a newer date is dropped: one gap, one incident, until every required date is covered
 *     and nothing is misfiled. Then it is verified: the resolution and evidence.verification say
 *     what was checked and which delivery runs carried it. A verified incident is re-checked over
 *     the window it was verified on, never a longer one, so a later feed day does not reopen it; a
 *     later version that un-covers one of those dates does, under the same id, and the earlier
 *     verification is kept beside the new one. A delivery that changes nothing changes none of it.
 */
async function carryCoverageGaps(tx: Queryable, now: Date): Promise<void> {
  const { rows } = await tx.query<{
    id: string; fingerprint: string; kind: string; severity: string; branch_id: string; subject_type: string; subject_id: string;
    summary: string; evidence: Record<string, unknown>; amount_cents: string; customer_ids: string[]; status: string;
  }>(
    `select id, fingerprint, kind, severity, branch_id, subject_type, subject_id, summary, evidence, amount_cents, customer_ids, status
     from exceptions
     where kind = 'channel_coverage_gap'
       and (status in ('open', 'acknowledged')
            or (status = 'resolved' and evidence ? 'verification'
                and (evidence ->> 'lastSpendDate')::date > (select max(spend_date) from ad_spend_daily) - 60))
     order by id`,
  );
  for (const e of rows) {
    // Rule 6 still sees this very incident: its fresh evidence stands, as it always did.
    if ((await tx.query("select 1 from detected where fingerprint = $1", [e.fingerprint])).rowCount) continue;
    const coverage = await gapCoverage(tx, e.evidence, e.branch_id);
    if (!coverage || !coverage.complete) {
      await tx.query("delete from detected where kind = 'channel_coverage_gap' and branch_id = $1 and evidence ->> 'channel' = $2", [e.branch_id, String(e.evidence.channel)]);
      await tx.query(
        `insert into detected (fingerprint, kind, severity, branch_id, subject_type, subject_id, summary, evidence, amount_cents, customer_ids)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
        [e.fingerprint, e.kind, e.severity, e.branch_id, e.subject_type, e.subject_id, e.summary, e.evidence, e.amount_cents, e.customer_ids],
      );
    } else if (e.status !== "resolved") {
      // Resolved by the generic step below, which keeps this resolution. A verification from an
      // earlier recovery (before a regression reopened it) is kept, not overwritten.
      await tx.query(
        `update exceptions set resolution = $2,
           evidence = case when evidence ? 'verification'
             then evidence || jsonb_build_object('verification', $3::jsonb,
                    'previousVerifications', coalesce(evidence -> 'previousVerifications', '[]'::jsonb) || jsonb_build_array(evidence -> 'verification'))
             else evidence || jsonb_build_object('verification', $3::jsonb) end
         where id = $1`,
        [e.id, verifiedResolution(coverage), JSON.stringify(verificationOf(coverage, now))],
      );
    }
  }
}

/**
 * 1a. A hold on refused spend revisions names what lifted it (HOLD-TO-DECISION.md; R-54). Rule 1
 *     lists the refused revisions that are still newer than the counted one. A revision that left
 *     that list was corrected: a newer revision was accepted, the refused one itself was (a
 *     replay), or the ledger stopped counting the day. Each is kept on the incident with how it
 *     was corrected and by which delivery, beside the revisions still held, so lifting one
 *     campaign-day never hides another. When none is left, the incident resolves with those
 *     corrections as its resolution (the generic step below keeps it).
 */
async function carryRefusedRevisions(tx: Queryable, now: Date): Promise<void> {
  const { rows } = await tx.query<{ id: string; fingerprint: string; branch_id: string | null; evidence: Record<string, unknown> }>(
    `select id, fingerprint, branch_id, evidence from exceptions
     where kind = 'quarantined_source_records' and status in ('open', 'acknowledged') and evidence ? 'revisions'
     order by id`,
  );
  for (const e of rows) {
    const detected = (await tx.query<{ evidence: Record<string, unknown> }>("select evidence from detected where fingerprint = $1", [e.fingerprint])).rows[0];
    // By campaign-day, never by refused record: a later refusal of a held day is the same hold, not
    // a correction of the earlier one (EGM review 2026-11-18, K1).
    const still = new Set(revisionsOf(detected?.evidence).map(dayKey));
    const gone = revisionsOf(e.evidence).filter((r) => !still.has(dayKey(r)));
    const corrected = [...correctionsOf(e.evidence), ...(await correctionsFor(tx, gone, now))];
    if (detected) {
      if (corrected.length > 0) {
        await tx.query("update detected set evidence = evidence || jsonb_build_object('corrected', $2::jsonb) where fingerprint = $1", [e.fingerprint, JSON.stringify(corrected)]);
      }
    } else if (corrected.length > 0) {
      await tx.query(
        "update exceptions set resolution = $2, evidence = evidence || jsonb_build_object('corrected', $3::jsonb) where id = $1",
        [e.id, correctedResolution(corrected, e.branch_id), JSON.stringify(corrected)],
      );
    }
  }
}

export interface ReconcileResult {
  detected: number;
  opened: number;
  resolved: number;
}

export async function reconcile(tx: Queryable, now: Date): Promise<ReconcileResult> {
  await lockReconcile(tx);
  const coverage = { snapshot: await currentSnapshot(tx), txid: await currentTxid(tx) };
  await tx.query(`
    create temp table if not exists detected (
      fingerprint text primary key, kind text, severity text, branch_id text, subject_type text, subject_id text,
      summary text, evidence jsonb, amount_cents bigint, customer_ids bigint[]
    ) on commit drop`);
  await tx.query("truncate detected");
  // Attribution is derived once per run and shared by every detector.
  await tx.query("drop table if exists acq");
  await tx.query("create temp table acq on commit drop as select * from v_acquisitions");
  await tx.query("create index on acq (crm_customer_id)");
  for (const sql of DETECTORS) await tx.query(sql);
  await carryRefusedRevisions(tx, now);
  await tx.query(COVERAGE_GAP);
  await carryCoverageGaps(tx, now);

  const opened = await tx.query(
    `insert into exceptions as e (kind, severity, fingerprint, branch_id, subject_type, subject_id, summary, evidence,
       amount_cents, customer_ids, status, first_detected_at, last_detected_at)
     select d.kind, d.severity, d.fingerprint, d.branch_id, d.subject_type, d.subject_id, d.summary, d.evidence,
       d.amount_cents, d.customer_ids, 'open', $1, $1
     from detected d
     on conflict (fingerprint) do update set
       severity = excluded.severity, branch_id = excluded.branch_id, summary = excluded.summary,
       evidence = excluded.evidence, amount_cents = excluded.amount_cents, customer_ids = excluded.customer_ids,
       last_detected_at = excluded.last_detected_at,
       status = case when e.status = 'acknowledged' then 'acknowledged' else 'open' end,
       resolution = case when e.status = 'acknowledged' then e.resolution else null end,
       resolved_at = null
     returning (xmax = 0) as inserted`,
    [now],
  );

  const resolved = await tx.query(
    `update exceptions e set status = 'resolved', resolved_at = $1,
       resolution = coalesce(e.resolution, 'Condition no longer detected')
     where e.status in ('open', 'acknowledged') and e.kind = any($2::text[])
       and not exists (select 1 from detected d where d.fingerprint = e.fingerprint)`,
    [now, DETECTED_KINDS],
  );

  const detected = await tx.query<{ n: string }>("select count(*) as n from detected");
  // Action Center: one case per exception, resolved / re-opened with it (lib/workflow/cases.ts).
  await syncCases(tx, now);
  const result = {
    detected: Number(detected.rows[0].n),
    opened: opened.rows.filter((r) => r.inserted).length,
    resolved: resolved.rowCount ?? 0,
  };
  await recordEvent(tx, { type: "reconciliation.run_completed", subject: "reconciliation:all", occurredAt: now, payload: { ...coverage, ...result } });
  return result;
}
