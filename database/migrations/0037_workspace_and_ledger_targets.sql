-- The visitor workspace and ledger targets (docs/agent-work/release/RELEASE-DESIGN.md §5.1–§5.3, §9).
-- Additive: no existing column changes meaning, and a build from before this migration reads every
-- table it read before.
--
-- A workspace item belongs to one visitor (its owner, `visitor:<sha256 of the cookie token>`), is
-- readable only by that owner, and is deleted whole 24 hours after it starts (wall clock). Owners
-- are stored on parents only; child rows are reached through an owner-checked parent.

-- Workspace uploads share the onboarding tables: every build refuses onboarding to the guest, so an
-- older build cannot show them.
alter table onboarding_uploads
  add column workspace_owner text,
  add column workspace_started_at timestamptz,
  add constraint onboarding_uploads_workspace_pair check ((workspace_owner is null) = (workspace_started_at is null));
create index onboarding_uploads_workspace_owner_idx on onboarding_uploads (workspace_owner, id desc) where workspace_owner is not null;
create index onboarding_uploads_workspace_started_idx on onboarding_uploads (workspace_started_at) where workspace_owner is not null;

-- A mapping drafted on a workspace upload carries its owner, so layout-wide queries can leave it out.
alter table onboarding_mappings add column workspace_owner text;
create index onboarding_mappings_drafted_idx on onboarding_mappings (drafted_on_upload);

-- The ledger record a row was compared with, stored when the dry run compares it (§5.3).
alter table onboarding_row_results add column ledger_target jsonb;

-- Workspace investigations get their own tables: every older build lists `investigations` to any
-- guest, so separate tables fail closed. LIKE … INCLUDING DEFAULTS copies the id default, so both
-- tables draw ids from investigations_id_seq and an id never names two investigations.
create table workspace_investigations (like investigations including defaults including constraints including indexes);
alter table workspace_investigations
  add column workspace_owner text not null,
  add column workspace_started_at timestamptz not null default now();
create index workspace_investigations_owner_idx on workspace_investigations (workspace_owner, id desc);
create index workspace_investigations_started_idx on workspace_investigations (workspace_started_at);

create table workspace_investigation_steps (like investigation_steps including defaults including constraints including indexes);
alter table workspace_investigation_steps
  add constraint workspace_investigation_steps_investigation_fk
  foreign key (investigation_id) references workspace_investigations(id) on delete cascade;

-- Starts and rows written, counted before any work and never decreased when items are deleted
-- (§5.2). Buckets are date_trunc('minute' | 'day', now()) on the database clock (UTC).
create table workspace_quota (
  kind       text not null check (kind in ('upload', 'investigation')),
  bucket     text not null check (bucket in ('minute', 'day')),
  starts_at  timestamptz not null,
  items      integer not null default 0 check (items >= 0),
  rows       integer not null default 0 check (rows >= 0),
  primary key (kind, bucket, starts_at)
);
