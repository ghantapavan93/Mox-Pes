-- v_acquisitions decides each customer's first subscription, and that subscription's initial
-- appointment, in sets (docs/agent-work/release/RELEASE-DESIGN.md §5.10, WP-G step 3). Columns and
-- rules are unchanged; a build from before this migration reads the same rows.
--
-- Before, both "firsts" were LATERAL … LIMIT 1 lookups per customer. A read that keeps one period
-- (the scorecard, eligibility, the decision and evidence holds) decided them for every customer of
-- the demo world (17,111) before keeping the period's 3,687: about 250 ms per read
-- (docs/agent-work/release/measurements/steps.md, step 2 diagnosis). Written as "no row orders
-- before this one" (NOT EXISTS), the same rules let the planner start from the period's
-- appointments, and still find one customer's row by index.
--
-- The initial appointment's order was not total: two initial appointments of one subscription with
-- the same scheduled time left the pick to the sort. The appointment id is now its last key, lowest
-- first. The seeded world has no such tie, so no result there changes.

-- Each subscription that is its customer's first: the earliest sold, then the lowest id.
create view v_first_subscriptions as
select s.*
from crm_subscriptions s
where not exists (
  select 1 from crm_subscriptions e
  where e.crm_customer_id = s.crm_customer_id
    and (e.sold_at, e.crm_subscription_id) < (s.sold_at, s.crm_subscription_id));

-- Each subscription's deciding initial appointment: one not rescheduled before one rescheduled, then
-- the latest scheduled, then the lowest id. Every column compared is NOT NULL, so exactly one
-- appointment has none ordered before it in each subscription that has any.
create view v_initial_appointments as
select a.*
from crm_appointments a
where a.kind = 'initial'
  and not exists (
    select 1 from crm_appointments x
    where x.crm_subscription_id = a.crm_subscription_id and x.kind = 'initial'
      and ((x.status = 'rescheduled') < (a.status = 'rescheduled')
        or ((x.status = 'rescheduled') = (a.status = 'rescheduled')
          and (x.scheduled_for > a.scheduled_for
            or (x.scheduled_for = a.scheduled_for and x.crm_appointment_id < a.crm_appointment_id)))));

-- 0026's view on those two. The first touch (`touch`) and the conflict check are unchanged.
create or replace view v_acquisitions as
select
  c.crm_customer_id,
  fs.crm_subscription_id,
  b.id                                    as branch_id,
  fs.sold_at,
  fs.sold_by_rep,
  fs.status                               as subscription_status,
  fs.annual_value_cents,
  coalesce(ia.status, 'missing')          as initial_status,
  ia.completed_at                         as initial_completed_at,
  touch.id                                as lead_id,
  touch.effective_branch_id               as lead_branch_id,
  coalesce(touch.channel_code, 'unknown') as channel_code,
  touch.attribution_evidence,
  touch.campaign_external_id,
  case
    when touch.id is null then 'no_lead_record'
    when touch.attribution_evidence = 'none' then 'lead_without_evidence'
    else 'lead_evidence'
  end                                     as attribution_basis,
  (touch.id is not null and touch.channel_code <> 'd2d'
   and exists (select 1 from channels ch where ch.code = touch.channel_code and ch.is_paid) and (
    exists (select 1 from leads d where d.phone_hash = c.phone_hash and d.attribution_evidence = 'rep_signature'
              and d.occurred_at > touch.occurred_at and d.occurred_at <= fs.sold_at + interval '2 hours')
    or exists (select 1 from leads d where d.email_hash = c.email_hash and d.attribution_evidence = 'rep_signature'
              and d.occurred_at > touch.occurred_at and d.occurred_at <= fs.sold_at + interval '2 hours')
  ))                                      as channel_conflict
from crm_customers c
join v_first_subscriptions fs on fs.crm_customer_id = c.crm_customer_id
left join branches b on b.crm_office_id = fs.office_id
left join v_initial_appointments ia on ia.crm_subscription_id = fs.crm_subscription_id
left join lateral (
  select m.* from (
    (select vl.* from v_leads vl
     where vl.phone_hash = c.phone_hash
       and vl.occurred_at >= fs.sold_at - interval '60 days' and vl.occurred_at <= fs.sold_at + interval '2 hours')
    union all
    (select vl.* from v_leads vl
     where vl.email_hash = c.email_hash
       and vl.occurred_at >= fs.sold_at - interval '60 days' and vl.occurred_at <= fs.sold_at + interval '2 hours')
  ) m
  where
    not exists (select 1 from v_identity_decisions k
                where k.lead_id = m.id and k.crm_customer_id = c.crm_customer_id and k.status = 'rejected')
    and (
      exists (select 1 from v_identity_decisions k
              where k.lead_id = m.id and k.crm_customer_id = c.crm_customer_id and k.status = 'accepted')
      or (
        not exists (select 1 from v_identity_decisions k
                    where k.lead_id = m.id and k.crm_customer_id <> c.crm_customer_id and k.status = 'accepted')
        and not exists (
          select 1 from crm_customers o
          join lateral (select s.sold_at from crm_subscriptions s where s.crm_customer_id = o.crm_customer_id
                        order by s.sold_at, s.crm_subscription_id limit 1) os on true
          where m.phone_hash is not null and o.phone_hash = m.phone_hash and o.crm_customer_id <> c.crm_customer_id
            and m.occurred_at >= os.sold_at - interval '60 days' and m.occurred_at <= os.sold_at + interval '2 hours'
            and (os.sold_at < fs.sold_at or (os.sold_at = fs.sold_at and o.crm_customer_id < c.crm_customer_id))
            and not exists (select 1 from v_identity_decisions k
                            where k.lead_id = m.id and k.crm_customer_id = o.crm_customer_id and k.status = 'rejected'))
        and not exists (
          select 1 from crm_customers o
          join lateral (select s.sold_at from crm_subscriptions s where s.crm_customer_id = o.crm_customer_id
                        order by s.sold_at, s.crm_subscription_id limit 1) os on true
          where m.email_hash is not null and o.email_hash = m.email_hash and o.crm_customer_id <> c.crm_customer_id
            and m.occurred_at >= os.sold_at - interval '60 days' and m.occurred_at <= os.sold_at + interval '2 hours'
            and (os.sold_at < fs.sold_at or (os.sold_at = fs.sold_at and o.crm_customer_id < c.crm_customer_id))
            and not exists (select 1 from v_identity_decisions k
                            where k.lead_id = m.id and k.crm_customer_id = o.crm_customer_id and k.status = 'rejected'))
      )
    )
  order by (m.attribution_evidence = 'none'), m.occurred_at, m.id
  limit 1
) touch on true;
