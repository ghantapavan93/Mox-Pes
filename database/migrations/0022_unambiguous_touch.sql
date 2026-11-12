-- Independent review 2026-11-12, finding 1: one paid call credited two customers.
--
-- v_acquisitions matched a customer's first touch by phone or email alone. A call from a phone
-- that two CRM customers share became the paid first touch of BOTH, inflating paid customers and
-- understating paid CAC (SR-4). Identity resolution already treats such a lead as ambiguous (a
-- pending shared_phone / shared_email / phone_email_disagree conflict); attribution ignored that.
--
-- Now a lead is a customer's touch only when it is unambiguous: its phone and its email point at
-- no OTHER CRM customer, unless a reviewer accepted this lead for this customer. A pair a reviewer
-- rejected is never a touch. Columns are unchanged, so reporting.fact_acquisitions_v1 keeps
-- working. The seeded world gives every person their own phone: no demo number changes.

create or replace view v_acquisitions as
select
  c.crm_customer_id,
  fs.crm_subscription_id,
  b.id                                    as branch_id,
  fs.sold_at,
  fs.sold_by_rep,
  fs.subscription_status,
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
  -- D2D rep signed a customer that a paid touch reached first: commission and media
  -- cost were both spent on one customer. Credited first-touch, flagged for review.
  -- Only a PAID first touch competes with the rep's commission (docs/metric-definitions.md);
  -- an organic or tracking-number touch followed by a signature is not a credit dispute.
  (touch.id is not null and touch.channel_code <> 'd2d'
   and exists (select 1 from channels ch where ch.code = touch.channel_code and ch.is_paid) and (
    exists (select 1 from leads d where d.phone_hash = c.phone_hash and d.attribution_evidence = 'rep_signature'
              and d.occurred_at > touch.occurred_at and d.occurred_at <= fs.sold_at + interval '2 hours')
    or exists (select 1 from leads d where d.email_hash = c.email_hash and d.attribution_evidence = 'rep_signature'
              and d.occurred_at > touch.occurred_at and d.occurred_at <= fs.sold_at + interval '2 hours')
  ))                                      as channel_conflict
from crm_customers c
-- Per-customer indexed lookups (not DISTINCT ON over whole tables): with a branch or date
-- filter pushed into the view, a DISTINCT ON subquery was re-run per row (33 s → ms).
join lateral (
  select s.crm_subscription_id, s.office_id, s.sold_at, s.sold_by_rep,
         s.status as subscription_status, s.annual_value_cents
  from crm_subscriptions s
  where s.crm_customer_id = c.crm_customer_id
  order by s.sold_at, s.crm_subscription_id
  limit 1
) fs on true
left join branches b on b.crm_office_id = fs.office_id
left join lateral (
  -- a rescheduled initial is superseded by its replacement; prefer the live one
  select a.status, a.completed_at
  from crm_appointments a
  where a.crm_subscription_id = fs.crm_subscription_id and a.kind = 'initial'
  order by (a.status = 'rescheduled'), a.scheduled_for desc
  limit 1
) ia on true
left join lateral (
  -- First touch WITH evidence inside the 60-day lookback; a touch without evidence only
  -- if nothing better exists. "Unknown" is never upgraded to a paid channel.
  -- Phone and email are matched as two separate index lookups (an OR defeats both indexes).
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
    -- a reviewer said this lead is not this customer
    not exists (select 1 from identity_conflicts k
                where k.lead_id = m.id and k.crm_customer_id = c.crm_customer_id and k.status = 'rejected')
    and (
      -- a reviewer accepted this lead for this customer
      exists (select 1 from identity_conflicts k
              where k.lead_id = m.id and k.crm_customer_id = c.crm_customer_id and k.status = 'accepted')
      -- or the lead points at no other customer, by phone or by email (two indexed lookups)
      or (not exists (select 1 from crm_customers o
                      where m.phone_hash is not null and o.phone_hash = m.phone_hash and o.crm_customer_id <> c.crm_customer_id)
          and not exists (select 1 from crm_customers o
                          where m.email_hash is not null and o.email_hash = m.email_hash and o.crm_customer_id <> c.crm_customer_id))
    )
  order by (m.attribution_evidence = 'none'), m.occurred_at, m.id
  limit 1
) touch on true;
