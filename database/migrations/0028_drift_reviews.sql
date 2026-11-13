-- A person's decision on a post-release drift case (the flagship review workflow, 2026-11-13).
--
-- A confirmed drift raises ONE review item per change (a mapping_drift exception with its Action
-- Center case, migration 0027). Until now nobody could record what they concluded: the case page
-- said "no manual action", and every later check rewrote the evidence. A review is now a row,
-- tied to the exact check the reviewer read and to that check's material facts
-- (lib/changeguard/facts.ts):
--
--   reviewed_no_change   the reviewer read the evidence and keeps the mapping. Closes the case
--                        (closed_acknowledged), the existing convention for "a person accepted
--                        it". The finding stays as recorded; nothing is re-verified.
--   needs_investigation  keeps the case open (investigating) with an accountable owner role and
--                        what needs checking.
--
-- A later check that carries the same facts leaves a reviewed case closed; one that carries a fact
-- the review did not see reopens the SAME case, once (lib/changeguard/monitor.ts). A review never
-- writes a mapping, spend, credit, source record or check result.
--
-- Reviews are history: append-only, like audit_log (0014).

create table case_reviews (
  id             bigserial primary key,
  case_id        bigint not null references cases(id),
  exception_id   bigint not null references exceptions(id),
  disposition    text not null check (disposition in ('reviewed_no_change', 'needs_investigation')),
  rationale      text not null check (length(btrim(rationale)) between 10 and 1000),
  -- The role accountable for the investigation (needs_investigation only).
  owner          text,
  actor_subject  text not null,
  actor_role     text not null,
  -- Business clock (app_clock), like every case event.
  reviewed_at    timestamptz not null,
  -- The check the reviewer read, and the material facts of that check (sorted) with their key.
  run_id         bigint not null references change_monitor_runs(id),
  evidence_key   text not null,
  facts          jsonb not null check (jsonb_typeof(facts) = 'array'),
  check ((disposition = 'needs_investigation') = (owner is not null))
);
create index case_reviews_case_idx on case_reviews (case_id, id desc);

create function case_reviews_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'case_reviews is append-only' using errcode = 'insufficient_privilege';
end $$;
create trigger case_reviews_append_only before update or delete on case_reviews
  for each row execute function case_reviews_append_only();

-- A review that changes no state (needs investigation recorded again on an investigating case) is
-- still an event in the case's history.
alter table case_events drop constraint case_events_event_check;
alter table case_events add constraint case_events_event_check check (event in (
  'transition', 'owner_assigned', 'proposal_created', 'proposal_superseded', 'dry_run',
  'approval', 'rejection', 'execution', 'execution_refused', 'review'));
