-- Action Center: every exception gets a case with an explicit state machine; fixes are
-- proposals that are dry-run (rolled back), approved by a different role, then executed by
-- the application once, with before/after snapshots and verification.
--
-- The legal transitions live in code (lib/workflow/states.ts) so the queue, the API and the
-- tests share one table; the check constraints here only keep values inside the vocabulary.
-- Identity conflicts and connector jobs are referenced by id inside params (jsonb), never by
-- foreign key, so the modules migrate independently.

create table cases (
  id            bigserial primary key,
  exception_id  bigint not null unique references exceptions(id),
  state         text not null check (state in (
                  'detected', 'investigating', 'proposed', 'dry_run_verified', 'awaiting_approval',
                  'applied', 'verified', 'resolved', 'failed', 'cancelled',
                  'closed_acknowledged', 'closed_unresolvable', 'closed_insufficient_evidence')),
  -- the role that owns the next step; null = unassigned
  owner         text,
  -- how many times the exception came back after the case was closed
  reopen_count  integer not null default 0 check (reopen_count >= 0),
  opened_at     timestamptz not null,
  updated_at    timestamptz not null,
  -- set while the case sits in a closed state, cleared when it re-opens
  closed_at     timestamptz
);
create index cases_state_idx on cases (state);

-- Everything that happened to a case, in order. A transition carries from/to state; other
-- events (owner assigned, dry run, approval, execution) carry detail only. Each row has a
-- matching audit_log row whose detail names this row's id (eventId).
create table case_events (
  id           bigserial primary key,
  case_id      bigint not null references cases(id),
  at           timestamptz not null,
  actor        text not null,
  event        text not null check (event in (
                 'transition', 'owner_assigned', 'proposal_created', 'proposal_superseded', 'dry_run',
                 'approval', 'rejection', 'execution', 'execution_refused')),
  from_state   text,
  to_state     text,
  proposal_id  bigint,
  detail       jsonb not null default '{}'::jsonb,
  check ((event = 'transition') = (to_state is not null))
);
create index case_events_case_idx on case_events (case_id, id);

create table action_proposals (
  id                        bigserial primary key,
  case_id                   bigint not null references cases(id),
  exception_id              bigint not null references exceptions(id),
  kind                      text not null check (kind in (
                              'remap_channel', 'replay_quarantine', 'map_campaign', 'override_lead_branch',
                              'acknowledge_exception', 'resolve_identity_conflict', 'trigger_sync')),
  params                    jsonb not null,
  rationale                 text not null,
  -- AI proposals are stored and processed exactly like human ones; the source is a label
  source                    text not null check (source in ('human', 'ai')),
  proposed_by               text not null,
  proposed_role             text not null,
  status                    text not null check (status in (
                              'draft', 'dry_run_failed', 'dry_run_ok', 'approved', 'stale',
                              'rejected', 'superseded', 'executed', 'failed')),
  created_at                timestamptz not null,
  updated_at                timestamptz not null,
  -- the latest dry run: before/after snapshots, verification, executor result or error
  dry_run                   jsonb,
  dry_run_at                timestamptz,
  dry_run_by                text,
  -- hash of the state the latest successful dry run saw; execution refuses if it changed
  precondition_fingerprint  text
);
create index action_proposals_case_idx on action_proposals (case_id, id);
-- At most one live proposal per case: a new proposal supersedes the previous one.
create unique index action_proposals_one_live_idx on action_proposals (case_id)
  where status in ('draft', 'dry_run_failed', 'dry_run_ok', 'approved', 'stale');

-- Approval decisions. An approval covers exactly one dry run (its fingerprint): a new dry
-- run needs a new approval.
create table action_approvals (
  id                        bigserial primary key,
  proposal_id               bigint not null references action_proposals(id),
  decision                  text not null check (decision in ('approved', 'rejected')),
  actor                     text not null,
  role                      text not null,
  reason                    text not null,
  precondition_fingerprint  text,
  decided_at                timestamptz not null
);
create index action_approvals_proposal_idx on action_approvals (proposal_id, id);

-- One execution per proposal, ever. The idempotency key is stable for the proposal and the
-- state it was approved against, so a repeated or concurrent request returns this row.
create table action_executions (
  id                   bigserial primary key,
  proposal_id          bigint not null unique references action_proposals(id),
  idempotency_key      text not null unique,
  request_fingerprint  text not null,
  actor                text not null,
  status               text not null check (status in ('succeeded', 'failed')),
  before               jsonb,
  after                jsonb,
  verification         jsonb,
  result               jsonb,
  error                text,
  started_at           timestamptz not null,
  finished_at          timestamptz not null
);

-- The audit page and case history filter by subject.
create index if not exists audit_log_subject_idx on audit_log (subject);
