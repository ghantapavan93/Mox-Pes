-- Domain model, part 1 (docs/domain-model.md).
--
--   * Organization (shared kernel): Company → Brand → Branch. A brand groups branches; scope,
--     metrics and the reporting contract can all be cut by brand. Brand names are public; the
--     branch → brand assignment is synthetic (lib/reference.ts).
--   * Channels gain a measurement class: what evidence can ever show a channel's effect.
--   * Domain events: a transactional outbox. A context records a fact in the SAME transaction
--     as the change; other contexts react later, at least once, and their reactions are
--     idempotent. Each event remembers the transaction that wrote it (txid) so a consumer can
--     prove, by snapshot visibility, that a later run of its own already saw the change.

create table brands (
  id    text primary key,
  name  text not null unique
);

insert into brands (id, name) values
  ('moxie', 'Moxie Pest Control'),
  ('joshuas', 'Joshua''s Pest Control'),
  ('mission', 'Mission Pest Control');

alter table branches add column brand_id text not null default 'moxie' references brands(id);
create index branches_brand_idx on branches (brand_id);

alter table channels drop constraint channels_cost_basis_check;
alter table channels add constraint channels_cost_basis_check check (cost_basis in ('media', 'commission', 'sponsorship', 'none'));
alter table channels add column measurement text not null default 'touch_attributed'
  check (measurement in ('touch_attributed', 'rep_recorded', 'landing_inferred', 'experiment_only', 'no_evidence'));

create table domain_events (
  id           bigserial primary key,
  -- '<context>.<fact in the past tense>', e.g. 'intake.records_stored'.
  type         text not null check (type ~ '^[a-z_]+\.[a-z_]+$'),
  context      text not null generated always as (split_part(type, '.', 1)) stored,
  subject      text,
  payload      jsonb not null default '{}',
  -- Business clock (app_clock), like every other business timestamp.
  occurred_at  timestamptz not null,
  -- Wall clock of the insert, for operations.
  recorded_at  timestamptz not null default clock_timestamp(),
  -- The writing transaction. pg_visible_in_snapshot(txid, s) answers "did a run that took
  -- snapshot s see this change?" without trusting id order, which is not commit order.
  txid         xid8 not null default pg_current_xact_id()
);
create index domain_events_type_idx on domain_events (type, id);

-- At-least-once delivery bookkeeping: one row per (consumer, event) once the consumer has
-- provably reflected the event. Per-event rows, not an offset, because ids are not committed
-- in order and an offset would skip an event whose transaction committed late.
create table event_deliveries (
  consumer      text not null,
  event_id      bigint not null references domain_events(id) on delete cascade,
  delivered_at  timestamptz not null default clock_timestamp(),
  primary key (consumer, event_id)
);

create table event_consumers (
  consumer        text primary key,
  runs            bigint not null default 0,
  events_handled  bigint not null default 0,
  last_run_at     timestamptz,
  last_error      text,
  last_error_at   timestamptz
);
