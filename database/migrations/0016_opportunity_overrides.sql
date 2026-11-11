-- Readiness overrides for revenue-opportunity journeys (lib/opportunities/readiness.ts).
-- A person with the approve permission may raise an opportunity's readiness by one level,
-- giving a reason, accepting named risks. The row keeps what was assessed at that moment, so a
-- later change in the data never rewrites what the person accepted.
create table opportunity_overrides (
  id              bigserial primary key,
  journey         text not null check (journey in ('missed_follow_up', 'retention')),
  period_key      text not null,
  -- '*' = all branches in scope; otherwise a sorted, comma-joined branch list.
  scope_key       text not null,
  assessed_level  text not null check (assessed_level in ('blocked', 'monitor', 'validate', 'act')),
  override_level  text not null check (override_level in ('blocked', 'monitor', 'validate', 'act')),
  accepted_risks  text[] not null,
  reason          text not null check (length(btrim(reason)) >= 20),
  assessment      jsonb not null,
  subject         text not null,
  role            text not null,
  created_at      timestamptz not null,
  check (override_level <> assessed_level)
);
create index opportunity_overrides_lookup_idx on opportunity_overrides (journey, period_key, scope_key, created_at desc);

-- Append-only, like the audit log: an override is withdrawn by a new decision, never edited.
create function opportunity_overrides_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'opportunity_overrides is append-only' using errcode = 'insufficient_privilege';
end $$;
create trigger opportunity_overrides_append_only
  before update or delete on opportunity_overrides
  for each row execute function opportunity_overrides_append_only();
