-- Account currency rules (2026-11-12; held-out investigator IR-8, cases IV-24..IV-26).
--
-- Spend whose feed stated no currency is not dollars until someone authorized says the ad
-- account reports in USD (lib/currency/rules.ts). Until then it is excluded at intake (raw event
-- status 'excluded', code CURRENCY_UNSTATED) and shown wherever held records are. With a rule it
-- is stored as currency_basis 'account_rule_usd', so every figure built from it can say why it
-- counts as USD. Spend in another currency is still refused by the mapper and never converted.
--
-- Rows stored before this migration as 'assumed_usd' were counted as USD without anyone saying
-- so. They are excluded here (their raw events are kept) and come back the moment a rule covers
-- their account (reprojectHeld). That can lower a stored paid spend: it was money nobody had
-- established as dollars. 'assumed_usd' is then no longer a stored value.

-- Two people: an integration engineer proposes a rule, a different person with approval rights
-- authorizes it (the same maker-checker as every data change). Only an authorized, unrevoked
-- rule counts.
create table currency_rules (
  id              bigserial primary key,
  -- '*' as the account: every account of the platform; '*' as both: company-wide.
  platform        text not null check (platform in ('*', 'google_ads', 'google_lsa', 'microsoft_ads', 'meta')),
  ad_account_id   text not null,
  currency        text not null check (currency = 'USD'),
  proposed_by     text not null,
  proposed_at     timestamptz not null,
  reason          text not null check (length(reason) >= 10),
  authorized_by   text,
  authorized_at   timestamptz,
  revoked_at      timestamptz,
  revoked_by      text,
  revoked_reason  text,
  check ((authorized_at is null) = (authorized_by is null)),
  check (authorized_by is null or authorized_by <> proposed_by),
  check ((revoked_at is null) = (revoked_by is null)),
  check (platform <> '*' or ad_account_id = '*')
);
-- At most one live (pending or authorized) rule per account.
create unique index currency_rules_live_idx on currency_rules (platform, ad_account_id) where revoked_at is null;

with legacy as (
  delete from ad_spend_daily where currency_basis = 'assumed_usd' returning raw_event_id
)
update raw_events re
set status = 'excluded', error_code = null, error_detail = null, exclusion_code = 'CURRENCY_UNSTATED',
    exclusion_detail = 'stored before currency rules: the feed stated no currency and no authorized rule says this ad account reports in USD; not counted',
    projected_at = null
from legacy
where re.id = legacy.raw_event_id;

-- No assumed money and no silent default: every stored row says why its money is dollars.
alter table ad_spend_daily drop constraint ad_spend_daily_currency_basis_check;
alter table ad_spend_daily add constraint ad_spend_daily_currency_basis_check check (currency_basis in ('reported_usd', 'account_rule_usd'));
alter table ad_spend_daily alter column currency_basis drop default;
