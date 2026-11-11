-- Data onboarding: unfamiliar exports are staged, profiled, mapped, dry-run and compared with
-- the ledger here, apart from every table a report reads. Nothing in this file changes an
-- existing table. A file reaches the ledger only through publication, which goes through the
-- same intake path as a live delivery (lib/ingest/ingest.ts) after independent approval.
--
-- Accountability: every source row ends with a disposition in onboarding_row_results, so no
-- row is ever silently dropped. Retention: row CELLS are personal data and are deleted when an
-- upload expires, is published or is deleted by a person; so are the row-result details that
-- quote cell values. The summary, the profile and every disposition stay as the accountable record.

create table onboarding_uploads (
  id                  bigserial primary key,
  filename            text not null check (length(filename) between 1 and 120),
  format              text not null check (format in ('csv', 'xlsx', 'json')),
  byte_size           integer not null check (byte_size > 0),
  file_sha256         text not null,
  sheet_name          text,
  uploaded_by         text not null,
  uploaded_role       text not null,
  uploaded_at         timestamptz not null,
  expires_at          timestamptz not null,
  status              text not null default 'staged'
                        check (status in ('staged', 'published', 'rejected', 'expired', 'deleted')),
  layout_fingerprint  text not null,
  row_count           integer not null check (row_count >= 0),
  column_count        integer not null check (column_count > 0),
  table_meta          jsonb not null,
  profile             jsonb not null,
  assistant           jsonb not null,
  rows_purged_at      timestamptz,
  check (expires_at > uploaded_at)
);
create index onboarding_uploads_expiry_idx on onboarding_uploads (expires_at) where rows_purged_at is null;

create table onboarding_rows (
  upload_id  bigint not null references onboarding_uploads(id) on delete cascade,
  ordinal    integer not null,
  cells      jsonb not null,
  primary key (upload_id, ordinal)
);

-- A mapping is versioned per (dataset, export layout). Approval is recorded, and the role that
-- approves can never be the role that proposed: separation of duties, enforced by the schema.
create table onboarding_mappings (
  id                  bigserial primary key,
  dataset             text not null check (dataset in ('calls', 'web_leads', 'crm_payments', 'ad_spend')),
  layout_fingerprint  text not null,
  version             integer not null check (version > 0),
  spec                jsonb not null,
  spec_hash           text not null,
  status              text not null check (status in ('proposed', 'approved', 'rejected', 'superseded')),
  drafted_on_upload   bigint not null references onboarding_uploads(id),
  proposed_by         text not null,
  proposed_role       text not null,
  proposed_at         timestamptz not null,
  decided_by          text,
  decided_role        text,
  decided_at          timestamptz,
  decision_reason     text,
  unique (dataset, layout_fingerprint, version),
  check ((status in ('approved', 'rejected', 'superseded')) = (decided_at is not null)),
  check (decided_role is null or decided_role <> proposed_role)
);
create unique index onboarding_mappings_one_approved on onboarding_mappings (dataset, layout_fingerprint) where status = 'approved';

create table onboarding_dry_runs (
  id          bigserial primary key,
  upload_id   bigint not null references onboarding_uploads(id),
  mapping_id  bigint not null references onboarding_mappings(id),
  spec_hash   text not null,
  ran_at      timestamptz not null,
  ran_by      text not null,
  summary     jsonb not null,
  ledger      jsonb not null
);
create index onboarding_dry_runs_upload_idx on onboarding_dry_runs (upload_id, id desc);

create table onboarding_row_results (
  dry_run_id        bigint not null references onboarding_dry_runs(id) on delete cascade,
  row_ref           integer not null,
  disposition       text not null check (disposition in
                      ('eligible', 'invalid', 'quarantined', 'duplicate_in_file', 'conflict_in_file',
                       'matches_ledger', 'differs_from_ledger', 'published')),
  code              text,
  field             text,
  detail            text,
  suggestion        text,
  safe_to_automate  boolean,
  external_id       text,
  raw_event_id      bigint references raw_events(id),
  primary key (dry_run_id, row_ref)
);

-- An upload publishes at most once, from one approved mapping and one dry run of it.
create table onboarding_publications (
  id              bigserial primary key,
  upload_id       bigint not null unique references onboarding_uploads(id),
  mapping_id      bigint not null references onboarding_mappings(id),
  dry_run_id      bigint not null references onboarding_dry_runs(id),
  published_by    text not null,
  published_role  text not null,
  published_at    timestamptz not null,
  stats           jsonb not null
);
