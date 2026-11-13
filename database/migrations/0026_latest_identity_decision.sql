-- Independent review of the Reliability Twin, 2026-11-12 (financial findings 2 and 6).
--
-- 1. A pair a reviewer REJECTED, re-opened on new evidence and then ACCEPTED keeps both decided
--    rows (identity_conflicts is history). v_acquisitions (0024) let any rejected row veto the
--    pair, so the later acceptance credited nobody, while the identity module applies the latest
--    decision. Credit now follows the latest decision per (lead, customer): v_identity_decisions.
-- 2. A held spend day whose date looks like YYYY-MM-DD but is not a calendar date ("2026-02-30",
--    which the mapper quarantines) was cast with ::date by the scorecard's held-spend CTE, and
--    the cast failed the whole scorecard for every viewer. try_date() returns null instead.

create or replace function try_date(value text) returns date
language plpgsql immutable as $$
begin
  if value is null or value !~ '^[0-9]{4}-[0-9]{2}-[0-9]{2}$' then
    return null;
  end if;
  return value::date;
exception when others then
  return null;
end
$$;

-- The decision in force for each (lead, customer) pair: its latest accepted or rejected row.
create view v_identity_decisions as
select k.lead_id, k.crm_customer_id, k.status
from identity_conflicts k
where k.status in ('accepted', 'rejected')
  and not exists (select 1 from identity_conflicts n
                  where n.lead_id = k.lead_id and n.crm_customer_id = k.crm_customer_id
                    and n.status in ('accepted', 'rejected') and n.id > k.id);

-- 0024's view; only the identity-review lookups read v_identity_decisions. Columns unchanged.
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
  (touch.id is not null and touch.channel_code <> 'd2d'
   and exists (select 1 from channels ch where ch.code = touch.channel_code and ch.is_paid) and (
    exists (select 1 from leads d where d.phone_hash = c.phone_hash and d.attribution_evidence = 'rep_signature'
              and d.occurred_at > touch.occurred_at and d.occurred_at <= fs.sold_at + interval '2 hours')
    or exists (select 1 from leads d where d.email_hash = c.email_hash and d.attribution_evidence = 'rep_signature'
              and d.occurred_at > touch.occurred_at and d.occurred_at <= fs.sold_at + interval '2 hours')
  ))                                      as channel_conflict
from crm_customers c
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
  select a.status, a.completed_at
  from crm_appointments a
  where a.crm_subscription_id = fs.crm_subscription_id and a.kind = 'initial'
  order by (a.status = 'rescheduled'), a.scheduled_for desc
  limit 1
) ia on true
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
