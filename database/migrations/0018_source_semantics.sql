-- Source semantics at live intake (R-17; held-out HO-24 / HO-25).
--
-- 1. An EXCLUDED raw event: a record the source itself says is not what the projection counts
--    (an outbound call, a call marked spam or "not a lead"). It is kept as evidence with its
--    reason, it is not an error (no quarantine, no exception, nothing to replay), and it never
--    reaches a trusted table.
-- 2. A lead whose LATER source revision is excluded keeps its row and history, but leaves every
--    lead metric: v_leads (the base of attribution, prospects, lead evidence and identity
--    resolution) no longer returns it. A later qualifying revision restores it.
-- 3. Spend records say whether their currency was REPORTED by the platform or ASSUMED (the feed
--    did not state it). Non-USD spend is refused by the mapper and never converted.

alter table raw_events drop constraint raw_events_status_check;
alter table raw_events add constraint raw_events_status_check check (status in ('projected', 'quarantined', 'replaying', 'excluded'));
alter table raw_events add column exclusion_code text, add column exclusion_detail text;
alter table raw_events add constraint raw_events_excluded_has_code check ((status = 'excluded') = (exclusion_code is not null));
create index raw_events_excluded_idx on raw_events (source, exclusion_code) where status = 'excluded';

alter table leads add column excluded_code text, add column excluded_at timestamptz;

-- Same columns, same order: only the eligibility filter is new (dependent views keep binding).
create or replace view v_leads as
select
  l.id, l.source, l.source_lead_id, l.branch_id, l.channel_code, l.attribution_evidence, l.campaign_external_id,
  l.click_id, l.phone_hash, l.email_hash, l.zip, l.heard_about_text, l.occurred_at, l.source_updated_at, l.raw_event_id,
  coalesce(o.value, l.branch_id) as effective_branch_id,
  o.id is not null               as branch_overridden,
  coalesce(l.phone_hash, l.email_hash) as prospect_key
from leads l
left join overrides o
  on o.subject_type = 'lead' and o.subject_id = l.id::text and o.field = 'branch_id'
where l.excluded_code is null;

-- Rows stored before this migration carried no currency: they were assumed to be USD.
alter table ad_spend_daily add column currency_basis text not null default 'assumed_usd'
  check (currency_basis in ('reported_usd', 'assumed_usd'));
