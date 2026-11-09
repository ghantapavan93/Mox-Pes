import Link from "next/link";
import { Suspense } from "react";
import { CustomerFilters } from "@/components/customers/CustomerFilters";
import { ConflictList } from "@/components/customers/IdentityPanel";
import { Badge, Card, Forbidden, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { count, date, dateTime, money } from "@/lib/format";
import {
  LIFECYCLE_FILTERS,
  LIFECYCLE_TONE,
  identityOverview,
  journeyPath,
  listIdentityConflicts,
  searchCustomers,
  type CustomerPage,
  type LifecycleFilter,
} from "@/lib/identity";
import { BRANCHES, BRANCH_BY_ID, CHANNEL_BY_CODE, type ChannelCode } from "@/lib/reference";
import { getPool, getViewer } from "@/lib/server";
import { ForbiddenError, resolveScope, type Viewer } from "@/lib/viewer";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v);

const PAGE_SIZE = 50;
const LIFECYCLE_LABEL: Record<string, string> = {
  prospect: "Prospects",
  sold: "Sold, not yet serviced",
  serviced: "Serviced",
  cancelled: "Cancelled",
  unknown: "Subscription not delivered",
};

export default function CustomersPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<Skeleton lines={12} />}>
      <Customers searchParams={searchParams} />
    </Suspense>
  );
}

async function Customers({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const viewer = await getViewer();
  const branch = one(sp.branch) ?? "";
  const q = (one(sp.q) ?? "").slice(0, 64);
  const lifecycleParam = one(sp.lifecycle) ?? "";
  const lifecycle = (LIFECYCLE_FILTERS as readonly string[]).includes(lifecycleParam) ? (lifecycleParam as LifecycleFilter) : undefined;
  const page = Math.max(1, Math.min(10_000, Number.parseInt(one(sp.page) ?? "1", 10) || 1));

  let scope: string[] | null;
  try {
    scope = resolveScope(viewer, /^B\d{2}$/.test(branch) ? branch : null);
  } catch (error) {
    if (error instanceof ForbiddenError) return <Forbidden message={error.message} />;
    throw error;
  }

  const branchOptions = BRANCHES.filter((b) => !viewer.branchIds || viewer.branchIds.includes(b.id)).map((b) => ({ id: b.id, label: `${b.id} ${b.name}` }));
  const href = (patch: Record<string, string | undefined>) => {
    const params = new URLSearchParams();
    const merged: Record<string, string | undefined> = { q: q || undefined, branch: branch || undefined, lifecycle, ...patch };
    for (const [k, v] of Object.entries(merged)) if (v) params.set(k, v);
    const qs = params.toString();
    return qs ? `/customers?${qs}` : "/customers";
  };

  return (
    <div className="space-y-6">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Customer Journeys</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Every call, web form and door-to-door sale attached to the CRM customer it belongs to, by exact phone or email hash only.
          A lead that could be more than one customer is never merged: it waits for a person to decide.
        </p>
      </div>

      <Suspense fallback={<Skeleton lines={2} />}>
        <OverviewTiles scope={scope} href={href} lifecycle={lifecycle} />
      </Suspense>

      <Card title="Search" subtitle={scope ? `Scope: ${scope.join(", ")}` : "Scope: all branches"}>
        <CustomerFilters
          q={q}
          branch={branch}
          lifecycle={lifecycle ?? ""}
          branchOptions={branchOptions}
          lifecycleOptions={LIFECYCLE_FILTERS.map((l) => ({ value: l, label: LIFECYCLE_LABEL[l] }))}
        >
          <Suspense fallback={<Skeleton lines={10} />}>
            <Results scope={scope} q={q} lifecycle={lifecycle} page={page} href={href} />
          </Suspense>
        </CustomerFilters>
      </Card>

      <Suspense fallback={<Skeleton lines={3} />}>
        <ReviewQueue scope={scope} viewer={viewer} />
      </Suspense>
    </div>
  );
}

async function OverviewTiles({ scope, href, lifecycle }: { scope: string[] | null; href: (p: Record<string, string | undefined>) => string; lifecycle?: string }) {
  const o = await identityOverview(getPool(), scope);
  const tiles: Array<{ key: string; label: string; value: number }> = [
    ...LIFECYCLE_FILTERS.map((l) => ({ key: l, label: LIFECYCLE_LABEL[l], value: o.lifecycle[l] })),
    ...(o.lifecycle.unknown > 0 ? [{ key: "unknown", label: LIFECYCLE_LABEL.unknown, value: o.lifecycle.unknown }] : []),
  ];
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 lg:grid-cols-6">
      {tiles.map((t) =>
        t.key === "unknown" ? (
          <div key={t.key} className="rounded-lg border border-border bg-surface p-3 text-sm">
            <div className="text-xs text-muted">{t.label}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{count(t.value)}</div>
          </div>
        ) : (
          <Link
            key={t.key}
            href={href({ lifecycle: lifecycle === t.key ? undefined : t.key, page: undefined })}
            aria-current={lifecycle === t.key ? "true" : undefined}
            className={`rounded-lg border bg-surface p-3 text-sm hover:border-accent ${lifecycle === t.key ? "border-accent" : "border-border"}`}
          >
            <div className="text-xs text-muted">{t.label}</div>
            <div className="mt-1 text-xl font-semibold tabular-nums">{count(t.value)}</div>
          </Link>
        ),
      )}
      <a href="#identity-review" className={`rounded-lg border bg-surface p-3 text-sm hover:border-accent ${o.pendingConflicts > 0 ? "border-warn" : "border-border"}`}>
        <div className="text-xs text-muted">Identity matches awaiting review</div>
        <div className={`mt-1 text-xl font-semibold tabular-nums ${o.pendingConflicts > 0 ? "text-warn" : ""}`}>{count(o.pendingConflicts)}</div>
      </a>
      <div className="rounded-lg border border-border bg-surface p-3 text-sm">
        <div className="text-xs text-muted">Identity last resolved</div>
        <div className="mt-1 text-sm font-semibold">{o.lastRun ? dateTime(o.lastRun.businessNow) : "never"}</div>
        <div className="text-[11px] text-faint">
          {o.lastRun ? `full run in ${count(o.lastRun.durationMs)} ms` : "run scripts/resolve-identities.ts"}
          {o.customersWithoutIdentity > 0 && ` · ${count(o.customersWithoutIdentity)} new CRM customers not yet resolved`}
        </div>
      </div>
    </div>
  );
}

async function Results({ scope, q, lifecycle, page, href }: { scope: string[] | null; q: string; lifecycle?: LifecycleFilter; page: number; href: (p: Record<string, string | undefined>) => string }) {
  const result: CustomerPage = await searchCustomers(getPool(), { q, lifecycle, page, pageSize: PAGE_SIZE }, scope);
  if (result.total === 0) {
    return (
      <div className="rounded border border-dashed border-border p-6 text-center text-sm text-muted" data-testid="customers-empty">
        {q ? (
          <>
            Nothing in scope matches <span className="font-mono">{q}</span>
            {lifecycle ? <> with lifecycle <span className="font-medium">{LIFECYCLE_LABEL[lifecycle].toLowerCase()}</span></> : null}. Search takes a CRM customer id, a
            lead id or a prospect reference{lifecycle ? <>; <Link href={href({ lifecycle: undefined, page: undefined })} className="text-accent hover:underline">search all lifecycles</Link></> : null}.
          </>
        ) : (
          "No customers or prospects in this scope and filter."
        )}
      </div>
    );
  }
  const first = (result.page - 1) * result.pageSize + 1;
  const last = first + result.rows.length - 1;
  const pages = Math.ceil(result.total / result.pageSize);
  return (
    <div className="space-y-3">
      <TableWrap>
        <thead>
          <tr>
            <Th>Customer</Th>
            <Th>Lifecycle</Th>
            <Th>Branch</Th>
            <Th>Credited channel</Th>
            <Th align="right">Lead records</Th>
            <Th align="right">Collected</Th>
            <Th>First seen</Th>
            <Th>Last activity</Th>
          </tr>
        </thead>
        <tbody data-testid="customer-table">
          {result.rows.map((r) => {
            const path = journeyPath({ kind: r.kind, crmCustomerId: r.crmCustomerId, identityId: r.identityId ?? 0 });
            const channel = r.channelCode ? (CHANNEL_BY_CODE.get(r.channelCode as ChannelCode)?.label ?? r.channelCode) : null;
            return (
              <tr key={`${r.kind}:${r.crmCustomerId ?? r.identityId}`} className="hover:bg-surface-2">
                <Td>
                  <Link href={path} className="font-mono text-sm font-medium text-accent hover:underline">
                    {r.kind === "customer" ? r.crmCustomerId : `P-${r.identityId}`}
                  </Link>
                  <div className="text-[11px] text-faint">{r.kind === "customer" ? "CRM customer" : "prospect (no CRM record)"}</div>
                </Td>
                <Td>
                  <Badge tone={LIFECYCLE_TONE[r.lifecycle]}>{r.lifecycle}</Badge>
                  {r.pendingConflicts > 0 && <div className="mt-1"><Badge tone="warn">{r.pendingConflicts} to review</Badge></div>}
                </Td>
                <Td className="text-xs">{r.branchId ? `${r.branchId} ${BRANCH_BY_ID.get(r.branchId)?.name ?? ""}` : <span className="text-faint">unknown</span>}</Td>
                <Td className="text-xs">
                  {channel ?? <span className="text-faint">unknown</span>}
                  {r.kind === "customer" && r.attributionBasis && r.attributionBasis !== "lead_evidence" && (
                    <div className="text-faint">{r.attributionBasis === "no_lead_record" ? "no lead record" : "lead without evidence"}</div>
                  )}
                  {r.kind === "prospect" && <div className="text-faint">first lead</div>}
                </Td>
                <Td align="right">{count(r.leadRecords)}</Td>
                <Td align="right">{r.kind === "prospect" ? <span className="text-faint">—</span> : money(r.collectedCents ?? 0)}</Td>
                <Td className="text-xs text-muted">{date(r.firstSeenAt)}</Td>
                <Td className="text-xs text-muted">{date(r.lastActivityAt)}</Td>
              </tr>
            );
          })}
        </tbody>
      </TableWrap>
      <nav aria-label="Pagination" className="flex flex-wrap items-center justify-between gap-2 text-xs text-muted">
        <span>
          {count(first)}–{count(last)} of {count(result.total)}
        </span>
        <span className="flex gap-2">
          {result.page > 1 ? (
            <Link href={href({ page: String(result.page - 1) })} className="rounded border border-border px-2 py-1 text-accent hover:bg-surface-2">← Previous</Link>
          ) : (
            <span className="rounded border border-border px-2 py-1 text-faint" aria-disabled="true">← Previous</span>
          )}
          <span className="px-1 py-1">page {count(result.page)} of {count(pages)}</span>
          {result.page < pages ? (
            <Link href={href({ page: String(result.page + 1) })} className="rounded border border-border px-2 py-1 text-accent hover:bg-surface-2">Next →</Link>
          ) : (
            <span className="rounded border border-border px-2 py-1 text-faint" aria-disabled="true">Next →</span>
          )}
        </span>
      </nav>
    </div>
  );
}

async function ReviewQueue({ scope, viewer }: { scope: string[] | null; viewer: Viewer }) {
  const { rows, total } = await listIdentityConflicts(getPool(), { status: "pending", limit: 20 }, scope);
  return (
    <section id="identity-review">
      <Card
        title={`Identity review queue (${count(total)} pending)`}
        subtitle="Leads whose phone or email hash points at more than one CRM customer, or at a customer a reviewer rejected before. They stay unlinked until someone decides."
      >
        {rows.length === 0 ? (
          <p className="text-sm text-muted" data-testid="identity-queue-empty">
            Nothing to review in this scope: every lead matched zero or exactly one CRM customer by exact hash.
          </p>
        ) : (
          <>
            <ConflictList conflicts={rows} viewer={viewer} />
            {total > rows.length && <p className="mt-2 text-xs text-muted">Showing the {count(rows.length)} most recent of {count(total)}.</p>}
          </>
        )}
      </Card>
    </section>
  );
}
