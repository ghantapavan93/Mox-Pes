-- Attribution is derived, never stored. These views are the single definition of
-- "who is a new customer" and "which lead acquired them"; every metric reads them.
-- The policy is documented in docs/metric-definitions.md.

-- A lead's effective branch: the capturing system's branch, unless a person overrode it.
create view v_leads as
select
  l.*,
  coalesce(o.value, l.branch_id) as effective_branch_id,
  o.id is not null               as branch_overridden,
  -- One prospect = one phone, else one email. Approximation documented in
  -- docs/metric-definitions.md (no transitive identity merging).
  coalesce(l.phone_hash, l.email_hash) as prospect_key
from leads l
left join overrides o
  on o.subject_type = 'lead' and o.subject_id = l.id::text and o.field = 'branch_id';

-- One row per CRM customer: their FIRST subscription is the acquisition. A second
-- subscription (an existing customer adding mosquito, say) is never an acquisition.
create view v_acquisitions as
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
  (touch.id is not null and touch.channel_code <> 'd2d' and (
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
  order by (m.attribution_evidence = 'none'), m.occurred_at, m.id
  limit 1
) touch on true;

-- Collected revenue = successful payments minus refunds (refunds are negative rows).
-- Failed and voided payments never count. Booked or invoiced amounts never count.
create view v_customer_revenue as
select p.crm_customer_id, sum(p.amount_cents)::bigint as collected_cents
from crm_payments p
where p.status = 'successful'
group by p.crm_customer_id;
