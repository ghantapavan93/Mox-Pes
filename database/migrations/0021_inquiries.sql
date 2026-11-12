-- Investigation workspaces (2026-11-12): a question kept open with competing hypotheses, tested
-- against the stored records and re-tested on demand (lib/inquiry). Every test run is a version:
-- the hypotheses as they stood, so a reader can see what changed a conclusion. Notes are kept
-- with the workspace. Scoped like the branch the question is about.

create table inquiries (
  id          bigserial primary key,
  kind        text not null check (kind in ('cac_change')),
  branch_id   text not null references branches(id),
  question    text not null,
  created_by  text not null,
  created_at  timestamptz not null
);
create index inquiries_branch_idx on inquiries (branch_id, created_at desc);

create table inquiry_versions (
  inquiry_id         bigint not null references inquiries(id),
  version            integer not null check (version >= 1),
  tested_by          text not null,
  tested_at          timestamptz not null,
  conclusion_status  text not null check (conclusion_status in ('explained', 'partly_explained', 'unexplained', 'premise_false', 'not_testable')),
  result             jsonb not null,
  primary key (inquiry_id, version)
);

create table inquiry_notes (
  id          bigserial primary key,
  inquiry_id  bigint not null references inquiries(id),
  author      text not null,
  at          timestamptz not null,
  text        text not null check (length(text) between 3 and 2000)
);
create index inquiry_notes_inquiry_idx on inquiry_notes (inquiry_id, at);
