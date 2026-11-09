import Link from "next/link";
import { Suspense } from "react";
import { AtRiskSplit } from "@/components/AtRiskSplit";
import { Bridge } from "@/components/Bridge";
import { Badge, Card, Forbidden, PeriodTabs, Skeleton, Stat, TableWrap, Td, Th } from "@/components/ui";
import { attentionFlags } from "@/lib/attention";
import { KIND_LABEL, count, dateTime, money, pct } from "@/lib/format";
import { brandRows } from "@/lib/metrics/brands";
import { decisionHolds } from "@/lib/metrics/decision";
import { branchRows, conversionBridge, freshness, totals } from "@/lib/metrics/scorecard";
import { parsePeriod } from "@/lib/period";
import { BRANDS, BRAND_BY_ID, type BrandId } from "@/lib/reference";
import { getPool, getViewer } from "@/lib/server";
import { ForbiddenError, resolveBrandScope, type Viewer } from "@/lib/viewer";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

export default function OverviewPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <Overview searchParams={searchParams} />
    </Suspense>
  );
}

async function Overview({ searchParams }: { searchParams: SearchParams }) {
  const sp = await searchParams;
  const period = parsePeriod(sp.period);
  const viewer = await getViewer();
  const pool = getPool();
  const brandParam = typeof sp.brand === "string" && BRAND_BY_ID.has(sp.brand as BrandId) ? (sp.brand as BrandId) : null;
  let branchIds = viewer.branchIds;
  if (brandParam) {
    try {
      branchIds = resolveBrandScope(viewer, brandParam);
    } catch (error) {
      if (error instanceof ForbiddenError) return <Forbidden message={error.message} />;
      throw error;
    }
  }
  const brand = brandParam ? BRAND_BY_ID.get(brandParam)! : null;
  const scope = { from: period.from, to: period.to, branchIds };
  const [rows, bridge, streams, holds, brands] = await Promise.all([
    branchRows(pool, scope),
    conversionBridge(pool, scope),
    freshness(pool),
    decisionHolds(pool, branchIds),
    brand ? Promise.resolve([]) : brandRows(pool, scope),
  ]);
  const t = await totals(pool, scope, rows);
  const flags = attentionFlags(rows);
  const ranked = [...rows].sort((a, b) => (flags.get(b.branchId)?.length ?? 0) - (flags.get(a.branchId)?.length ?? 0) || b.atRiskCents - a.atRiskCents);
  const flagged = ranked.filter((r) => (flags.get(r.branchId)?.length ?? 0) > 0);

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs font-medium uppercase tracking-wide text-faint">{brand ? `${brand.name} · ${branchIds!.length} branches` : viewer.brandIds ? viewer.brandIds.map((b) => BRAND_BY_ID.get(b)!.name).join(", ") : viewer.branchIds ? `Branch ${viewer.branchIds.join(", ")}` : "All 44 branches"} · {period.label}</p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">Where did the conversions go?</h1>
          <p className="mt-2 max-w-3xl text-sm text-muted" data-testid="headline-answer">
            Ad platforms claimed <strong className="text-text">{count(bridge.platformClaimed)}</strong> conversions. We received{" "}
            <strong className="text-text">{count(bridge.paidProspects)}</strong> unique paid prospects; <strong className="text-text">{count(bridge.serviced)}</strong> are
            serviced customers so far. Paid-media CAC is <strong className="text-text">{money(t.paidCacCents)}</strong>.{" "}
            {t.openExceptions > 0 ? (
              <>
                <strong className="text-text">{count(t.openExceptions)}</strong> open exceptions involve{" "}
                <strong className="text-text">{money(t.atRiskCents)}</strong> of collected revenue
                <AtRiskSplit untiedCents={t.untiedCents} creditDisputedCents={t.creditDisputedCents} />
                {flagged.length > 0 && (
                  <>
                    {" "}— start with <Link className="text-accent underline" href={`/branches/${flagged[0].branchId}?period=${period.key}`}>{flagged[0].branchId} {flagged[0].name}</Link>
                  </>
                )}
                .
              </>
            ) : (
              <>No open exceptions in scope.</>
            )}
          </p>
        </div>
        <div className="flex flex-col items-end gap-2">
          <BrandTabs viewer={viewer} current={brandParam} period={period.key} />
          <PeriodTabs current={period.key} base="/" extra={brandParam ? `&brand=${brandParam}` : ""} />
        </div>
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat metric="paidSpend" value={money(t.paidSpendCents, true)} sub={t.unallocatedSpendCents > 0 ? `+ ${money(t.unallocatedSpendCents)} on unmapped campaigns` : "all spend mapped"} subTone={t.unallocatedSpendCents > 0 ? "bad" : "neutral"} />
        <Stat metric="prospects" value={count(t.prospects)} sub={`${count(t.rawLeads)} lead records`} />
        <Stat metric="acquired" value={count(t.acquired)} sub={`${count(t.paidAcquired)} from paid media`} />
        <Stat metric="paidCac" value={money(t.paidCacCents)} sub="period CAC, not cohort" />
        <Stat metric="unknownShare" value={pct(t.unknownShare)} sub={`${count(t.unknownAcquired)} customers`} />
        <Stat metric="newCollected" value={money(t.newCustomerCollectedCents, true)} sub={`${money(t.newCustomerAcvCents, true)} booked annual value (not revenue)`} />
      </div>

      <Card
        title="Budget decisions on hold"
        subtitle="Open incidents that change what a paid channel cost or which customers it produced. Until they are fixed, a channel comparison at that branch is not a safe basis for moving budget."
      >
        {holds.length === 0 ? (
          <p className="text-sm text-muted" data-testid="decision-holds-empty">No budget signal in your scope is gated by an open incident.</p>
        ) : (
          <ul className="divide-y divide-border text-sm" data-testid="decision-holds">
            {holds.map((h) => (
              <li key={h.exceptionId} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 py-2">
                <Link href={`/branches/${h.branchId}?period=${period.key}`} className="font-medium text-accent hover:underline">
                  {h.branchId}
                </Link>
                <Badge tone="bad">{h.kind === "channel_coverage_gap" ? "Channel imbalance" : KIND_LABEL[h.kind] ?? h.kind}</Badge>
                <span className="min-w-0 flex-1">{h.summary}</span>
                <span className="flex gap-3 text-xs">
                  <Link href={`/exceptions/${h.exceptionId}`} className="text-accent hover:underline">incident #{h.exceptionId}</Link>
                  <Link href={`/decisions?branch=${h.branchId}&period=${period.key}`} className="text-accent hover:underline">readiness</Link>
                </span>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {brands.length > 1 && (
        <Card title="By brand" subtitle="Each brand computed like the company line, not summed from branch rows. Spend on unmapped campaigns belongs to no brand. Brand names are public; which branch trades under which brand is synthetic.">
          <TableWrap>
            <thead>
              <tr>
                <Th>Brand</Th>
                <Th align="right">Branches</Th>
                <Th align="right">Paid spend</Th>
                <Th align="right">Paid CAC</Th>
                <Th align="right">New cust.</Th>
                <Th align="right">Unattributed</Th>
                <Th align="right">Open exceptions</Th>
                <Th align="right">At risk</Th>
              </tr>
            </thead>
            <tbody data-testid="brand-table">
              {brands.map((b) => (
                <tr key={b.brandId}>
                  <Td>
                    <Link className="font-medium text-accent hover:underline" href={`/?brand=${b.brandId}&period=${period.key}`}>
                      {b.name}
                    </Link>
                    {!b.complete && <div className="text-[11px] text-faint">partial: your scope covers part of this brand</div>}
                  </Td>
                  <Td align="right">{count(b.branchIds.length)}</Td>
                  <Td align="right">{money(b.totals.paidSpendCents, true)}</Td>
                  <Td align="right">{money(b.totals.paidCacCents)}</Td>
                  <Td align="right">{count(b.totals.acquired)}</Td>
                  <Td align="right">{pct(b.totals.unknownShare)}</Td>
                  <Td align="right">{count(b.totals.openExceptions)}</Td>
                  <Td align="right">{money(b.totals.atRiskCents)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>
      )}

      <div className="grid gap-6 xl:grid-cols-5">
        <Card className="xl:col-span-2" title="Conversion bridge" subtitle="Claimed → received → serviced, one prospect at a time">
          <Bridge data={bridge} periodLabel={period.label} />
        </Card>

        <Card
          className="xl:col-span-3"
          title={viewer.branchIds && !viewer.brandIds ? "Your branch" : "Branches that need a look first"}
          subtitle="Flags compare each branch with the median branch in this period. Click a branch to investigate."
        >
          <TableWrap>
            <thead>
              <tr>
                <Th>Branch</Th>
                <Th>Why</Th>
                <Th align="right">Paid spend</Th>
                <Th align="right">Paid CAC</Th>
                <Th align="right">Unattributed</Th>
                <Th align="right">New cust.</Th>
                <Th align="right">At risk</Th>
              </tr>
            </thead>
            <tbody data-testid="branch-table">
              {ranked.slice(0, ranked.length <= 12 ? ranked.length : 12).map((r) => {
                const f = flags.get(r.branchId) ?? [];
                return (
                  <tr key={r.branchId} className={f.length ? "bg-warn-soft/40" : ""}>
                    <Td>
                      <Link className="font-medium text-accent hover:underline" href={`/branches/${r.branchId}?period=${period.key}`}>
                        {r.branchId} {r.name}
                      </Link>
                      <div className="text-[11px] text-faint">{r.region}</div>
                    </Td>
                    <Td>
                      <div className="flex flex-wrap gap-1">
                        {f.length ? f.map((x) => <Badge key={x.code} tone={x.code === "exceptions" ? "warn" : "bad"}>{x.label}</Badge>) : <span className="text-xs text-faint">—</span>}
                      </div>
                    </Td>
                    <Td align="right">{money(r.paidSpendCents, true)}</Td>
                    <Td align="right">{money(r.paidAcquired ? Math.round(r.paidSpendCents / r.paidAcquired) : null)}</Td>
                    <Td align="right">{pct(r.acquired ? r.unknownAcquired / r.acquired : null)}</Td>
                    <Td align="right">{count(r.acquired)}</Td>
                    <Td align="right">{money(r.atRiskCents)}</Td>
                  </tr>
                );
              })}
            </tbody>
          </TableWrap>
          {rows.length > 12 && <p className="mt-3 text-xs text-faint">Showing 12 of {rows.length} branches, flagged first.</p>}
        </Card>
      </div>

      <Card title="Data freshness" subtitle="Every number above is only as current as the feeds below">
        <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {streams.map((s) => (
            <div key={s.stream} className="rounded border border-border p-2 text-xs">
              <div className="flex items-center justify-between">
                <span className="font-mono text-[11px]">{s.stream}</span>
                <Badge tone={s.lastRunStatus === "succeeded" ? "good" : "bad"}>{s.lastRunStatus ?? "never"}</Badge>
              </div>
              <div className="mt-1 text-faint">last success {dateTime(s.lastSuccessAt)}</div>
              {s.quarantined > 0 && <div className="mt-0.5 text-bad">{s.quarantined} quarantined in source</div>}
            </div>
          ))}
        </div>
        <p className="mt-3 text-xs text-faint">
          <Link href="/integrations" className="text-accent hover:underline">Integration runs, quarantine and replays →</Link>
        </p>
      </Card>
    </div>
  );
}

/** Brand slices the viewer may open: every brand for an unscoped viewer, else its own brands. */
function BrandTabs({ viewer, current, period }: { viewer: Viewer; current: BrandId | null; period: string }) {
  if (viewer.branchIds && !viewer.brandIds) return null;
  const allowed = viewer.brandIds ? BRANDS.filter((b) => viewer.brandIds!.includes(b.id)) : BRANDS;
  const tabs: Array<[BrandId | null, string]> = [...(viewer.brandIds ? [] : [[null, "All brands"] as [null, string]]), ...allowed.map((b) => [b.id, b.name] as [BrandId, string])];
  if (tabs.length < 2) return null;
  return (
    <nav aria-label="Brand" className="inline-flex rounded-md border border-border bg-surface p-0.5 text-xs" data-testid="brand-tabs">
      {tabs.map(([id, label]) => (
        <Link
          key={id ?? "all"}
          href={id ? `/?brand=${id}&period=${period}` : `/?period=${period}`}
          aria-current={current === id ? "page" : undefined}
          className={`rounded px-2.5 py-1 ${current === id ? "bg-text text-white" : "text-muted hover:text-text"}`}
        >
          {label}
        </Link>
      ))}
    </nav>
  );
}
