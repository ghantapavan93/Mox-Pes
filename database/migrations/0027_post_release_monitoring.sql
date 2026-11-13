-- Scheduled post-release monitoring for ChangeGuard campaign mappings (R-30).
--
-- A released mapping used to be re-checked only when a person clicked Monitor, and every run,
-- passing or failing, overwrote verified_at. Now the worker runs one check per scheduled slot
-- for a window after each release (lib/changeguard/monitor.ts), and:
--
--   * verified_at stays the time the RELEASE was verified ("verified at release");
--   * last_verified_at is the latest SUCCESSFUL verification (the release, or a check that found
--     the mapping current). A check that fails, cannot certify, or errors never moves it;
--   * every check is a row in change_monitor_runs: what it read, what it concluded, and why.
--
-- All scheduling columns are on the business clock (app_clock), like released_at.

alter table config_changes
  -- The scheduled slot the next check answers; null = nothing scheduled (window over, replaced).
  add column monitor_due_at   timestamptz,
  -- The end of the monitoring window: no slot is scheduled after it.
  add column monitor_until    timestamptz,
  -- After a check errored: when the same slot is tried again (the slot itself does not move).
  add column monitor_retry_at timestamptz,
  add column last_verified_at timestamptz;

create index config_changes_monitor_due_idx on config_changes (monitor_due_at) where monitor_due_at is not null;

-- Changes released before this migration: a first slot one day after the release, a fourteen-day
-- window (lib/changeguard/monitor.ts: CHECK_EVERY_MS, WINDOW_MS). The release is verified in the
-- release transaction, so released_at is when it was verified. verified_at is left as it is
-- (history): a manual run before this migration may have overwritten it.
update config_changes
set monitor_until    = released_at + interval '14 days',
    monitor_due_at   = case when status in ('verified', 'degraded', 'recovery_required') then released_at + interval '1 day' end,
    last_verified_at = case when status = 'verified' then released_at end
where kind = 'campaign_mapping' and released_at is not null;

create table change_monitor_runs (
  id              bigserial primary key,
  change_id       bigint not null references config_changes(id),
  trigger         text not null check (trigger in ('scheduled', 'manual')),
  -- The scheduled slot this run answers (null for a manual run).
  slot_at         timestamptz,
  -- Business clock.
  ran_at          timestamptz not null,
  -- The worker (or person, for a manual run) that recorded it.
  ran_by          text not null,
  outcome         text not null check (outcome in ('current', 'insufficient_evidence', 'drift', 'superseded', 'error')),
  -- The campaign mapping version the conclusion is about: the fencing token the record step
  -- re-checks under the mapping lock (a newer release in between makes the run say so).
  mapping_version int,
  checks          jsonb not null default '[]'::jsonb,
  evidence        jsonb not null default '{}'::jsonb,
  -- Branches, campaigns and records the conclusion is about.
  scope           jsonb not null default '{}'::jsonb,
  -- The review item a confirmed drift created or updated.
  exception_id    bigint references exceptions(id),
  error           text,
  check ((outcome = 'error') = (error is not null)),
  check ((trigger = 'scheduled') = (slot_at is not null))
);
-- One conclusion per scheduled slot: a second worker that ran the same slot records nothing.
-- Errors are not conclusions: an errored slot is tried again and may then conclude.
create unique index change_monitor_runs_one_per_slot on change_monitor_runs (change_id, slot_at) where outcome <> 'error';
create index change_monitor_runs_change_idx on change_monitor_runs (change_id, id desc);

-- The review item for a confirmed drift: raised by monitoring, closed by a person (like
-- payload_conflict; reconciliation never resolves it).
alter table exceptions drop constraint exceptions_kind_check;
alter table exceptions add constraint exceptions_kind_check check (kind in (
  'quarantined_source_records',
  'payment_without_ticket',
  'branch_mismatch',
  'unmapped_spend',
  'channel_conflict',
  'payload_conflict',
  'channel_coverage_gap',
  'mapping_drift'));
