-- Revenue Signal OS — CRM connectors, sync jobs, checkpoints, API call trace, mock faults.
--
-- A connector is a read-only client for one CRM tenant. Credentials are NEVER stored here:
-- `config` holds the NAMES of environment variables (per office) that hold the key and the
-- token; the worker resolves them at run time. The demo connector points at the local
-- FieldRoutes-compatible mock (synthetic data, no real FieldRoutes host, no real credentials).
--
-- Two clocks, as everywhere else in this schema:
--   * job scheduling (requested/started/finished/next_attempt/heartbeat) is OPERATIONAL wall time;
--   * windows and checkpoints (window_start/end, cursor_at) are on the BUSINESS clock
--     (app_clock), because they describe positions in the source's data.
--
-- Cross-module references (branches, raw events) go through ids, not foreign keys, so this
-- module migrates independently of the others.

create table connectors (
  id            bigserial primary key,
  slug          text not null unique,
  provider      text not null check (provider in ('fieldroutes')),
  display_name  text not null,
  -- The base URL ends at the API root ("…/api" on a real tenant). base_url_env, when set in
  -- the environment, overrides base_url so a deployment can point the same row elsewhere.
  base_url      text not null,
  base_url_env  text,
  -- { credentials: { keyEnv, tokenEnv, allowDemoKeys }, timeoutMs, wireTimeZone, initialLookbackHours,
  --   officeIds (null = every branch), maxAttempts }  — validated by lib/connectors/config.ts.
  config        jsonb not null,
  -- Synthetic connectors are labelled everywhere in the UI; nothing here is a real integration.
  synthetic     boolean not null default true,
  enabled       boolean not null default true,
  created_at    timestamptz not null default now()
);

create table sync_jobs (
  id                   bigserial primary key,
  connector_id         bigint not null references connectors(id),
  office_id            integer not null,
  entity               text not null check (entity in ('customer', 'subscription', 'appointment', 'ticket', 'payment')),
  state                text not null default 'queued' check (state in ('queued', 'running', 'succeeded', 'failed', 'cancelled')),
  -- request key + office + entity: a repeated request is a no-op, not a second job.
  idempotency_key      text not null unique,
  request_key          text not null,
  request_fingerprint  text not null,
  retry_of             bigint references sync_jobs(id),
  requested_by         text not null,
  requested_at         timestamptz not null,
  attempts             integer not null default 0 check (attempts >= 0),
  max_attempts         integer not null default 5 check (max_attempts >= 1),
  next_attempt_at      timestamptz not null,
  started_at           timestamptz,
  heartbeat_at         timestamptz,
  finished_at          timestamptz,
  claimed_by           text,
  cancel_requested     boolean not null default false,
  -- The window is fixed on the first attempt; retries re-read the SAME window and resume after
  -- the last id whose batch committed (resume_after_id), so a retry never skips or re-fetches.
  window_start         timestamptz,
  window_end           timestamptz,
  resume_after_id      bigint,
  -- { searched, fetched, inserted, duplicates, conflicts, projected, quarantined, rejected, missing, batches }
  stats                jsonb not null default '{}'::jsonb,
  last_error           text,
  last_error_kind      text,
  check ((state in ('succeeded', 'failed', 'cancelled')) = (finished_at is not null))
);
-- At most one RUNNING job per connector + office + entity: two workers can never interleave
-- batches (and checkpoint writes) for the same stream.
create unique index sync_jobs_one_running on sync_jobs (connector_id, office_id, entity) where state = 'running';
create index sync_jobs_claim_idx on sync_jobs (next_attempt_at, id) where state = 'queued';
create index sync_jobs_connector_idx on sync_jobs (connector_id, requested_at desc, id desc);
create index sync_jobs_request_idx on sync_jobs (request_key);

-- Position per connector + office + entity on the business clock. Advanced only in the same
-- transaction as the batch that completes a window, and never backwards.
create table sync_checkpoints (
  connector_id    bigint not null references connectors(id),
  office_id       integer not null,
  entity          text not null,
  cursor_at       timestamptz not null,
  last_job_id     bigint references sync_jobs(id),
  records_synced  bigint not null default 0,
  updated_at      timestamptz not null,
  primary key (connector_id, office_id, entity)
);

-- Every HTTP call a job made, success or not. Credentials are never recorded (they travel in
-- headers, which are not logged); ids are the ids requested (get) or returned (search, capped).
create table sync_api_calls (
  id           bigserial primary key,
  job_id       bigint references sync_jobs(id),
  connector_id bigint not null references connectors(id),
  attempt      integer not null,
  office_id    integer not null,
  entity       text not null,
  action       text not null,
  method       text not null,
  path         text not null,
  status       integer,
  ms           integer not null check (ms >= 0),
  ids          bigint[] not null default '{}',
  id_count     integer not null default 0,
  error_kind   text,
  error        text,
  at           timestamptz not null
);
create index sync_api_calls_job_idx on sync_api_calls (job_id, id);
create index sync_api_calls_connector_idx on sync_api_calls (connector_id, at desc);

-- Fault injection for the MOCK FieldRoutes server only. A fault fires on matching requests
-- (office/entity/action; null = any) after `skip_remaining` matches have passed, and
-- `remaining` times (null = until cleared).
create table mock_fieldroutes_faults (
  id              bigserial primary key,
  kind            text not null check (kind in ('rate_limit', 'expired_key', 'timeout', 'unavailable', 'malformed_record',
                                                'missing_timestamp', 'disappeared_record', 'out_of_order')),
  office_id       integer,
  entity          text check (entity in ('customer', 'subscription', 'appointment', 'ticket', 'payment')),
  action          text check (action in ('search', 'get')),
  record_id       bigint,
  remaining       integer check (remaining >= 0),
  skip_remaining  integer not null default 0 check (skip_remaining >= 0),
  params          jsonb not null default '{}'::jsonb,
  active          boolean not null default true,
  fired           integer not null default 0,
  created_by      text not null,
  created_at      timestamptz not null,
  cleared_at      timestamptz,
  check (active = (cleared_at is null))
);
create index mock_fieldroutes_faults_active_idx on mock_fieldroutes_faults (id) where active;

-- The demo connector: a synthetic FieldRoutes-compatible tenant served by this app's own mock.
-- Office keys are the mock's documented demo keys unless FIELDROUTES_KEY_<office> /
-- FIELDROUTES_TOKEN_<office> are set. No synced history: the Studio shows jobs once started.
insert into connectors (slug, provider, display_name, base_url, base_url_env, config, synthetic)
values (
  'fieldroutes-demo',
  'fieldroutes',
  'FieldRoutes-compatible CRM (synthetic mock)',
  'http://localhost:3000/api/mock/fieldroutes',
  'FIELDROUTES_MOCK_BASE_URL',
  '{
     "credentials": { "keyEnv": "FIELDROUTES_KEY_{officeId}", "tokenEnv": "FIELDROUTES_TOKEN_{officeId}", "allowDemoKeys": true },
     "timeoutMs": 15000,
     "wireTimeZone": "office",
     "initialLookbackHours": 168,
     "officeIds": null,
     "maxAttempts": 5
   }'::jsonb,
  true
);
