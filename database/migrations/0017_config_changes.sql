-- Marketing ChangeGuard: versioned configuration changes with preflight, bound approval and
-- post-release verification (lib/changeguard). Proactive: a change is checked BEFORE it lands,
-- where the Action Center fixes what an exception already shows.
--
-- One registry: campaign_branch_map stays the live mapping every metric reads. This migration
-- only adds the history of its versions and the change proposals that move it.

create table config_changes (
  id               bigserial primary key,
  kind             text not null check (kind in ('campaign_mapping', 'source_contract')),
  status           text not null check (status in (
                     'draft', 'preflight_failed', 'ready_for_review', 'approved', 'rejected',
                     'monitoring', 'verified', 'degraded', 'recovery_required', 'superseded')),
  title            text not null,
  -- A corrected resubmission points at the change it replaces (which becomes 'superseded').
  supersedes       bigint references config_changes(id),
  -- The proposed configuration, canonical JSON; config_hash = sha256 of it.
  payload          jsonb not null,
  config_hash      text not null,
  -- What the change replaces, as read when it was proposed (e.g. the campaign's current branch).
  base             jsonb not null,
  author_subject   text not null,
  author_role      text not null,
  created_at       timestamptz not null,
  -- The latest preflight: its full result and the hash an approval is bound to.
  preflight        jsonb,
  preflight_hash   text,
  base_hash        text,
  preflighted_at   timestamptz,
  approved_subject text,
  approved_role    text,
  approved_at      timestamptz,
  decision_reason  text,
  released_by      text,
  released_at      timestamptz,
  verification     jsonb,
  verified_at      timestamptz,
  -- Separation of duties by person, in the database: the author never decides their own change.
  constraint config_changes_different_person check (approved_subject is null or approved_subject <> author_subject),
  -- An approval always records what it was bound to.
  constraint config_changes_approval_bound check (
    status not in ('approved', 'monitoring', 'verified', 'degraded', 'recovery_required')
    or (approved_subject is not null and preflight_hash is not null and base_hash is not null))
);
create index config_changes_status_idx on config_changes (status, created_at desc);

-- At most one change per campaign in flight (ready for review or approved), so two reviewed
-- changes can never race to write the same mapping.
create unique index config_changes_one_in_flight_idx on config_changes ((payload ->> 'campaignId'))
  where kind = 'campaign_mapping' and status in ('ready_for_review', 'approved');

-- Every state a change passes through, append-only.
create table config_change_events (
  id          bigserial primary key,
  change_id   bigint not null references config_changes(id),
  from_status text,
  to_status   text not null,
  subject     text not null,
  role        text not null,
  at          timestamptz not null,
  detail      jsonb not null default '{}'::jsonb
);
create index config_change_events_change_idx on config_change_events (change_id, id);

-- Version history of campaign_branch_map. Version 1 is the mapping as found when ChangeGuard
-- first touched the campaign (or the first mapping it made); each release adds the next.
create table campaign_mapping_versions (
  campaign_id  bigint not null references ad_campaigns(id),
  version      int not null check (version >= 1),
  branch_id    text references branches(id),
  change_id    bigint references config_changes(id),
  recorded_by  text not null,
  recorded_at  timestamptz not null,
  primary key (campaign_id, version)
);

create function changeguard_append_only() returns trigger language plpgsql as $$
begin
  raise exception '% is append-only', tg_table_name using errcode = 'insufficient_privilege';
end $$;
create trigger config_change_events_append_only before update or delete on config_change_events
  for each row execute function changeguard_append_only();
create trigger campaign_mapping_versions_append_only before update or delete on campaign_mapping_versions
  for each row execute function changeguard_append_only();
