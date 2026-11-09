import type { Queryable } from "@/lib/db";
import type { IdentityKind, Lifecycle, LifecycleFilter } from "./types";

/**
 * Customer search over resolved identities.
 *
 * Population: every CRM customer (live from crm_customers, so a customer delivered after the
 * last resolution run is still findable) plus every active prospect identity. A customer's
 * branch is its CRM office's branch, read live; a prospect's branch is the effective branch of
 * its latest lead as of the last resolution run. Branch scope is applied in SQL.
 */

export interface CustomerFilters {
  /** CRM customer id, a lead's source id (CAL…, msg-…, S-…), or a prospect reference P-<id>. */
  q?: string;
  lifecycle?: LifecycleFilter;
  page?: number;
  pageSize?: number;
}

export interface CustomerRow {
  identityId: number | null;
  kind: IdentityKind;
  crmCustomerId: number | null;
  branchId: string | null;
  lifecycle: Lifecycle;
  firstSeenAt: string | null;
  lastActivityAt: string | null;
  leadRecords: number;
  collectedCents: number | null;
  pendingConflicts: number;
  /** Credited channel (v_acquisitions) for a customer; the first lead's channel for a prospect. */
  channelCode: string | null;
  /** v_acquisitions.attribution_basis for customers; null for prospects. */
  attributionBasis: string | null;
}

export interface CustomerPage {
  rows: CustomerRow[];
  total: number;
  page: number;
  pageSize: number;
}

/**
 * Shared population CTE. $1 = branch scope (null = all). Lifecycle, activity and money are
 * aggregated set-wise once per query, never per row.
 */
const POPULATION = `
  with subs as (
    select crm_customer_id, count(*) as n_subs, bool_and(status = 'cancelled') as all_cancelled,
           max(greatest(sold_at, cancelled_at)) as last_sub_at
    from crm_subscriptions group by crm_customer_id
  ), svc as (
    select crm_customer_id, max(completed_at) as last_service_at
    from crm_appointments where status = 'completed' group by crm_customer_id
  ), pay as (
    select crm_customer_id, max(paid_at) as last_paid_at,
           sum(amount_cents) filter (where status = 'successful') as collected_cents
    from crm_payments group by crm_customer_id
  ), lead_stats as (
    select k.identity_id, count(*) as n_leads, min(l.occurred_at) as first_lead_at, max(l.occurred_at) as last_lead_at
    from identity_links k join leads l on l.id = k.record_id
    where k.record_table = 'leads'
    group by k.identity_id
  ), open_conflicts as (
    select crm_customer_id, count(*) as n from identity_conflicts where status = 'pending' group by crm_customer_id
  ), population as (
    select 'customer'::text as kind, i.id as identity_id, c.crm_customer_id, b.id as branch_id,
           case when s.crm_customer_id is null then 'unknown'
                when s.all_cancelled then 'cancelled'
                when v.crm_customer_id is not null then 'serviced'
                else 'sold' end as lifecycle,
           least(c.created_at_source, ls.first_lead_at) as first_seen_at,
           greatest(c.created_at_source, s.last_sub_at, v.last_service_at, p.last_paid_at, ls.last_lead_at) as last_activity_at,
           coalesce(ls.n_leads, 0) as lead_records, p.collected_cents, coalesce(oc.n, 0) as pending_conflicts
    from crm_customers c
    left join branches b on b.crm_office_id = c.office_id
    left join identities i on i.crm_customer_id = c.crm_customer_id
    left join subs s on s.crm_customer_id = c.crm_customer_id
    left join svc v on v.crm_customer_id = c.crm_customer_id
    left join pay p on p.crm_customer_id = c.crm_customer_id
    left join lead_stats ls on ls.identity_id = i.id
    left join open_conflicts oc on oc.crm_customer_id = c.crm_customer_id
    union all
    select 'prospect', i.id, null, i.branch_id, 'prospect', ls.first_lead_at, ls.last_lead_at,
           coalesce(ls.n_leads, 0), null, 0
    from identities i
    left join lead_stats ls on ls.identity_id = i.id
    where i.kind = 'prospect' and i.retired_at is null
  ), scoped as (
    select * from population where $1::text[] is null or branch_id = any($1::text[])
  )`;

/** Escapes LIKE metacharacters so a search term is matched literally. */
function likePrefix(term: string): string {
  return `${term.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
}

export async function searchCustomers(db: Queryable, filters: CustomerFilters, scope: string[] | null): Promise<CustomerPage> {
  const pageSize = Math.min(Math.max(filters.pageSize ?? 50, 1), 200);
  const page = Math.max(filters.page ?? 1, 1);
  const q = filters.q?.trim() ?? "";
  const prospectRef = /^P-(\d{1,15})$/i.exec(q);
  const prefix = q && !prospectRef ? likePrefix(q) : null;

  const { rows } = await db.query<{
    kind: IdentityKind;
    identity_id: string | null;
    crm_customer_id: string | null;
    branch_id: string | null;
    lifecycle: Lifecycle;
    first_seen_at: Date | null;
    last_activity_at: Date | null;
    lead_records: string;
    collected_cents: string | null;
    pending_conflicts: string;
    total: string;
  }>(
    `${POPULATION}
     select s.*, count(*) over () as total
     from scoped s
     where ($2::text is null or s.lifecycle = $2)
       and ($3::bigint is null or s.identity_id = $3)
       and ($4::text is null
            or s.crm_customer_id::text like $4
            or exists (select 1 from identity_links k
                       where k.identity_id = s.identity_id
                         and k.source_record_id like any (array[$4, upper($4), lower($4)])))
     order by s.last_activity_at desc nulls last, s.kind, coalesce(s.crm_customer_id, s.identity_id) desc
     limit $5 offset $6`,
    [scope, filters.lifecycle ?? null, prospectRef ? Number(prospectRef[1]) : null, prefix, pageSize, (page - 1) * pageSize],
  );

  // Credited channel for this page only: v_acquisitions per customer is an indexed lookup.
  const customerIds = rows.filter((r) => r.crm_customer_id !== null).map((r) => Number(r.crm_customer_id));
  const prospectIds = rows.filter((r) => r.kind === "prospect" && r.identity_id !== null).map((r) => Number(r.identity_id));
  const [acq, firstLead] = await Promise.all([
    customerIds.length
      ? db.query<{ crm_customer_id: string; channel_code: string; attribution_basis: string }>(
          "select crm_customer_id, channel_code, attribution_basis from v_acquisitions where crm_customer_id = any($1::bigint[])",
          [customerIds],
        )
      : Promise.resolve({ rows: [] }),
    prospectIds.length
      ? db.query<{ identity_id: string; channel_code: string }>(
          `select distinct on (k.identity_id) k.identity_id, l.channel_code
           from identity_links k join leads l on l.id = k.record_id
           where k.record_table = 'leads' and k.identity_id = any($1::bigint[])
           order by k.identity_id, l.occurred_at, l.id`,
          [prospectIds],
        )
      : Promise.resolve({ rows: [] }),
  ]);
  const acqBy = new Map(acq.rows.map((a) => [Number(a.crm_customer_id), a]));
  const leadBy = new Map(firstLead.rows.map((f) => [Number(f.identity_id), f.channel_code]));

  return {
    rows: rows.map((r) => {
      const crmId = r.crm_customer_id === null ? null : Number(r.crm_customer_id);
      const identityId = r.identity_id === null ? null : Number(r.identity_id);
      const a = crmId === null ? undefined : acqBy.get(crmId);
      return {
        identityId,
        kind: r.kind,
        crmCustomerId: crmId,
        branchId: r.branch_id,
        lifecycle: r.lifecycle,
        firstSeenAt: r.first_seen_at?.toISOString() ?? null,
        lastActivityAt: r.last_activity_at?.toISOString() ?? null,
        leadRecords: Number(r.lead_records),
        collectedCents: r.collected_cents === null ? null : Number(r.collected_cents),
        pendingConflicts: Number(r.pending_conflicts),
        channelCode: a ? a.channel_code : identityId !== null ? (leadBy.get(identityId) ?? null) : null,
        attributionBasis: a?.attribution_basis ?? null,
      };
    }),
    total: rows.length ? Number(rows[0].total) : 0,
    page,
    pageSize,
  };
}

export interface IdentityOverview {
  lifecycle: Record<Lifecycle, number>;
  pendingConflicts: number;
  customersWithoutIdentity: number;
  lastRun: { businessNow: string; recordedAt: string; durationMs: number; scope: string } | null;
}

/** Counts for the page header, in the same scope and population as the table. */
export async function identityOverview(db: Queryable, scope: string[] | null): Promise<IdentityOverview> {
  const [counts, conflicts, run] = await Promise.all([
    db.query<{ lifecycle: Lifecycle; n: string; without_identity: string }>(
      `${POPULATION}
       select lifecycle, count(*) as n, count(*) filter (where identity_id is null) as without_identity
       from scoped group by lifecycle`,
      [scope],
    ),
    db.query<{ n: string }>(
      "select count(*) as n from identity_conflicts k where k.status = 'pending' and ($1::text[] is null or k.branch_ids <@ $1::text[])",
      [scope],
    ),
    db.query<{ business_now: Date; recorded_at: Date; duration_ms: number; scope: string }>(
      "select business_now, recorded_at, duration_ms, scope from identity_runs where scope = 'all' order by id desc limit 1",
    ),
  ]);
  const lifecycle: Record<Lifecycle, number> = { prospect: 0, sold: 0, serviced: 0, cancelled: 0, unknown: 0 };
  let withoutIdentity = 0;
  for (const r of counts.rows) {
    lifecycle[r.lifecycle] = Number(r.n);
    withoutIdentity += Number(r.without_identity);
  }
  const last = run.rows[0];
  return {
    lifecycle,
    pendingConflicts: Number(conflicts.rows[0].n),
    customersWithoutIdentity: withoutIdentity,
    lastRun: last
      ? { businessNow: last.business_now.toISOString(), recordedAt: last.recorded_at.toISOString(), durationMs: last.duration_ms, scope: last.scope }
      : null,
  };
}
