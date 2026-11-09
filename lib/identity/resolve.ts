import type { Pool, PoolClient } from "pg";
import { withTransaction } from "@/lib/db";
import { currentSnapshot, currentTxid, recordEvent } from "@/lib/events/outbox";
import { IDENTITY_RULES, type IdentityRule } from "./types";

/**
 * Identity resolution: attaches every lead record to the person it belongs to.
 *
 * Deterministic rules only (see database/migrations/0004_identity.sql):
 *   1. every CRM customer anchors one identity (two CRM customers are never merged);
 *   2. a lead links to a customer when its phone hash — else its email hash — points at
 *      EXACTLY ONE CRM customer, and nothing else it carries points at a different one;
 *   3. a lead whose keys point at more than one CRM customer is NOT linked: each
 *      (lead, candidate) pair becomes a pending identity_conflict for a person to decide;
 *   4. a reviewer's decision binds to the evidence it saw. Accepted → the lead links with
 *      rule `reviewer_accepted`; every candidate rejected → the lead becomes a prospect. When
 *      the evidence changes, a new pending conflict is opened that points at the earlier
 *      decision, and the earlier link or rejection no longer applies;
 *   5. leads that match no CRM customer group into prospect identities by phone hash, else
 *      email hash — the same prospect definition as v_leads.prospect_key.
 *
 * The whole run is set-based SQL in one transaction under an advisory lock, so concurrent runs
 * serialise and a failed run leaves the previous resolution intact. It is idempotent: a second
 * run over unchanged data changes no identity, link or conflict and writes no audit row (only
 * the identity_runs log, which records that it ran).
 *
 * Identity links are matched on the whole record history, not the 60-day attribution window:
 * a phone that called two years ago is still the same person. Which touch gets CREDIT is a
 * separate question answered by v_acquisitions, and the journey shows both.
 */

export interface ResolveOptions {
  /** Re-resolve only these leads (by leads.id). Used after a reviewer decision; default all. */
  leadIds?: number[];
  log?: (line: string) => void;
}

export interface ResolveStats {
  scope: "all" | "leads";
  identities: { customers: number; prospects: number; created: number; retired: number; reactivated: number };
  links: { total: number; byRule: Record<IdentityRule, number>; created: number; changed: number; removed: number };
  conflicts: { pending: number; opened: number; superseded: number; leadsAwaitingReview: number };
  /** Leads considered in this run, and how many of them ended up linked to a CRM customer. */
  leads: { considered: number; linkedToCustomer: number; prospects: number; awaitingReview: number };
  /** True when any identity, link or conflict changed. */
  changed: boolean;
  durationMs: number;
}

export const SYSTEM_ACTOR = "system:identity-resolution";
const LOCK_KEY = "identity_resolution";

/** Runs a full (or lead-scoped) resolution in its own transaction. */
export async function resolveIdentities(pool: Pool, now: Date, opts: ResolveOptions = {}): Promise<ResolveStats> {
  const stats = await withTransaction(pool, (tx) => resolveInTransaction(tx, now, opts));
  opts.log?.(
    `identity: ${stats.identities.customers} customers, ${stats.identities.prospects} prospects, ` +
      `${stats.leads.linkedToCustomer} of ${stats.leads.considered} leads linked to a CRM customer, ` +
      `${stats.conflicts.pending} pending conflicts (${stats.conflicts.opened} opened), ` +
      `${stats.links.created + stats.links.changed + stats.links.removed} link changes, ${stats.durationMs} ms`,
  );
  return stats;
}

/** Takes the resolution lock. Reviewer decisions take it too, so they never race a run. */
export async function lockIdentity(tx: PoolClient): Promise<void> {
  await tx.query("select pg_advisory_xact_lock(hashtext($1))", [LOCK_KEY]);
}

/**
 * The resolution itself, inside the caller's transaction (temp tables need one session).
 * Exported for decideIdentityConflict, which records a decision and re-resolves that lead
 * atomically.
 */
export async function resolveInTransaction(tx: PoolClient, now: Date, opts: ResolveOptions = {}): Promise<ResolveStats> {
  const started = Date.now();
  const leadIds = opts.leadIds ?? null;
  await lockIdentity(tx);
  // Only a FULL run may claim to have seen everything; a lead-scoped run publishes nothing.
  const coverage = leadIds ? null : { snapshot: await currentSnapshot(tx), txid: await currentTxid(tx) };

  // ── 1. CRM customers: one identity each, anchored by its own record ──────────────────────
  const createdCustomers = await tx.query(
    `insert into identities (kind, anchor_key, crm_customer_id, branch_id, created_at, updated_at)
     select 'customer', 'crm:' || c.crm_customer_id, c.crm_customer_id, b.id, $1, $1
     from crm_customers c
     left join branches b on b.crm_office_id = c.office_id
     where not exists (select 1 from identities i where i.crm_customer_id = c.crm_customer_id)
     on conflict (anchor_key) do nothing`,
    [now],
  );
  const anchorLinks = await tx.query(
    `insert into identity_links (identity_id, source, source_record_id, record_table, record_id, rule, confidence, evidence, linked_at)
     select i.id, 'crm', c.crm_customer_id::text, 'crm_customers', c.crm_customer_id, 'crm_customer_anchor', 1,
            jsonb_build_object('crmCustomerId', c.crm_customer_id, 'note', 'The CRM customer record anchors its own identity'), $1
     from crm_customers c
     join identities i on i.crm_customer_id = c.crm_customer_id
     where not exists (
       select 1 from identity_links k where k.source = 'crm' and k.source_record_id = c.crm_customer_id::text)`,
    [now],
  );
  // A customer's branch follows the CRM office (customers can be moved between offices).
  const customerBranchMoves = await tx.query(
    `update identities i set branch_id = x.branch_id, updated_at = $1
     from (select c.crm_customer_id, b.id as branch_id
           from crm_customers c left join branches b on b.crm_office_id = c.office_id) x
     where i.crm_customer_id = x.crm_customer_id and i.branch_id is distinct from x.branch_id`,
    [now],
  );

  // ── 2. The leads in scope and every CRM customer each of them could be ───────────────────
  await tx.query(
    `create temp table _ir_leads on commit drop as
     select l.id, l.source, l.source_lead_id, l.phone_hash, l.email_hash, l.effective_branch_id
     from v_leads l
     where $1::bigint[] is null or l.id = any($1::bigint[])`,
    [leadIds],
  );
  await tx.query(
    `create temp table _ir_cand on commit drop as
     select m.lead_id, m.crm_customer_id, bool_or(m.via = 'phone') as via_phone, bool_or(m.via = 'email') as via_email
     from (
       select l.id as lead_id, c.crm_customer_id, 'phone' as via
       from _ir_leads l join crm_customers c on c.phone_hash = l.phone_hash
       union all
       select l.id, c.crm_customer_id, 'email'
       from _ir_leads l join crm_customers c on c.email_hash = l.email_hash
     ) m
     group by m.lead_id, m.crm_customer_id`,
  );
  // Evidence per lead: its keys and the full candidate set. Its fingerprint is what a reviewer's
  // decision binds to. Record ids and raw event ids are deliberately left out: a replay that
  // re-projects the same facts must not re-open a decided conflict.
  await tx.query(
    `create temp table _ir_eval on commit drop as
     select l.*,
            coalesce(e.n_cand, 0) as n_cand, coalesce(e.n_phone, 0) as n_phone, coalesce(e.n_email, 0) as n_email,
            coalesce(e.candidates, '[]'::jsonb) as candidates,
            md5(jsonb_build_object('phoneHash', l.phone_hash, 'emailHash', l.email_hash,
                                   'candidates', coalesce(e.candidates, '[]'::jsonb))::text) as evidence_fp
     from _ir_leads l
     left join (
       select lead_id, count(*) as n_cand,
              count(*) filter (where via_phone) as n_phone, count(*) filter (where via_email) as n_email,
              jsonb_agg(jsonb_build_object('crmCustomerId', crm_customer_id, 'viaPhone', via_phone, 'viaEmail', via_email)
                        order by crm_customer_id) as candidates
       from _ir_cand group by lead_id
     ) e on e.lead_id = l.id`,
  );
  await tx.query("create index on _ir_eval (id)");
  await tx.query("analyze _ir_eval");

  // ── 3. Conflict history per pair: the latest row, and the latest human decision ──────────
  await tx.query(
    `create temp table _ir_latest on commit drop as
     select distinct on (k.pair_key) k.pair_key, k.id, k.lead_id, k.status, k.evidence_fingerprint
     from identity_conflicts k
     where $1::bigint[] is null or k.lead_id = any($1::bigint[])
     order by k.pair_key, k.id desc`,
    [leadIds],
  );
  await tx.query(
    `create temp table _ir_decided on commit drop as
     select distinct on (k.pair_key) k.pair_key, k.id, k.status
     from identity_conflicts k
     where k.status in ('accepted', 'rejected') and ($1::bigint[] is null or k.lead_id = any($1::bigint[]))
     order by k.pair_key, k.id desc`,
    [leadIds],
  );

  // ── 4. Pairs that need a person: ambiguous leads, and exact matches a reviewer rejected ────
  await tx.query(
    `create temp table _ir_review on commit drop as
     select x.*, lt.id as latest_id, lt.status as latest_status, lt.evidence_fingerprint as latest_fp,
            d.id as decided_id
     from (
       select e.id as lead_id, c.crm_customer_id, c.via_phone, c.via_email, e.evidence_fp, e.n_cand,
              e.source || ':' || e.source_lead_id || '|crm:' || c.crm_customer_id as pair_key,
              case when e.n_cand = 1 then 'previously_rejected'
                   when e.n_phone > 1 then 'shared_phone'
                   when e.n_phone = 0 then 'shared_email'
                   else 'phone_email_disagree' end as kind
       from _ir_eval e join _ir_cand c on c.lead_id = e.id
     ) x
     left join _ir_latest lt on lt.pair_key = x.pair_key
     left join _ir_decided d on d.pair_key = x.pair_key
     where x.n_cand > 1 or d.status = 'rejected'`,
  );

  // A pending conflict whose evidence changed is superseded by a new one; a pending conflict
  // that is no longer ambiguous at all is closed. Decided rows are history and stay as they are.
  const supersededChanged = await tx.query(
    `update identity_conflicts k
     set status = 'superseded', decided_by = $2, decided_at = $1,
         decision_reason = 'Evidence changed; re-opened for review as a new conflict'
     from _ir_review r
     where k.id = r.latest_id and k.status = 'pending' and r.latest_fp <> r.evidence_fp`,
    [now, SYSTEM_ACTOR],
  );
  const supersededGone = await tx.query(
    `update identity_conflicts k
     set status = 'superseded', decided_by = $2, decided_at = $1,
         decision_reason = 'No longer ambiguous: the lead''s keys no longer point at several CRM customers'
     from _ir_latest lt
     where k.id = lt.id and k.status = 'pending'
       and not exists (select 1 from _ir_review r where r.pair_key = lt.pair_key)`,
    [now, SYSTEM_ACTOR],
  );
  const opened = await tx.query(
    `insert into identity_conflicts (fingerprint, pair_key, kind, lead_id, crm_customer_id, left_record, right_record,
       evidence, evidence_fingerprint, branch_ids, status, supersedes_id, prior_decision_id, detected_at)
     select 'identity:' || r.pair_key || '#' || r.evidence_fp || '#after:' || coalesce(r.latest_id, 0),
            r.pair_key, r.kind, r.lead_id, r.crm_customer_id,
            jsonb_build_object('table', 'leads', 'leadId', e.id, 'source', e.source, 'sourceRecordId', e.source_lead_id,
                               'branchId', e.effective_branch_id),
            jsonb_build_object('table', 'crm_customers', 'crmCustomerId', c.crm_customer_id, 'branchId', b.id),
            jsonb_build_object('matchedOn', array_remove(array[case when r.via_phone then 'phone_hash' end,
                                                               case when r.via_email then 'email_hash' end], null),
                               'leadPhoneHash', e.phone_hash, 'leadEmailHash', e.email_hash,
                               'customerPhoneHash', c.phone_hash, 'customerEmailHash', c.email_hash,
                               'candidates', e.candidates, 'candidateCount', e.n_cand),
            r.evidence_fp,
            array[e.effective_branch_id, b.id],
            'pending', r.latest_id, r.decided_id, $1
     from _ir_review r
     join _ir_eval e on e.id = r.lead_id
     join crm_customers c on c.crm_customer_id = r.crm_customer_id
     left join branches b on b.crm_office_id = c.office_id
     -- a pair whose last row was closed as "no longer ambiguous" and is ambiguous again needs
     -- a fresh pending row even when the evidence is identical to that closed row's
     where r.latest_id is null or r.latest_fp <> r.evidence_fp or r.latest_status = 'superseded'
     on conflict (fingerprint) do nothing`,
    [now],
  );

  // ── 5. Each lead's outcome ──────────────────────────────────────────────────────────────
  await tx.query(
    `create temp table _ir_target on commit drop as
     with eff as (
       -- after step 4 the latest row of every review pair carries the current evidence
       select distinct on (k.pair_key) k.pair_key, k.id, k.lead_id, k.crm_customer_id, k.status,
              k.decided_by, k.decided_at, k.decision_reason
       from identity_conflicts k join _ir_review r on r.pair_key = k.pair_key
       order by k.pair_key, k.id desc
     ), per_lead as (
       select lead_id, count(*) as n_review, count(*) filter (where status = 'rejected') as n_rejected,
              (array_agg(id order by id) filter (where status = 'accepted'))[1] as accepted_id,
              jsonb_agg(jsonb_build_object('conflictId', id, 'crmCustomerId', crm_customer_id, 'decidedBy', decided_by,
                                           'decidedAt', decided_at, 'reason', decision_reason) order by id)
                filter (where status = 'rejected') as rejections
       from eff group by lead_id
     )
     select e.id as lead_id, e.source, e.source_lead_id, e.phone_hash, e.email_hash, e.n_cand, e.candidates,
            case
              when p.accepted_id is not null then 'accepted'
              when p.lead_id is null and e.n_cand = 1 then 'exact'
              when p.lead_id is null and e.n_cand = 0 then 'prospect'
              when p.n_rejected = p.n_review then 'prospect'
              else 'pending'
            end as outcome,
            p.accepted_id, p.rejections
     from _ir_eval e left join per_lead p on p.lead_id = e.id`,
  );

  // Prospect identities: created on first sight, reactivated when leads return to them.
  const prospectUpserts = await tx.query<{ inserted: boolean }>(
    `insert into identities (kind, anchor_key, created_at, updated_at)
     select distinct 'prospect',
            case when t.phone_hash is not null then 'phone:' || t.phone_hash else 'email:' || t.email_hash end, $1::timestamptz, $1::timestamptz
     from _ir_target t where t.outcome = 'prospect'
     on conflict (anchor_key) do update set retired_at = null, updated_at = excluded.updated_at
       where identities.retired_at is not null
     returning (xmax = 0) as inserted`,
    [now],
  );

  // ── 6. The links each lead should have, then make the table say exactly that ─────────────
  await tx.query(
    `create temp table _ir_desired on commit drop as
     select t.lead_id, t.source, t.source_lead_id, i.id as identity_id, x.rule,
            jsonb_strip_nulls(x.evidence) as evidence
     from _ir_target t
     left join _ir_cand c on t.outcome = 'exact' and c.lead_id = t.lead_id
     left join identity_conflicts a on a.id = t.accepted_id
     cross join lateral (
       select
         case t.outcome
           when 'exact' then case when c.via_phone then 'exact_phone_hash' else 'exact_email_hash' end
           when 'accepted' then 'reviewer_accepted'
           else case when t.phone_hash is not null then 'prospect_phone_hash' else 'prospect_email_hash' end
         end as rule,
         case t.outcome
           when 'exact' then 'crm:' || c.crm_customer_id
           when 'accepted' then 'crm:' || a.crm_customer_id
           else case when t.phone_hash is not null then 'phone:' || t.phone_hash else 'email:' || t.email_hash end
         end as anchor,
         case t.outcome
           when 'exact' then jsonb_build_object(
             'matchedKey', case when c.via_phone then 'phone_hash' else 'email_hash' end,
             'hash', case when c.via_phone then t.phone_hash else t.email_hash end,
             'alsoMatchedEmail', case when c.via_phone and c.via_email then true end,
             'lead', jsonb_build_object('leadId', t.lead_id, 'source', t.source, 'sourceRecordId', t.source_lead_id),
             'crmCustomerId', c.crm_customer_id,
             'candidateCount', 1)
           when 'accepted' then jsonb_build_object(
             'conflictId', a.id, 'decidedBy', a.decided_by, 'decidedAt', a.decided_at, 'reason', a.decision_reason,
             'matchedOn', a.evidence->'matchedOn',
             'lead', jsonb_build_object('leadId', t.lead_id, 'source', t.source, 'sourceRecordId', t.source_lead_id),
             'crmCustomerId', a.crm_customer_id,
             'candidateCount', t.n_cand)
           else jsonb_build_object(
             'matchedKey', case when t.phone_hash is not null then 'phone_hash' else 'email_hash' end,
             'hash', coalesce(t.phone_hash, t.email_hash),
             'lead', jsonb_build_object('leadId', t.lead_id, 'source', t.source, 'sourceRecordId', t.source_lead_id),
             'crmCandidates', t.n_cand,
             'rejectedCandidates', t.rejections)
         end as evidence
     ) x
     join identities i on i.anchor_key = x.anchor
     where t.outcome <> 'pending'`,
  );

  const removed = await tx.query(
    `delete from identity_links k using _ir_target t
     where t.outcome = 'pending' and k.source = t.source and k.source_record_id = t.source_lead_id`,
  );
  const upserted = await tx.query<{ inserted: boolean }>(
    `insert into identity_links (identity_id, source, source_record_id, record_table, record_id, rule, confidence, evidence, linked_at)
     select d.identity_id, d.source, d.source_lead_id, 'leads', d.lead_id, d.rule, 1, d.evidence, $1
     from _ir_desired d
     on conflict (source, source_record_id) do update set
       identity_id = excluded.identity_id, record_id = excluded.record_id, rule = excluded.rule,
       confidence = excluded.confidence, evidence = excluded.evidence, linked_at = excluded.linked_at
     where (identity_links.identity_id, identity_links.record_id, identity_links.rule, identity_links.evidence)
           is distinct from (excluded.identity_id, excluded.record_id, excluded.rule, excluded.evidence)
     returning (xmax = 0) as inserted`,
    [now],
  );

  // ── 7. Housekeeping: retire empty prospects, keep prospect branches current ──────────────
  const retired = await tx.query(
    `update identities i set retired_at = $1, updated_at = $1
     where i.kind = 'prospect' and i.retired_at is null
       and not exists (select 1 from identity_links k where k.identity_id = i.id)`,
    [now],
  );
  const prospectBranchMoves = await tx.query(
    `update identities i set branch_id = x.branch_id, updated_at = $1
     from (
       select distinct on (k.identity_id) k.identity_id, l.effective_branch_id as branch_id
       from identity_links k
       join identities p on p.id = k.identity_id and p.kind = 'prospect'
       join v_leads l on l.id = k.record_id
       where k.record_table = 'leads'
       order by k.identity_id, l.occurred_at desc, l.id desc
     ) x
     where i.id = x.identity_id and i.branch_id is distinct from x.branch_id`,
    [now],
  );

  // ── 8. Report, log the run, audit any change ─────────────────────────────────────────────
  const totals = await tx.query<{ customers: string; prospects: string; pending: string; awaiting: string }>(
    `select (select count(*) from identities where kind = 'customer') as customers,
            (select count(*) from identities where kind = 'prospect' and retired_at is null) as prospects,
            (select count(*) from identity_conflicts where status = 'pending') as pending,
            (select count(distinct lead_id) from identity_conflicts where status = 'pending') as awaiting`,
  );
  const byRuleRows = await tx.query<{ rule: IdentityRule; n: string }>("select rule, count(*) as n from identity_links group by rule");
  const outcomes = await tx.query<{ outcome: string; n: string }>("select outcome, count(*) as n from _ir_target group by outcome");
  const outcome = (o: string) => Number(outcomes.rows.find((r) => r.outcome === o)?.n ?? 0);

  const byRule = Object.fromEntries(IDENTITY_RULES.map((r) => [r, 0])) as Record<IdentityRule, number>;
  for (const row of byRuleRows.rows) byRule[row.rule] = Number(row.n);
  const linksCreated = upserted.rows.filter((r) => r.inserted).length + (anchorLinks.rowCount ?? 0);
  const linksChanged = upserted.rows.filter((r) => !r.inserted).length;
  const prospectsCreated = prospectUpserts.rows.filter((r) => r.inserted).length;
  const reactivated = prospectUpserts.rows.length - prospectsCreated;
  const superseded = (supersededChanged.rowCount ?? 0) + (supersededGone.rowCount ?? 0);

  const stats: ResolveStats = {
    scope: leadIds ? "leads" : "all",
    identities: {
      customers: Number(totals.rows[0].customers),
      prospects: Number(totals.rows[0].prospects),
      created: (createdCustomers.rowCount ?? 0) + prospectsCreated,
      retired: retired.rowCount ?? 0,
      reactivated,
    },
    links: { total: Object.values(byRule).reduce((a, b) => a + b, 0), byRule, created: linksCreated, changed: linksChanged, removed: removed.rowCount ?? 0 },
    conflicts: { pending: Number(totals.rows[0].pending), opened: opened.rowCount ?? 0, superseded, leadsAwaitingReview: Number(totals.rows[0].awaiting) },
    leads: {
      considered: outcomes.rows.reduce((a, r) => a + Number(r.n), 0),
      linkedToCustomer: outcome("exact") + outcome("accepted"),
      prospects: outcome("prospect"),
      awaitingReview: outcome("pending"),
    },
    changed: false,
    durationMs: 0,
  };
  stats.changed =
    stats.identities.created + stats.identities.retired + stats.identities.reactivated + linksCreated + linksChanged +
      stats.links.removed + stats.conflicts.opened + superseded + (customerBranchMoves.rowCount ?? 0) + (prospectBranchMoves.rowCount ?? 0) >
    0;
  stats.durationMs = Date.now() - started;

  await tx.query("insert into identity_runs (business_now, scope, stats, duration_ms) values ($1, $2, $3, $4)", [now, stats.scope, stats, stats.durationMs]);
  if (stats.changed) {
    await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'resolve_identities', $3, $4)", [
      now,
      SYSTEM_ACTOR,
      leadIds ? `leads:${leadIds.join(",")}` : "identity:all",
      {
        identitiesCreated: stats.identities.created,
        prospectsRetired: stats.identities.retired,
        prospectsReactivated: stats.identities.reactivated,
        linksCreated,
        linksChanged,
        linksRemoved: stats.links.removed,
        conflictsOpened: stats.conflicts.opened,
        conflictsSuperseded: superseded,
        branchMoves: (customerBranchMoves.rowCount ?? 0) + (prospectBranchMoves.rowCount ?? 0),
      },
    ]);
  }
  if (coverage) {
    await recordEvent(tx, {
      type: "identity.resolution_completed",
      subject: "identity:all",
      occurredAt: now,
      payload: { ...coverage, changed: stats.changed, pendingConflicts: stats.conflicts.pending, durationMs: stats.durationMs },
    });
  }
  return stats;
}
