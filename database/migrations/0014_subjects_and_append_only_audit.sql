-- Separation of duties by PERSON, and an append-only audit trail (security pass, 2026-11-11).
--
-- Until now the four-eyes rule compared ROLES: a proposal made as "engineer" could not be
-- approved as "engineer". One person holding two roles (an admin with both grants in an
-- identity provider) could still propose as one and approve as the other. Every viewer now has
-- a stable SUBJECT (the identity provider's user id; in demo mode one synthetic subject per
-- role, so demo behaviour is unchanged), recorded on every proposal, approval, mapping
-- decision and publication, and the database refuses an approval by the subject who proposed.

alter table action_proposals add column proposed_subject text;
update action_proposals set proposed_subject = 'demo:' || proposed_role where proposed_subject is null;
alter table action_proposals alter column proposed_subject set not null;

alter table action_approvals add column subject text;
update action_approvals set subject = 'demo:' || role where subject is null;
alter table action_approvals alter column subject set not null;

create function action_approvals_different_person() returns trigger language plpgsql as $$
begin
  if new.decision = 'approved' and exists (
    select 1 from action_proposals p where p.id = new.proposal_id and p.proposed_subject = new.subject
  ) then
    raise exception 'separation of duties: % proposed this and cannot approve it', new.subject
      using errcode = 'check_violation';
  end if;
  return new;
end $$;
create trigger action_approvals_different_person before insert on action_approvals
  for each row execute function action_approvals_different_person();

alter table onboarding_mappings add column proposed_subject text;
alter table onboarding_mappings add column decided_subject text;
update onboarding_mappings set proposed_subject = 'demo:' || proposed_role where proposed_subject is null;
update onboarding_mappings set decided_subject = 'demo:' || decided_role where decided_role is not null and decided_subject is null;
alter table onboarding_mappings alter column proposed_subject set not null;
alter table onboarding_mappings add constraint onboarding_mappings_different_person
  check (decided_subject is null or decided_subject <> proposed_subject);

alter table onboarding_publications add column published_subject text;
update onboarding_publications set published_subject = 'demo:' || published_role where published_subject is null;
alter table onboarding_publications alter column published_subject set not null;

-- The audit trail is append-only: no code path updates or deletes it, and now the database
-- refuses to. (Removing it needs a migration, which is itself reviewed and recorded.)
create function audit_log_append_only() returns trigger language plpgsql as $$
begin
  raise exception 'audit_log is append-only' using errcode = 'insufficient_privilege';
end $$;
create trigger audit_log_append_only before update or delete on audit_log
  for each row execute function audit_log_append_only();
