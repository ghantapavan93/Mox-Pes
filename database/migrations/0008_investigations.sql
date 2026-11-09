-- AI Investigation Engine: every investigation, every tool call it made, and evaluation runs.
--
-- An investigation is a question asked by a viewer (role + branch scope) and answered by a
-- fixed set of backend tools (lib/ai/tools.ts). The answer is stored as the validated output
-- contract (lib/ai/contract.ts); each claim in it cites evidence ids that a tool returned in
-- the same run, and investigation_steps keeps the tool calls those ids came from, so any
-- claim can be traced to the stored record behind it.
--
-- Proposals the planner created live in action_proposals (source = 'ai'); they are referenced
-- by id inside result (jsonb), never by foreign key, so the modules migrate independently.

create table investigations (
  id                bigserial primary key,
  question          text not null check (length(question) between 3 and 2000),
  -- the branch the viewer asked about (null = the viewer's whole scope)
  branch_id         text references branches(id),
  -- the viewer's branch scope when the investigation ran (null = all branches); reads of the
  -- investigation are limited to viewers whose scope covers it
  scope_branch_ids  text[],
  actor             text not null,
  -- 'model' = Anthropic Messages API tool loop; 'deterministic' = fixed tool plans, no model
  mode              text not null check (mode in ('deterministic', 'model')),
  model             text,
  intent            text,
  status            text not null check (status in ('running', 'completed', 'failed')),
  -- the validated output contract (summary, observations with evidence ids, proposals, ...)
  result            jsonb,
  -- grounding validator outcome: claims kept, dropped (unsupported evidence) and why
  grounding         jsonb,
  -- instruction-like text found inside tool data (prompt injection), ignored and listed here
  warnings          jsonb not null default '[]'::jsonb,
  input_tokens      integer not null default 0 check (input_tokens >= 0),
  output_tokens     integer not null default 0 check (output_tokens >= 0),
  -- estimated model cost in micro-dollars (integer); 0 for the deterministic investigator
  cost_micros       bigint not null default 0 check (cost_micros >= 0),
  latency_ms        integer check (latency_ms >= 0),
  error             text,
  -- business clock (app_clock), like every other timestamp the product writes
  created_at        timestamptz not null,
  finished_at       timestamptz,
  check ((status = 'running') = (finished_at is null))
);
create index investigations_created_idx on investigations (created_at desc, id desc);

-- One row per thing the investigation did, in order: tool calls (with their input, a summary
-- of the output, the evidence ids it returned and how long it took), model turns, the
-- analyst's grounding pass, planner decisions and injection warnings.
create table investigation_steps (
  id                bigserial primary key,
  investigation_id  bigint not null references investigations(id),
  seq               integer not null check (seq >= 1),
  stage             text not null check (stage in ('investigator', 'analyst', 'planner')),
  kind              text not null check (kind in ('tool_call', 'model_turn', 'analysis', 'proposal', 'warning')),
  tool              text,
  input             jsonb not null default '{}'::jsonb,
  output_summary    text not null,
  -- the tool's structured output, bounded (samples, not whole tables)
  output            jsonb,
  evidence_ids      text[] not null default '{}',
  status            text not null check (status in ('ok', 'error', 'forbidden', 'skipped')),
  error             text,
  ms                integer not null default 0 check (ms >= 0),
  at                timestamptz not null,
  unique (investigation_id, seq),
  check ((kind = 'tool_call') = (tool is not null))
);
create index investigation_steps_evidence_idx on investigation_steps using gin (evidence_ids);

-- Offline evaluation runs (scripts/eval-ai.ts): the dataset version, the mode evaluated and the
-- deterministic scorer's metrics, per case and in aggregate.
create table ai_eval_runs (
  id               bigserial primary key,
  ran_at           timestamptz not null,
  mode             text not null check (mode in ('deterministic', 'model')),
  dataset_version  text not null,
  cases            integer not null check (cases >= 0),
  passed           integer not null check (passed >= 0 and passed <= cases),
  metrics          jsonb not null,
  results          jsonb not null,
  actor            text not null
);
