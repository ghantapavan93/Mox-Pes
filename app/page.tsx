import Link from "next/link";
import { Suspense } from "react";
import { ArrowRight } from "lucide-react";
import { AtRiskSplit } from "@/components/AtRiskSplit";
import { Bridge } from "@/components/Bridge";
import { StackedWeeks } from "@/components/StackedWeeks";
import { Badge, Callout, Card, Forbidden, PageHeader, PeriodTabs, Segmented, Skeleton, Stat, TableWrap, Td, Th } from "@/components/ui";
import { attentionFlags } from "@/lib/attention";
import { KIND_LABEL, count, dateTime, money, pct } from "@/lib/format";
import { brandRows } from "@/lib/metrics/brands";
import { decisionHolds } from "@/lib/metrics/decision";
import { branchRows, conversionBridge, freshness, totals, type Totals } from "@/lib/metrics/scorecard";
import { PERIODS, parsePeriod } from "@/lib/period";
import { weeklySeries } from "@/lib/queries";
import { BRANDS, BRAND_BY_ID, type BrandId } from "@/lib/reference";
import { getPool, getViewer } from "@/lib/server";
import { ForbiddenError, resolveBrandScope, type Viewer } from "@/lib/viewer";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;

// The root page shares the layout's segment, where the title template does not apply.
export const metadata = { title: { absolute: "Overview · Revenue Signal OS" } };

export default function OverviewPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <Overview searchParams={searchParams} />
    </Suspense>
  );
}

/** Change against the comparison period, phrased for a KPI tile. `better` = which way is good. */
function delta(now: number | null, before: number | null, better: "up" | "down" | null, kind: "pct" | "pts" = "pct") {
  if (now === null || before === null || before === 0) return undefined;
  const diff = kind === "pts" ? (now - before) * 100 : ((now - before) / Math.abs(before)) * 100;
  const direction = Math.abs(diff) < 0.5 ? ("flat" as const) : diff > 0 ? ("up" as const) : ("down" as const);
  const good = better === null || direction === "flat" ? null : (direction === "up") === (better === "up");
  const label = `${diff > 0 ? "+" : ""}${diff.toFixed(kind === "pts" ? 1 : 0)}${kind === "pts" ? " pts" : "%"} vs Sep`;
  return { label, direction, good };
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
  // October is compared with September (same length, same definitions); other periods are not.
  const compare = period.key === "oct" ? { from: PERIODS.sep.from, to: PERIODS.sep.to, branchIds } : null;
  const [rows, bridge, streams, holds, brands, weeks, before] = await Promise.all([
    branchRows(pool, scope),
    conversionBridge(pool, scope),
    freshness(pool),
    decisionHolds(pool, branchIds),
    brand ? Promise.resolve([]) : brandRows(pool, scope),
    weeklySeries(pool, branchIds),
    compare ? totals(pool, compare) : Promise.resolve(null as Totals | null),
  ]);
  const t = await totals(pool, scope, rows);
  const flags = attentionFlags(rows);
  const ranked = [...rows].sort((a, b) => (flags.get(b.branchId)?.length ?? 0) - (flags.get(a.branchId)?.length ?? 0) || b.atRiskCents - a.atRiskCents);
  const flagged = ranked.filter((r) => (flags.get(r.branchId)?.length ?? 0) > 0);
  const heldBranches = [...new Set(holds.map((h) => h.branchId))];
  const scopeLabel = brand ? `${brand.name} · ${branchIds!.length} branches` : viewer.brandIds ? viewer.brandIds.map((b) => BRAND_BY_ID.get(b)!.name).join(", ") : viewer.branchIds ? `Branch ${viewer.branchIds.join(", ")}` : "All 44 branches";
  const shown = ranked.slice(0, ranked.length <= 12 ? ranked.length : 12);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`Marketing revenue integrity · ${scopeLabel} · ${period.label}`}
        title="Where did the conversions go?"
        description={
          <p className="max-w-3xl" data-testid="headline-answer">
            Ad platforms claimed <strong className="text-text">{count(bridge.platformClaimed)}</strong> conversions. We received{" "}
            <strong className="text-text">{count(bridge.paidProspects)}</strong> unique paid prospects; <strong className="text-text">{count(bridge.serviced)}</strong> are
            serviced customers so far. Paid-media CAC is <strong className="text-text">{money(t.paidCacCents)}</strong>{" "}
            {/* Name the CAC's own denominator: the serviced count above is a different number (UX
                red team 2026-11-12: spend ÷ the serviced count did not give the CAC shown). */}
            ({money(t.paidSpendCents, true)} of paid media spend ÷ {count(t.paidAcquired)} new customers whose first evidenced touch was paid).{" "}
            {t.openExceptions > 0 ? (
              <>
                <strong className="text-text">{count(t.openExceptions)}</strong> open exceptions involve{" "}
                <strong className="text-text">{money(t.atRiskCents)}</strong> of collected revenue
                <AtRiskSplit untiedCents={t.untiedCents} creditDisputedCents={t.creditDisputedCents} />
                {flagged.length > 0 && (
                  <>
                    {" "}— start with <Link className="font-medium text-accent underline" href={`/branches/${flagged[0].branchId}?period=${period.key}`}>{flagged[0].branchId} {flagged[0].name}</Link>
                  </>
                )}
                .
              </>
            ) : (
              <>No open exceptions in scope.</>
            )}
          </p>
        }
        toolbar={
          <>
            <BrandTabs viewer={viewer} current={brandParam} period={period.key} />
            <PeriodTabs current={period.key} base="/" extra={brandParam ? `&brand=${brandParam}` : ""} />
            {compare && <span className="text-xs text-faint">Changes compare with September (same branches, same definitions). October&apos;s last week is still maturing, so serviced-customer counts lag.</span>}
          </>
        }
      />

      {holds.length > 0 ? (
        <Callout
          tone="warn"
          title={`${holds.length} budget decision${holds.length === 1 ? "" : "s"} on hold at ${heldBranches.join(", ")}`}
          action={<a href="#holds" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">Review <ArrowRight aria-hidden className="size-3" /></a>}
        >
          Open incidents change what a paid channel cost or which customers it produced there. Channel comparisons at those branches are not a safe basis for moving budget yet.
        </Callout>
      ) : (
        <Callout tone="good" title="No budget decision in your scope is blocked by an open incident">
          Channel comparisons still show their blockers branch by branch.
        </Callout>
      )}

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat metric="paidSpend" value={money(t.paidSpendCents, true)} delta={delta(t.paidSpendCents, before?.paidSpendCents ?? null, null)} sub={t.unallocatedSpendCents > 0 ? `+ ${money(t.unallocatedSpendCents)} on unmapped campaigns` : "all spend mapped"} subTone={t.unallocatedSpendCents > 0 ? "bad" : "neutral"} />
        <Stat metric="prospects" value={count(t.prospects)} delta={delta(t.prospects, before?.prospects ?? null, "up")} sub={`${count(t.rawLeads)} lead records`} />
        <Stat metric="acquired" value={count(t.acquired)} delta={delta(t.acquired, before?.acquired ?? null, "up")} sub={`${count(t.paidAcquired)} from paid media`} />
        <Stat metric="paidCac" value={money(t.paidCacCents)} delta={delta(t.paidCacCents, before?.paidCacCents ?? null, "down")} sub="period CAC, not cohort" />
        <Stat metric="unknownShare" value={pct(t.unknownShare)} delta={delta(t.unknownShare, before?.unknownShare ?? null, "down", "pts")} sub={`${count(t.unknownAcquired)} customers`} />
        <Stat metric="newCollected" value={money(t.newCustomerCollectedCents, true)} delta={delta(t.newCustomerCollectedCents, before?.newCustomerCollectedCents ?? null, "up")} sub={`${money(t.newCustomerAcvCents, true)} booked annual value (not revenue)`} />
      </div>

      <div className="grid gap-6 xl:grid-cols-5">
        <Card
          id="holds"
          className="xl:col-span-3"
          title="Issues requiring review"
          subtitle="Open incidents that put a branch's budget signal on hold, most severe first"
          action={<Link href="/exceptions" className="text-xs font-medium text-accent hover:underline">All incidents</Link>}
          flush
        >
          {holds.length === 0 ? (
            <p className="px-4 py-6 text-sm text-muted" data-testid="decision-holds-empty">No budget signal in your scope is gated by an open incident.</p>
          ) : (
            <ul className="divide-y divide-border text-sm" data-testid="decision-holds">
              {holds.map((h) => (
                <li key={`${h.exceptionId}:${h.branchId}`} className="grid grid-cols-[3.25rem_1fr] gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[3.25rem_1fr_auto]">
                  <Link href={`/branches/${h.branchId}?period=${period.key}`} className="font-semibold text-accent hover:underline">
                    {h.branchId}
                  </Link>
                  <div className="min-w-0">
                    <Badge tone="bad" dot>{h.kind === "channel_coverage_gap" ? "Channel imbalance" : KIND_LABEL[h.kind] ?? h.kind}</Badge>
                    <p className="mt-1 leading-5 text-text">{h.summary}</p>
                  </div>
                  <span className="col-start-2 flex gap-3 text-xs sm:col-start-auto sm:flex-col sm:items-end sm:gap-0">
                    <Link href={`/exceptions/${h.exceptionId}`} className="inline-flex min-h-6 items-center font-medium text-accent hover:underline">incident #{h.exceptionId}</Link>
                    <Link href={`/decisions?branch=${h.branchId}&period=${period.key}`} className="inline-flex min-h-6 items-center text-accent hover:underline">readiness</Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="xl:col-span-2" title="New customers serviced, by week" subtitle={`How their source is known · Sep–Oct${period.key === "oct" ? " (October in full colour)" : ""}`}>
          <StackedWeeks points={weeks} label="New customers serviced per week, by source: paid media, unknown, other" highlightFrom={period.key === "oct" ? "2026-09-28" : undefined} />
          <p className="mt-3 text-xs leading-5 text-muted">A jump in <span className="font-medium text-warn">unknown source</span> with no change in total usually means broken capture or linkage, not changed customer behaviour.</p>
        </Card>
      </div>

      <div className="grid gap-6 xl:grid-cols-5">
        <Card className="xl:col-span-2" title="Conversion bridge" subtitle="Claimed → received → serviced, one prospect at a time">
          <Bridge data={bridge} periodLabel={period.label} />
        </Card>

        <Card
          className="xl:col-span-3"
          title={viewer.branchIds && !viewer.brandIds ? "Your branch" : "Branches that need a look first"}
          subtitle="Flags compare each branch with the median branch in this period. Select a branch to investigate."
          flush
        >
          <TableWrap label="Branches" flush minWidth={720}>
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
              {shown.map((r) => {
                const f = flags.get(r.branchId) ?? [];
                return (
                  <tr key={r.branchId} className={f.length ? "bg-warn-soft/30" : ""}>
                    <Td className="whitespace-nowrap">
                      <Link className="font-medium text-accent hover:underline" href={`/branches/${r.branchId}?period=${period.key}`}>
                        {r.branchId} {r.name}
                      </Link>
                      <div className="text-[11px] text-faint">{r.region}</div>
                    </Td>
                    <Td>
                      <div className="flex max-w-[15rem] flex-wrap gap-1">
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
          {rows.length > 12 && <p className="border-t border-border px-4 py-2.5 text-xs text-faint">Showing 12 of {rows.length} branches, flagged first.</p>}
        </Card>
      </div>

      {brands.length > 1 && (
        <Card title="By brand" subtitle="Each brand computed like the company line, not summed from branch rows. Unmapped spend belongs to no brand. Which branch trades under which brand is synthetic." flush>
          <TableWrap label="Brands" flush>
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
                  <Td className="whitespace-nowrap">
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

      <Card title="Data freshness" subtitle="Every number above is only as current as these feeds" action={<Link href="/integrations" className="text-xs font-medium text-accent hover:underline">Integration runs</Link>}>
        <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-5">
          {streams.map((s) => (
            <li key={s.stream} className="rounded-md border border-border px-3 py-2 text-xs">
              <div className="flex items-center justify-between gap-2">
                <span className="truncate font-mono text-[11px] text-text">{s.stream}</span>
                <Badge dot tone={s.lastRunStatus === "succeeded" ? "good" : "bad"}>{s.lastRunStatus ?? "never"}</Badge>
              </div>
              <div className="mt-1 text-muted">last success {dateTime(s.lastSuccessAt)}</div>
              {s.quarantined > 0 && <div className="mt-0.5 font-medium text-bad">{s.quarantined} quarantined in source</div>}
            </li>
          ))}
        </ul>
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
    <Segmented
      label="Brand"
      testId="brand-tabs"
      items={tabs.map(([id, label]) => ({ href: id ? `/?brand=${id}&period=${period}` : `/?period=${period}`, label, current: current === id }))}
    />
  );
}
