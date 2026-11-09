-- ChangeGuard: channel classification becomes a property of each mapped spend record, so a
-- mapping correction can be replayed over history instead of silently rewriting it.

-- How the platform types the campaign. Google types a migrated Local Services campaign as
-- PERFORMANCE_MAX with local services enabled (Google Ads API docs, 2026). Null where the
-- mapper version did not read these fields.
alter table ad_campaigns
  add column campaign_type text,
  add column local_services_enabled boolean not null default false;

-- The channel each spend record was classified into, by the mapper version that projected it.
-- ad_campaigns.channel_code keeps the latest classification; metrics read this column.
alter table ad_spend_daily add column channel_code text references channels(code);
update ad_spend_daily s set channel_code = c.channel_code from ad_campaigns c where c.id = s.campaign_id;
alter table ad_spend_daily alter column channel_code set not null;
create index ad_spend_daily_date_idx on ad_spend_daily (spend_date);

-- A platform replaced one campaign with another (for example LSA → Performance Max). Recorded
-- by a person or a replay with its evidence, never inferred silently.
create table campaign_lineage (
  predecessor_campaign_id  bigint primary key references ad_campaigns(id),
  successor_campaign_id    bigint not null references ad_campaigns(id),
  effective_date           date not null,
  evidence                 jsonb not null,
  recorded_by              text not null,
  recorded_at              timestamptz not null,
  check (predecessor_campaign_id <> successor_campaign_id)
);

-- A paid channel keeps producing leads at a branch while its spend stops.
alter table exceptions drop constraint exceptions_kind_check;
alter table exceptions add constraint exceptions_kind_check check (kind in (
  'quarantined_source_records',
  'payment_without_ticket',
  'branch_mismatch',
  'unmapped_spend',
  'channel_conflict',
  'payload_conflict',
  'channel_coverage_gap'));

-- Replays either retry held records or re-map records that were stored under an older mapper.
alter table replays add column mode text not null default 'quarantined' check (mode in ('quarantined', 'reproject'));
