-- Backfill for 0018 (independent review F1, F5): rows stored BEFORE the source-semantics
-- mappers were active keep their old meaning unless they are corrected here, and a
-- re-delivery of an unchanged payload is a duplicate that never reaches the mapper again.
--
-- 1. A lead whose stored version the source marks outbound, spam or "not a lead" leaves every
--    lead metric (the same codes calls@1.2 gives). The lead row and its raw event are kept.
-- 2. Spend projected from a record that states a currency other than USD is withdrawn from
--    reporting and its raw event goes back to quarantine with CURRENCY_UNSUPPORTED: nothing is
--    converted, and the held record stays replayable once the currency is supported.
-- 3. Spend whose record stated USD is recorded as reported, not assumed.

update leads l
set excluded_code = case
      when re.payload ->> 'direction' = 'outbound' then 'NOT_INBOUND'
      when re.payload ->> 'spam' = 'true' then 'SPAM_CALL'
      else 'NOT_A_LEAD'
    end,
    excluded_at = now()
from raw_events re
where re.id = l.raw_event_id
  and l.source = 'calls'
  and l.excluded_code is null
  and (re.payload ->> 'direction' = 'outbound' or re.payload ->> 'spam' = 'true' or re.payload ->> 'lead_status' = 'not_a_lead');

with foreign_spend as (
  select s.campaign_id, s.spend_date, re.id as raw_event_id, re.payload ->> 'currencyCode' as currency
  from ad_spend_daily s join raw_events re on re.id = s.raw_event_id
  where re.payload ->> 'currencyCode' is not null and re.payload ->> 'currencyCode' <> 'USD'
), held as (
  update raw_events r
  set status = 'quarantined', error_code = 'CURRENCY_UNSUPPORTED',
      error_detail = 'spend_day: account currency ' || f.currency || '; only USD is summed (withdrawn by migration 0019)',
      projected_at = null
  from foreign_spend f
  where r.id = f.raw_event_id
  returning r.id
)
delete from ad_spend_daily s
using foreign_spend f
where s.campaign_id = f.campaign_id and s.spend_date = f.spend_date;

update ad_spend_daily s
set currency_basis = 'reported_usd'
from raw_events re
where re.id = s.raw_event_id and re.payload ->> 'currencyCode' = 'USD' and s.currency_basis <> 'reported_usd';
