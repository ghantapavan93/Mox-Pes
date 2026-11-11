-- CRM identity across brands (reconciliation pass, 2026-11-11; REMAINING-RISKS R-3).
--
-- CRM records are keyed by the CRM's own id alone (crm_customer_id, crm_payment_id, ...). That is
-- right for one CRM account, where ids are unique. If two brands run separate CRM accounts, the
-- same numeric id names two different customers, and a newer version from the second account
-- used to MOVE the first brand's customer (and its payments) to the other brand: silently.
--
-- A record may move between offices of the same brand (a reassignment, preserved in the raw
-- ledger). A move to another brand's office is refused with a constraint-class error, which the
-- intake's per-record isolation turns into a quarantined record with this message: a person
-- decides whether it is a real cross-brand transfer or an id collision. Namespacing ids by CRM
-- account is the full fix once the account boundaries are known.

create function crm_office_same_brand() returns trigger language plpgsql as $$
declare
  old_brand text;
  new_brand text;
begin
  if new.office_id is distinct from old.office_id then
    select brand_id into old_brand from branches where crm_office_id = old.office_id;
    select brand_id into new_brand from branches where crm_office_id = new.office_id;
    if old_brand is distinct from new_brand then
      raise exception 'CRM % id moved from office % (brand %) to office % (brand %): an id shared by two CRM accounts, or a cross-brand transfer to confirm',
        tg_table_name, old.office_id, coalesce(old_brand, 'unknown'), new.office_id, coalesce(new_brand, 'unknown')
        using errcode = 'check_violation';
    end if;
  end if;
  return new;
end $$;

create trigger crm_customers_same_brand before update on crm_customers for each row execute function crm_office_same_brand();
create trigger crm_subscriptions_same_brand before update on crm_subscriptions for each row execute function crm_office_same_brand();
create trigger crm_appointments_same_brand before update on crm_appointments for each row execute function crm_office_same_brand();
create trigger crm_tickets_same_brand before update on crm_tickets for each row execute function crm_office_same_brand();
create trigger crm_payments_same_brand before update on crm_payments for each row execute function crm_office_same_brand();
