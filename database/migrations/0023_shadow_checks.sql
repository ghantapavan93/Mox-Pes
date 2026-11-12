-- Shadow Mode (docs/agent-work/SHADOW-MODE.md): checks of another system's metric snapshots and
-- conversational answers against the product's evidence. Append-only: a check is never edited;
-- checking the same input again adds a row. It stores the input it was given and its result,
-- nothing of the other system beyond that.

create table shadow_checks (
  id          bigserial primary key,
  kind        text not null check (kind in ('snapshot', 'answer')),
  system      text not null,
  input       jsonb not null,
  input_hash  text not null check (input_hash ~ '^[0-9a-f]{64}$'),
  verdict     text not null check (verdict in (
                'MATCH', 'MISMATCH', 'INCOMPLETE_EVIDENCE', 'INCOMPATIBLE_DEFINITION', 'NOT_DETERMINABLE',
                'SUPPORTED', 'PARTLY_SUPPORTED', 'NOT_SUPPORTED')),
  result      jsonb not null,
  -- the scopes the check read: a viewer lists only checks whose every scope it may see
  branch_ids  text[] not null,
  company     boolean not null default false,
  actor       text not null,
  checked_at  timestamptz not null
);
create index shadow_checks_checked_idx on shadow_checks (checked_at desc, id desc);
create index shadow_checks_hash_idx on shadow_checks (input_hash);
