-- Decision Lab: saved budget scenarios and experiment records.
--
-- Three questions are kept apart on purpose (see lib/decision/verdicts.ts):
--   data integrity       are the records classified and reconciled?        (computed, not stored)
--   decision readiness   is there enough reliable evidence to act?         (computed, not stored)
--   business effectiveness  did the spend CAUSE customers?                 (only from a randomized
--                        experiment stored here; never from attribution)
--
-- A scenario is a forecast from observational data. Its parameters and full result are stored
-- as they were computed, so a saved scenario can be read later exactly as the person saw it,
-- even after the underlying records are re-mapped. Readiness at save time is stored with it.

create table decision_scenarios (
  id              bigserial primary key,
  branch_id       text not null references branches(id),
  period_key      text not null check (period_key in ('oct', 'sep', 'all')),
  -- { changes: [{ fromChannel, toChannel, amountCents }], assumptions: { elasticity, ... } }
  params          jsonb not null,
  -- the complete ScenarioResult (lib/decision/scenario.ts), including its labels
  result          jsonb not null,
  decision_ready  boolean not null,
  actor           text not null,
  created_at      timestamptz not null
);
create index decision_scenarios_branch_idx on decision_scenarios (branch_id, created_at desc);

-- One row per experiment analysis. kind 'aa' validates the experimentation pipeline (two arms,
-- same treatment, no true effect); kind 'holdout' is a randomized test of one channel at one or
-- more branches and is the ONLY thing that can make a channel's effectiveness "measured".
--
-- Per-unit assignments are derived, not stored: arm = hash(salt, unit key), so the same config
-- reproduces the same split. result.assignmentFingerprint lets a re-run prove that it did.
create table experiments (
  id            bigserial primary key,
  kind          text not null check (kind in ('aa', 'holdout')),
  name          text not null,
  branch_ids    text[],                                 -- null = every branch
  channel_code  text references channels(code),         -- the channel a holdout withheld
  period_from   timestamptz not null,
  period_to     timestamptz not null,
  config        jsonb not null,
  result        jsonb not null,
  -- 'invalid' = the assignment integrity check (sample ratio) failed; results are not usable
  status        text not null check (status in ('completed', 'invalid')),
  conclusion    text not null,
  actor         text not null,
  created_at    timestamptz not null,
  check ((kind = 'holdout') = (channel_code is not null)),
  check (period_from < period_to)
);
create index experiments_created_idx on experiments (created_at desc);
