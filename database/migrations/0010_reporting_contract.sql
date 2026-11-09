-- Domain model, part 2: the PUBLISHED LANGUAGE for downstream BI (Power BI, Microsoft Fabric,
-- a warehouse load). docs/reporting-contract.md is the human half of this contract.
--
-- Rules
--   * Consumers read the reporting schema only, never public. Public tables are this
--     system's internal model and change whenever the model needs to.
--   * Every view has a stated grain and a version suffix. A breaking change (column removed,
--     renamed, retyped, or grain changed) ships as _v2 beside _v1; _v1 keeps working until its
--     consumers move. Adding a nullable column is not breaking.
--   * No contact details: no phone or email hashes, no free text a customer typed.
--   * Numbers follow docs/metric-definitions.md. Unknown stays unknown: a lead with no evidence
--     is channel 'unknown', and spend on an unmapped campaign has branch_id null.
--   * tests/integration/domain-model.test.ts pins every column and type, and checks that the
--     facts add up to the app's own metrics.

create schema if not exists reporting;

-- Grain: one row per branch.
create view reporting.dim_branch_v1 as
select b.id as branch_id, b.name as branch_name, b.region, b.timezone, b.crm_office_id,
       br.id as brand_id, br.name as brand_name
from branches b join brands br on br.id = b.brand_id;

-- Grain: one row per channel. measurement says what evidence can ever show its effect.
create view reporting.dim_channel_v1 as
select code as channel_code, label as channel_label, is_paid, cost_basis, measurement
from channels;

-- Grain: one row per campaign per spend date, as last reported by the ad platform.
-- branch_id is null for a campaign mapped to no branch (company-level unallocated spend).
-- classified_by is the mapper version whose classification produced channel_code (lineage).
create view reporting.fact_ad_spend_daily_v1 as
select s.spend_date, s.campaign_id, m.branch_id, b.brand_id, s.channel_code,
       s.cost_cents, s.clicks, s.platform_conversions,
       re.adapter_version as classified_by, s.raw_event_id as source_record_id
from ad_spend_daily s
left join campaign_branch_map m on m.campaign_id = s.campaign_id
left join branches b on b.id = m.branch_id
left join raw_events re on re.id = s.raw_event_id;

-- Grain: one row per lead record. prospect_key de-duplicates people across lead records:
-- count distinct prospect_key, never rows, for "prospects".
create view reporting.fact_leads_v1 as
select l.id as lead_id, l.source, l.occurred_at, l.effective_branch_id as branch_id, b.brand_id,
       l.channel_code, l.attribution_evidence, l.branch_overridden, l.prospect_key,
       l.raw_event_id as source_record_id
from v_leads l
left join branches b on b.id = l.effective_branch_id;

-- Grain: one row per acquired CRM customer (first subscription), with collected revenue to
-- date. Acquired = initial service completed (docs/metric-definitions.md).
create view reporting.fact_acquisitions_v1 as
select a.crm_customer_id, a.branch_id, b.brand_id, a.channel_code, a.attribution_basis, a.channel_conflict,
       a.sold_at, a.initial_status, a.initial_completed_at, a.annual_value_cents,
       coalesce(r.collected_cents, 0) as collected_cents
from v_acquisitions a
left join branches b on b.id = a.branch_id
left join v_customer_revenue r on r.crm_customer_id = a.crm_customer_id;

-- Grain: one row per reconciliation exception, any status. decision_blocking marks the kinds
-- that put a branch's budget signal on hold (lib/metrics/decision.ts).
create view reporting.fact_exceptions_v1 as
select e.id as exception_id, e.kind, e.severity, e.status, e.branch_id, b.brand_id, e.amount_cents,
       cardinality(coalesce(e.customer_ids, '{}')) as customers_referenced,
       e.first_detected_at, e.last_detected_at, e.resolved_at,
       e.kind in ('channel_coverage_gap', 'quarantined_source_records', 'unmapped_spend') as decision_blocking
from exceptions e
left join branches b on b.id = e.branch_id;

-- The contract describing itself, so a BI tool can list what it may rely on.
create view reporting.contract_v1 as
select * from (values
  ('dim_branch_v1', 'one row per branch'),
  ('dim_channel_v1', 'one row per channel'),
  ('fact_ad_spend_daily_v1', 'one row per campaign per spend date'),
  ('fact_leads_v1', 'one row per lead record'),
  ('fact_acquisitions_v1', 'one row per acquired CRM customer'),
  ('fact_exceptions_v1', 'one row per reconciliation exception')
) as c(view_name, grain);
