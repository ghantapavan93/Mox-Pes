import { connection, NextResponse } from "next/server";
import { errorResponse } from "@/lib/http";
import { BRANCHES } from "@/lib/reference";
import { getPool, getViewer } from "@/lib/server";
import { KIND_LABEL } from "@/lib/format";
import { searchCustomers } from "@/lib/identity";

/** Lead source ids (calls CAL…, web msg-…, D2D S-…) and prospect references (P-<id>). */
const RECORD_REF = /^(cal|msg-|s-|p-)\S{1,40}$/i;

export interface SearchHit {
  kind: "branch" | "incident" | "customer" | "prospect";
  href: string;
  title: string;
  detail: string;
}

/**
 * GET /api/search?q= — command-menu lookup over branches, incidents (by id, branch or summary
 * text), CRM customers (by id) and resolved identities (by lead source id or P-<id>, through
 * the Identity module's searchCustomers). Branch scope is applied in SQL: a branch partner
 * never sees another branch's records here. Phone numbers and emails are never searchable.
 */
export async function GET(request: Request) {
  // Outside try: during prerendering connection() rejects by design, and that must not be logged as a route error.
  await connection();
  try {
    const q = (new URL(request.url).searchParams.get("q") ?? "").trim();
    if (q.length < 1) return NextResponse.json({ hits: [] });
    const viewer = await getViewer();
    const scope = viewer.branchIds;
    const needle = q.toLowerCase();

    const branches: SearchHit[] = BRANCHES.filter((b) => !scope || scope.includes(b.id))
      .filter((b) => b.id.toLowerCase().includes(needle) || b.name.toLowerCase().includes(needle))
      .slice(0, 6)
      .map((b) => ({ kind: "branch", href: `/branches/${b.id}`, title: `${b.id} ${b.name}`, detail: `${b.region} · ${b.timezone}` }));

    const pool = getPool();
    const digits = /^#?\d+$/.test(q) ? q.replace("#", "") : null;
    const [incidents, customers, identities] = await Promise.all([
      pool.query(
        `select id, kind, branch_id, summary from exceptions
         where ($1::text[] is null or branch_id = any($1::text[]))
           and (($2::text is not null and id::text = $2) or upper(branch_id) = upper($3) or summary ilike '%' || $3 || '%')
         order by (status = 'open') desc, id desc limit 6`,
        [scope, digits, q],
      ),
      digits
        ? pool.query(
            `select c.crm_customer_id, b.id as branch_id, b.name
             from crm_customers c join branches b on b.crm_office_id = c.office_id
             where c.crm_customer_id::text like $1 || '%' and ($2::text[] is null or b.id = any($2::text[]))
             order by c.crm_customer_id limit 6`,
            [digits, scope],
          )
        : Promise.resolve({ rows: [] as Array<Record<string, unknown>> }),
      RECORD_REF.test(q) && q.length >= 3 ? searchCustomers(pool, { q, pageSize: 5 }, scope).then((p) => p.rows) : Promise.resolve([]),
    ]);

    const hits: SearchHit[] = [
      ...branches,
      ...incidents.rows.map((r) => ({
        kind: "incident" as const,
        href: `/exceptions/${r.id}`,
        title: `#${r.id} ${KIND_LABEL[r.kind] ?? r.kind}`,
        detail: `${r.branch_id ?? "company"} · ${String(r.summary).slice(0, 90)}`,
      })),
      ...customers.rows.map((r) => ({
        kind: "customer" as const,
        href: `/customers/${r.crm_customer_id}`,
        title: `Customer #${r.crm_customer_id}`,
        detail: `${r.branch_id} ${r.name}`,
      })),
      ...identities.map((r) =>
        r.crmCustomerId !== null
          ? { kind: "customer" as const, href: `/customers/${r.crmCustomerId}`, title: `Customer #${r.crmCustomerId}`, detail: `${r.branchId ?? "no branch"} · ${r.lifecycle} · matched ${q}` }
          : { kind: "prospect" as const, href: `/customers/P-${r.identityId}`, title: `Prospect P-${r.identityId}`, detail: `${r.branchId ?? "no branch"} · ${r.leadRecords} lead record(s)` },
      ),
    ];
    return NextResponse.json({ hits });
  } catch (error) {
    return errorResponse(error);
  }
}
