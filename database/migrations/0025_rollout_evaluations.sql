-- Reliability Twin: staged rollout evaluations of a source-contract change (lib/twin/*).
--
-- An evaluation is a SIMULATION. It runs the production write paths (intake, re-projection,
-- the CRM sync worker, reconciliation) against an isolated copy of the synthetic world, a
-- separate database named in `twin_database`, never against this one. These two tables are its
-- control plane: what was planned, what ran, which gates passed, what was recovered. Nothing
-- here selects a mapper version for real traffic (lib/adapters/registry.ts still does that, for
-- every branch at once).
--
--   evaluation  RUNNING → PASSED (every stage passed) | FAILED (a gate failed; later stages
--               BLOCKED) | ERROR (the evaluation itself broke: no verdict)
--   stage       PENDING → RUNNING → PASSED | FAILED → RECOVERING → RECOVERED | FAILED;
--               PENDING → BLOCKED (an earlier stage failed: never executed);
--               RUNNING → INTERRUPTED (the evaluation errored or was abandoned mid-stage: no verdict)
-- A stage interrupted after a step committed but before it was acknowledged resumes from the
-- acknowledged steps (`steps`); its `recovery` says so.
--
-- One runner at a time: `runner_id` is a lease, renewed by `heartbeat_at` and checked by every
-- runner write; another runner may take it only once the heartbeat is stale. `progress_at` moves
-- only when a step starts or is acknowledged, so a runner that keeps its lease but makes no
-- progress (a hung lock, a hung query) is visible and can be abandoned.

create table rollout_evaluations (
  id               bigserial primary key,
  change_id        bigint not null references config_changes(id),
  scenario_id      text not null,
  variant          text not null,
  -- The scenario's definition and generated inputs, and the twin world's stored records before stage A.
  scenario_hash    text,
  source_hash      text,
  base_fingerprint text,
  -- The code that computed the verdict (lib/ and the migrations): a later code change makes it outdated.
  code_fingerprint text,
  from_versions    text[] not null,
  to_version       text not null,
  twin_database    text not null,
  status           text not null check (status in ('RUNNING', 'PASSED', 'FAILED', 'ERROR')),
  started_by       text not null,
  started_at       timestamptz not null,
  runner_id        text,
  heartbeat_at     timestamptz not null,
  progress_at      timestamptz not null,
  finished_at      timestamptz,
  error            text,
  summary          jsonb not null default '{}'
);
-- One evaluation of a change at a time: a second start is refused, not queued.
create unique index rollout_evaluations_one_running on rollout_evaluations (change_id) where status = 'RUNNING';
create index rollout_evaluations_change_idx on rollout_evaluations (change_id, id desc);

create table rollout_stages (
  evaluation_id  bigint not null references rollout_evaluations(id),
  ordinal        int not null,
  key            text not null,
  label          text not null,
  branch_ids     text[] not null,
  new_branch_ids text[] not null,
  status         text not null check (status in ('PENDING', 'RUNNING', 'PASSED', 'FAILED', 'BLOCKED', 'RECOVERING', 'RECOVERED', 'INTERRUPTED')),
  started_at     timestamptz,
  completed_at   timestamptz,
  attempts       int not null default 0,
  -- Acknowledged steps (name → when and what): a resumed stage skips these.
  steps          jsonb not null default '{}',
  gates          jsonb not null default '[]',
  violated       text[] not null default '{}',
  faults         jsonb not null default '[]',
  recovery       jsonb,
  evidence       jsonb not null default '{}',
  metrics        jsonb not null default '{}',
  primary key (evaluation_id, ordinal)
);
