-- Revenue Signal — initial schema.
--
-- Four bounded contexts, one database:
--   reference     branches, territories, channels, campaigns, campaign→branch map
--   integration   ingestion runs, the raw event log, replays
--   projections   leads, CRM customers/subscriptions/appointments/tickets/payments, ad spend
--   reconciliation exceptions, overrides, audit log
--
-- Conventions
--   * money is integer cents (bigint); never float.
--   * every timestamp is timestamptz. Two clocks are kept: the source clock
--     (occurred_at / source_updated_at) and our clock (received_at).
--   * enumerations are CHECK constraints, not Postgres enums, so a migration can
--     widen them without a type rewrite.
--   * projection tables reference each other by source natural keys WITHOUT foreign
--     keys. Sources deliver out of order (a payment can arrive before its ticket);
--     an orphan is a reconciliation exception, not an insert failure.

create table branches (
  id             text primary key,                 -- short code, e.g. 'B24' (fictional)
  name           text not null,
  region         text not null,
  timezone       text not null,                    -- IANA zone; AZ has no DST
  crm_office_id  integer not null unique           -- the CRM's officeID for this branch
);

-- The branch a raw payload belongs to, whatever its source shape — but only ever a KNOWN
-- branch. A payload naming an unknown branch maps to null, so it can be quarantined and
-- reported without breaking anything that references branches(id).
create function payload_branch(p jsonb) returns text
language sql stable as $$
  select b.id from branches b
  where b.id = coalesce(p->>'branch_tag', p->'properties'->>'branch_id', p->>'branchId')
     or b.crm_office_id = case when p->>'officeID' ~ '^[0-9]{1,9}$' then (p->>'officeID')::int end
  order by (b.id = coalesce(p->>'branch_tag', p->'properties'->>'branch_id', p->>'branchId')) desc
  limit 1
$$;

-- Which branch serves a zip. Authoritative for service delivery. The website keeps its
-- own copy of this lookup (see website_zip_branch_snapshot in the simulator), and the two
-- can drift.
create table branch_territories (
  zip        char(5) primary key,
  branch_id  text not null references branches(id)
);

create table channels (
  code     text primary key,
  label    text not null,
  is_paid  boolean not null,
  -- Paid media is bought per campaign. D2D cost is commission, not media spend, so it is
  -- excluded from paid-media CAC by design (see docs/metric-definitions.md).
  cost_basis text not null check (cost_basis in ('media', 'commission', 'none'))
);

create table ad_campaigns (
  id                    bigserial primary key,
  platform              text not null check (platform in ('google_ads', 'google_lsa', 'microsoft_ads', 'meta')),
  ad_account_id         text not null,
  external_campaign_id  text not null,
  name                  text not null,
  channel_code          text not null references channels(code),
  first_seen_at         timestamptz not null,
  unique (platform, external_campaign_id)
);

-- Spend is bought per campaign; branches are a business concept. This mapping is
-- maintained by people and can be missing for a new campaign — an explicit exception.
create table campaign_branch_map (
  campaign_id  bigint primary key references ad_campaigns(id),
  branch_id    text not null references branches(id),
  mapped_by    text not null,
  mapped_at    timestamptz not null
);

-- ───────────────────────────── integration ─────────────────────────────

-- A stream is one pollable feed (crm.appointment, calls, ads…). Its cursor advances
-- only when a run succeeds, so a failed run is retried by the next run's window.
create table source_cursors (
  stream      text primary key,
  cursor_at   timestamptz not null,
  updated_at  timestamptz not null
);

create table ingestion_runs (
  id               bigserial primary key,
  source           text not null check (source in ('crm', 'calls', 'web', 'd2d', 'ads')),
  stream           text not null,
  adapter_version  text not null,
  window_start     timestamptz,
  window_end       timestamptz,
  started_at       timestamptz not null,
  finished_at      timestamptz,
  fetched          integer not null default 0,
  inserted         integer not null default 0,
  duplicates       integer not null default 0,
  conflicts        integer not null default 0,
  projected        integer not null default 0,
  quarantined      integer not null default 0,
  status           text not null default 'running' check (status in ('running', 'succeeded', 'failed')),
  error            text
);

-- The raw event log. Every delivery from every source lands here first, exactly once
-- per (source, external_id). external_id identifies a *version* of a source record
-- (entity:id:updated-at), so a re-read of the same version is a duplicate delivery and
-- a genuinely new version is a new row.
create table raw_events (
  id                 bigserial primary key,
  source             text not null,
  entity             text not null,
  entity_id          text not null,
  external_id        text not null,
  payload            jsonb not null,
  payload_hash       text not null,
  occurred_at        timestamptz not null,
  received_at        timestamptz not null,
  ingestion_run_id   bigint references ingestion_runs(id),
  adapter_version    text not null,
  status             text not null check (status in ('projected', 'quarantined', 'replaying')),
  error_code         text,
  error_detail       text,
  delivery_count     integer not null default 1 check (delivery_count >= 1),
  last_delivered_at  timestamptz not null,
  projected_at       timestamptz,
  unique (source, external_id),
  check ((status = 'quarantined') = (error_code is not null))
);
create index raw_events_quarantined_idx on raw_events (source, error_code) where status = 'quarantined';
create index raw_events_entity_idx on raw_events (source, entity, entity_id);
create index raw_events_received_idx on raw_events (source, received_at desc);

create table replays (
  id                 bigserial primary key,
  idempotency_key    text not null unique,
  -- what the key was used for; the same key with a different request is refused (409)
  request_fingerprint text not null,
  exception_id       bigint,                      -- the quarantine group it was run for, if any
  dry_run            boolean not null,
  actor              text not null,
  adapter_version    text not null,
  requested_ids      bigint[] not null,
  claimed            integer not null,
  projected          integer not null,
  still_quarantined  integer not null,
  metric_before      jsonb,
  metric_after       jsonb,
  requested_at       timestamptz not null,
  finished_at        timestamptz not null
);

-- ───────────────────────────── projections ─────────────────────────────

create table leads (
  id                    bigserial primary key,
  source                text not null check (source in ('web', 'calls', 'd2d')),
  source_lead_id        text not null,
  branch_id             text references branches(id),     -- as assigned by the capturing system
  channel_code          text not null references channels(code),
  attribution_evidence  text not null check (attribution_evidence in
                          ('click_id', 'utm', 'tracking_number', 'lsa_lead', 'rep_signature', 'none')),
  campaign_external_id  text,                                -- resolved to ad_campaigns at query time
  click_id              text,
  phone_hash            text,
  email_hash            text,
  zip                   char(5),
  heard_about_text      text,
  occurred_at           timestamptz not null,
  source_updated_at     timestamptz not null,
  raw_event_id          bigint not null references raw_events(id),
  unique (source, source_lead_id),
  check (phone_hash is not null or email_hash is not null),
  check ((channel_code = 'unknown') = (attribution_evidence = 'none'))
);
create index leads_phone_idx on leads (phone_hash, occurred_at);
create index leads_email_idx on leads (email_hash, occurred_at);
create index leads_occurred_idx on leads (occurred_at);

create table crm_customers (
  crm_customer_id    bigint primary key,
  office_id          integer not null,
  source_label       text,                 -- customer.sourceID as typed by an agent or rep
  phone_hash         text,
  email_hash         text,
  zip                char(5),
  created_at_source  timestamptz not null,
  source_updated_at  timestamptz not null,
  raw_event_id       bigint not null references raw_events(id)
);
create index crm_customers_phone_idx on crm_customers (phone_hash);
create index crm_customers_email_idx on crm_customers (email_hash);

create table crm_subscriptions (
  crm_subscription_id  bigint primary key,
  crm_customer_id      bigint not null,
  office_id            integer not null,
  service_type         text not null,
  sold_by_rep          text,
  source_label         text,
  annual_value_cents   bigint not null check (annual_value_cents >= 0),
  status               text not null check (status in ('active', 'cancelled')),
  sold_at              timestamptz not null,
  cancelled_at         timestamptz,
  source_updated_at    timestamptz not null,
  raw_event_id         bigint not null references raw_events(id)
);
create index crm_subscriptions_customer_idx on crm_subscriptions (crm_customer_id);

create table crm_appointments (
  crm_appointment_id   bigint primary key,
  crm_subscription_id  bigint not null,
  crm_customer_id      bigint not null,
  office_id            integer not null,
  kind                 text not null check (kind in ('initial', 'recurring')),
  status               text not null check (status in ('pending', 'completed', 'no_show', 'cancelled', 'rescheduled')),
  scheduled_for        timestamptz not null,
  completed_at         timestamptz,
  source_updated_at    timestamptz not null,
  raw_event_id         bigint not null references raw_events(id),
  check ((status = 'completed') = (completed_at is not null))
);
create index crm_appointments_subscription_idx on crm_appointments (crm_subscription_id);

create table crm_tickets (
  crm_ticket_id       bigint primary key,
  crm_appointment_id  bigint,
  crm_customer_id     bigint not null,
  office_id           integer not null,
  template_type       char(1) not null check (template_type in ('I', 'R')),
  total_cents         bigint not null check (total_cents >= 0),
  invoiced_at         timestamptz not null,
  source_updated_at   timestamptz not null,
  raw_event_id        bigint not null references raw_events(id)
);
create index crm_tickets_appointment_idx on crm_tickets (crm_appointment_id);
create index crm_tickets_customer_idx on crm_tickets (crm_customer_id);

-- A refund is its own payment row with a negative amount and original_payment_id set.
create table crm_payments (
  crm_payment_id       bigint primary key,
  crm_ticket_id        bigint,
  crm_customer_id      bigint not null,
  office_id            integer not null,
  amount_cents         bigint not null check (amount_cents <> 0),
  original_payment_id  bigint,
  status               text not null check (status in ('successful', 'failed', 'voided')),
  paid_at              timestamptz not null,
  source_updated_at    timestamptz not null,
  raw_event_id         bigint not null references raw_events(id),
  check ((amount_cents < 0) = (original_payment_id is not null))
);
create index crm_payments_ticket_idx on crm_payments (crm_ticket_id);
create index crm_payments_paid_idx on crm_payments (paid_at);
create index crm_payments_customer_idx on crm_payments (crm_customer_id);

create table ad_spend_daily (
  campaign_id           bigint not null references ad_campaigns(id),
  spend_date            date not null,
  cost_cents            bigint not null check (cost_cents >= 0),
  clicks                integer not null check (clicks >= 0),
  platform_conversions  integer not null check (platform_conversions >= 0),
  source_updated_at     timestamptz not null,
  raw_event_id          bigint not null references raw_events(id),
  primary key (campaign_id, spend_date)
);

-- ───────────────────────────── reconciliation ─────────────────────────────

create table exceptions (
  id                 bigserial primary key,
  kind               text not null check (kind in (
                       'quarantined_source_records',
                       'payment_without_ticket',
                       'branch_mismatch',
                       'unmapped_spend',
                       'channel_conflict',
                       'payload_conflict')),
  severity           text not null check (severity in ('high', 'medium', 'low')),
  -- kind + subject. Detection is idempotent: re-running reconciliation updates the same
  -- row instead of creating a new one.
  fingerprint        text not null unique,
  branch_id          text references branches(id),
  subject_type       text not null,
  subject_id         text not null,
  summary            text not null,
  evidence           jsonb not null,
  amount_cents       bigint not null default 0 check (amount_cents >= 0),
  -- customers this exception touches; revenue at risk is summed over DISTINCT customers
  customer_ids       bigint[] not null default '{}',
  -- acknowledged = a person accepted a condition that will not change (e.g. a historical
  -- channel conflict); re-detection does not re-open it
  status             text not null default 'open' check (status in ('open', 'resolved', 'acknowledged')),
  resolution         text,
  first_detected_at  timestamptz not null,
  last_detected_at   timestamptz not null,
  resolved_at        timestamptz,
  check ((status = 'resolved') = (resolved_at is not null))
);
create index exceptions_open_idx on exceptions (branch_id, kind) where status = 'open';

-- Human decisions. We never write back to a source system; we record the decision here,
-- with who and why, and metrics read it.
create table overrides (
  id            bigserial primary key,
  subject_type  text not null,
  subject_id    text not null,
  field         text not null,
  value         text not null,
  reason        text not null,
  actor         text not null,
  created_at    timestamptz not null,
  unique (subject_type, subject_id, field)
);

create table audit_log (
  id       bigserial primary key,
  at       timestamptz not null,
  actor    text not null,
  action   text not null,
  subject  text not null,
  detail   jsonb not null default '{}'::jsonb
);
create index audit_log_at_idx on audit_log (at desc);

-- The simulation clock. In production "now" is the wall clock; the demo dataset is
-- frozen at a fixed instant so every number reproduces.
create table app_clock (
  id   boolean primary key default true check (id),
  now  timestamptz not null
);
