-- Identity resolution: which source records belong to the same person.
--
-- Rules (lib/identity/resolve.ts is the only writer):
--   * every CRM customer anchors exactly one identity; two CRM customers are never merged;
--   * a lead (call, web form, D2D sale) is linked to a customer only on an EXACT hash match
--     that points at exactly one CRM customer (phone hash first, else email hash);
--   * a lead whose keys point at more than one CRM customer is not linked: each
--     (lead, candidate customer) pair becomes an identity_conflict a person reviews;
--   * leads that match no CRM customer group into prospect identities by phone hash
--     (else email hash) — the same "one prospect = one phone, else one email" rule as v_leads.
-- Nothing here merges on a name, an address or a fuzzy match.
--
-- Identities and links are DERIVED: resolveIdentities rebuilds them idempotently from the
-- projections plus the human decisions recorded in identity_conflicts, which are the only
-- non-derived rows. Cross-module references use ids, never foreign keys into these tables.

create table identities (
  id               bigserial primary key,
  kind             text not null check (kind in ('customer', 'prospect')),
  -- what the identity is anchored on: 'crm:<crmCustomerId>' | 'phone:<hash>' | 'email:<hash>'
  anchor_key       text not null unique,
  crm_customer_id  bigint unique,
  -- customer: the CRM office's branch; prospect: the effective branch of its latest lead,
  -- as of the last resolution run. Null = no known branch (visible to all-branch roles only).
  branch_id        text references branches(id),
  created_at       timestamptz not null,
  updated_at       timestamptz not null,
  -- a prospect whose leads now belong to a CRM customer is retired, not deleted, so an id
  -- that was shown or referenced elsewhere still resolves to an explanation
  retired_at       timestamptz,
  check ((kind = 'customer') = (crm_customer_id is not null)),
  check (kind = 'prospect' or retired_at is null)
);
create index identities_branch_idx on identities (branch_id, kind) where retired_at is null;

-- One row per source record: (source, source_record_id) is the record's ORIGINAL id in its
-- source system (CRM customerID, CallRail call id, web messageId, D2D saleId), preserved as is.
create table identity_links (
  id                bigserial primary key,
  identity_id       bigint not null references identities(id),
  source            text not null check (source in ('crm', 'calls', 'web', 'd2d')),
  source_record_id  text not null,
  record_table      text not null check (record_table in ('crm_customers', 'leads')),
  -- crm_customers.crm_customer_id or leads.id
  record_id         bigint not null,
  rule              text not null check (rule in (
                      'crm_customer_anchor',
                      'exact_phone_hash',
                      'exact_email_hash',
                      'prospect_phone_hash',
                      'prospect_email_hash',
                      'reviewer_accepted')),
  -- every current rule is deterministic, so every link is asserted at 1.0; the column is
  -- here so a probabilistic rule could never hide inside a deterministic-looking link
  confidence        numeric(4, 3) not null check (confidence > 0 and confidence <= 1),
  evidence          jsonb not null,
  -- when this link last CHANGED (identity, rule or evidence); unchanged re-runs keep it
  linked_at         timestamptz not null,
  unique (source, source_record_id)
);
create index identity_links_identity_idx on identity_links (identity_id);
create index identity_links_record_idx on identity_links (record_table, record_id);
create index identity_links_source_record_prefix_idx on identity_links (source_record_id text_pattern_ops);

-- One row per (lead, candidate CRM customer) pair per evidence version. A decision binds to the
-- evidence it was made on: when the evidence changes, a NEW pending row is opened that points at
-- the row it replaces (supersedes_id) and at the last human decision on the pair
-- (prior_decision_id). A rejected pair therefore stays rejected across re-runs and replays for
-- exactly as long as its evidence is unchanged.
create table identity_conflicts (
  id                    bigserial primary key,
  -- detection idempotency key: pair + evidence fingerprint + the row it follows
  fingerprint           text not null unique,
  -- '<leadSource>:<sourceLeadId>|crm:<crmCustomerId>'
  pair_key              text not null,
  kind                  text not null check (kind in (
                          'shared_phone',          -- the lead's phone hash belongs to >1 CRM customer
                          'shared_email',          -- no phone match; the email hash belongs to >1 CRM customer
                          'phone_email_disagree',  -- phone points at one customer, email at another
                          'previously_rejected')), -- exact match now, but a reviewer rejected this pair before
  lead_id               bigint not null,
  crm_customer_id       bigint not null,
  left_record           jsonb not null,           -- the lead, by source id
  right_record          jsonb not null,           -- the candidate CRM customer
  evidence              jsonb not null,
  evidence_fingerprint  text not null,
  -- branches involved (lead's effective branch, customer's branch); a null element means
  -- unknown. A scoped viewer sees a conflict only when every element is in scope.
  branch_ids            text[] not null,
  status                text not null default 'pending'
                          check (status in ('pending', 'accepted', 'rejected', 'superseded')),
  supersedes_id         bigint references identity_conflicts(id),
  prior_decision_id     bigint references identity_conflicts(id),
  detected_at           timestamptz not null,
  -- accepted/rejected: the reviewer; superseded: 'system:identity-resolution'
  decided_by            text,
  decided_at            timestamptz,
  decision_reason       text,
  check ((status = 'pending') = (decided_by is null)),
  check ((status = 'pending') = (decided_at is null)),
  check ((status = 'pending') = (decision_reason is null))
);
create index identity_conflicts_pair_idx on identity_conflicts (pair_key, id desc);
create index identity_conflicts_lead_idx on identity_conflicts (lead_id);
create index identity_conflicts_customer_idx on identity_conflicts (crm_customer_id);
create index identity_conflicts_pending_idx on identity_conflicts (detected_at desc) where status = 'pending';

-- One row per resolution run: when identity was last brought up to date, and what changed.
create table identity_runs (
  id            bigserial primary key,
  business_now  timestamptz not null,
  scope         text not null check (scope in ('all', 'leads')),
  stats         jsonb not null,
  duration_ms   integer not null check (duration_ms >= 0),
  recorded_at   timestamptz not null default clock_timestamp()
);
