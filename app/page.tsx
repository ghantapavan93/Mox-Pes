import Link from "next/link";
import { Suspense } from "react";
import { ArrowRight, Info } from "lucide-react";
import { AtRiskSplit } from "@/components/AtRiskSplit";
import { Bridge } from "@/components/Bridge";
import { CountUp } from "@/components/CountUp";
import { StackedWeeks } from "@/components/StackedWeeks";
import { IncidentRef } from "@/components/incidents/IncidentRef";
import { MovementSectionAsync, MovementSkeleton } from "@/components/overview/MovementSection";
import { Badge, ButtonLink, Callout, Card, Forbidden, PageHeader, PeriodTabs, Segmented, Skeleton, Stat, TableWrap, Td, Th, metricAnchor } from "@/components/ui";
import { attentionFlags } from "@/lib/attention";
import { KIND_LABEL, count, dateTime, money, pct } from "@/lib/format";
import { brandRows } from "@/lib/metrics/brands";
import { decisionHolds, evidenceHolds } from "@/lib/metrics/decision";
import { overviewMovement, parseChannel, parseWeek } from "@/lib/metrics/movement";
import { branchRows, cacDefined, conversionBridge, freshness, paidCac, totals, type Totals } from "@/lib/metrics/scorecard";
import { PERIODS, parsePeriod } from "@/lib/period";
import { weeklySeries } from "@/lib/queries";
import { BRANCHES, BRANDS, BRAND_BY_ID, type BrandId } from "@/lib/reference";
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
  // The verdict's own reads: the branch rows behind the figure and "start with", the bridge in its
  // paragraph, and the holds the callout under it names. Nothing else is awaited before it
  // (release WP-G step 2, docs/agent-work/release/measurements/steps.md).
  const [rows, bridge, holds, held] = await Promise.all([
    branchRows(pool, scope),
    conversionBridge(pool, scope),
    // The holds on this period's decisions: a hold on refused spend revisions dated in another
    // period is that period's (HOLD-TO-DECISION.md, scenario 2b).
    decisionHolds(pool, branchIds, 8, period),
    // And the recommendations the records hold with no incident to say so: a channel the rule
    // covers whose spend is held at intake, has none recorded, or is counted at another branch.
    evidenceHolds(pool, branchIds, period),
  ]);
  const t = await totals(pool, scope, rows);
  // "What changed" (components/overview) starts its reads only now, once the page's own are done,
  // and reuses the page's holds. Started beside them, its queries took the pool's connections ahead
  // of the holds' and added 0.1–0.2 s to R-34's time to the hold; reading the holds again added
  // about 0.45 s of database work just as the hold was shown (docs/agent-work/OVERVIEW-MOVEMENT.md).
  // It renders in its own Suspense boundary, after the hold.
  const branchParam = typeof sp.branch === "string" && sp.branch !== "" ? sp.branch : null;
  const channelParam = parseChannel(sp.channel);
  const weekParam = parseWeek(sp.week);
  const movementReady = overviewMovement(pool, viewer, { branchParam, brandBranchIds: brand ? branchIds : null, period, pageHolds: holds, pageEvidenceHolds: held });
  movementReady.catch(() => {}); // awaited by the section; this only keeps an early failure from being unhandled
  // What the verdict does not show starts after it, and after "What changed" (the next section), so
  // it never competes with either for the database. Each part renders in its own Suspense section as
  // it arrives: the September comparison behind the tiles' deltas, the weekly series, the brand
  // lines (from the same branch rows: R-34) and the feeds' freshness.
  const beforeReady = compare ? totals(pool, compare) : Promise.resolve(null as Totals | null);
  const weeksReady = weeklySeries(pool, branchIds);
  const brandsReady = brand ? Promise.resolve([]) : brandRows(pool, scope, rows);
  const streamsReady = freshness(pool);
  // Awaited by their sections; this only keeps an early failure from being unhandled.
  for (const ready of [beforeReady, weeksReady, brandsReady, streamsReady]) ready.catch(() => {});
  const branchOptions = BRANCHES.filter((b) => branchIds === null || branchIds.includes(b.id));
  const flags = attentionFlags(rows);
  const ranked = [...rows].sort((a, b) => (flags.get(b.branchId)?.length ?? 0) - (flags.get(a.branchId)?.length ?? 0) || b.atRiskCents - a.atRiskCents);
  const flagged = ranked.filter((r) => (flags.get(r.branchId)?.length ?? 0) > 0);
  const heldBranches = [...new Set([...holds.map((h) => h.branchId), ...held.map((h) => h.branchId)])];
  const holdCount = holds.length + held.length;
  const scopeLabel = brand ? `${brand.name} · ${branchIds!.length} branches` : viewer.brandIds ? viewer.brandIds.map((b) => BRAND_BY_ID.get(b)!.name).join(", ") : viewer.branchIds ? `Branch ${viewer.branchIds.join(", ")}` : "All 44 branches";
  const shown = ranked.slice(0, ranked.length <= 12 ? ranked.length : 12);

  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow={`Marketing revenue integrity · ${scopeLabel} · ${period.label}`}
        title="Where did the conversions go?"
        description={
          // The answer leads with its one figure (the 3-second read), the page's one count-up
          // (docs/design-system.md, behaviour rule 13); the sentence under it says what the figure is and
          // where to start, and the paragraph after it is the funnel behind it.
          <div className="max-w-3xl space-y-3" data-testid="headline-answer">
            {t.openExceptions > 0 ? (
              <div data-testid="headline-at-risk">
                <p className="flex flex-wrap items-center gap-x-2">
                  <CountUp
                    value={t.atRiskCents / 100}
                    text={money(t.atRiskCents)}
                    decimals={Math.abs(t.atRiskCents) >= 100_000 ? 0 : 2}
                    prefix="$"
                    className="text-[32px] font-semibold leading-10 tracking-tight text-text"
                    testId="at-risk-figure"
                  />{" "}
                  <Link
                    href={`/definitions#${metricAnchor("atRisk")}`}
                    className="inline-flex size-6 items-center justify-center rounded text-faint hover:bg-surface-2 hover:text-accent"
                    title="Definition: revenue in open exceptions"
                  >
                    <Info aria-hidden className="size-3.5" />
                    <span className="sr-only">Definition of revenue in open exceptions</span>
                  </Link>
                </p>
                {/* The verdict: what the figure is and where to start. The harness times its first paint. */}
                <p className="mt-0.5 text-[15px] leading-6 text-text" elementtiming="verdict">
                  of collected revenue is in <strong className="font-semibold">{count(t.openExceptions)}</strong> open exceptions
                  <AtRiskSplit untiedCents={t.untiedCents} creditDisputedCents={t.creditDisputedCents} />
                  {flagged.length > 0 && (
                    <>
                      {" "}— start with {flagged[0].branchId} {flagged[0].name}
                    </>
                  )}
                  .
                </p>
                {flagged.length > 0 && (
                  // The page's one primary action: where the verdict says to start.
                  <div className="mt-2">
                    <ButtonLink href={`/branches/${flagged[0].branchId}?period=${period.key}`} variant="primary" testId="headline-action">
                      Open {flagged[0].branchId} {flagged[0].name}
                    </ButtonLink>
                  </div>
                )}
              </div>
            ) : (
              <p className="text-[15px] leading-6 text-text">No open exceptions in scope.</p>
            )}
            <p>
              Ad platforms claimed <strong className="text-text">{count(bridge.platformClaimed)}</strong> conversions. We received{" "}
              <strong className="text-text">{count(bridge.paidProspects)}</strong> unique paid prospects; <strong className="text-text">{count(bridge.serviced)}</strong> are
              serviced customers so far. Paid-media CAC is <strong className="text-text">{money(t.paidCacCents)}</strong>{" "}
              {/* Name the CAC's own denominator: the serviced count above is a different number (UX
                  red team 2026-11-12: spend ÷ the serviced count did not give the CAC shown). */}
              ({money(t.paidSpendCents, true)} of paid media spend ÷ {count(t.paidAcquired)} new customers whose first evidenced touch was paid).
            </p>
          </div>
        }
        toolbar={
          <>
            <BrandTabs viewer={viewer} current={brandParam} period={period.key} />
            {/* A period switch keeps the brand and the chart's branch, channel and week (release design §5.7). */}
            <PeriodTabs
              current={period.key}
              base="/"
              extra={`${brandParam ? `&brand=${brandParam}` : ""}${branchParam ? `&branch=${encodeURIComponent(branchParam)}` : ""}${channelParam && weekParam ? `&channel=${channelParam}&week=${weekParam}` : ""}`}
            />
            {compare && (
              <span className="text-xs text-faint">
                Changes compare with September (same branches, same definitions). The period ends Oct 30, the last complete day: Oct 31&apos;s CRM records count in no
                period yet. Its last week is still maturing, so serviced-customer counts lag.
              </span>
            )}
          </>
        }
      />

      {holdCount > 0 ? (
        <Callout
          tone="warn"
          title={`${holdCount} budget decision${holdCount === 1 ? "" : "s"} on hold at ${heldBranches.join(", ")}`}
          action={<a href="#holds" className="inline-flex items-center gap-1 text-xs font-medium text-accent hover:underline">Review <ArrowRight aria-hidden className="size-3" /></a>}
        >
          {holds.length > 0 && held.length === 0
            ? "Open incidents change what a paid channel cost or which customers it produced there. Channel comparisons at those branches are not a safe basis for moving budget yet."
            : holds.length === 0
              ? "A paid channel there has customers whose cost the records cannot count yet. Its branch has no channel ranking to move budget on; a pair of verified channels can still be compared."
              : "Open incidents, or customers whose cost the records cannot count yet, change what a paid channel cost there. Channel rankings at those branches are not a safe basis for moving budget yet."}
        </Callout>
      ) : (
        <Callout tone="good" title="No budget decision in your scope is blocked by an open incident">
          Channel comparisons still show their blockers branch by branch.
        </Callout>
      )}

      <Suspense fallback={<MovementSkeleton />}>
        <MovementSectionAsync
          ready={movementReady}
          branchOptions={branchOptions}
          periodKey={period.key}
          brandParam={brandParam}
          selection={channelParam && weekParam ? { channel: channelParam, week: weekParam } : null}
          scoped={viewer.branchIds !== null}
        />
      </Suspense>

      <Suspense fallback={<StatTiles t={t} before={null} pending={compare !== null} />}>
        <StatTilesAsync t={t} before={beforeReady} />
      </Suspense>

      <div className="grid gap-6 xl:grid-cols-5">
        <Card
          id="holds"
          className="xl:col-span-3"
          title="Issues requiring review"
          subtitle={held.length > 0 ? "Open incidents, most severe first, then channels whose cost the records cannot count yet" : "Open incidents that put a branch's budget signal on hold, most severe first"}
          action={<Link href="/exceptions" className="text-xs font-medium text-accent hover:underline">All incidents</Link>}
          flush
        >
          {holdCount === 0 ? (
            <p className="px-4 py-6 text-sm text-muted" data-testid="decision-holds-empty">No budget signal in your scope is gated by an open incident.</p>
          ) : (
            <ul className="divide-y divide-border text-sm" data-testid="decision-holds">
              {holds.map((h) => (
                <li key={`${h.exceptionId}:${h.branchId}`} className="grid grid-cols-[3.25rem_1fr] gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[3.25rem_1fr_auto]">
                  <Link href={`/branches/${h.branchId}?period=${period.key}`} className="font-semibold text-accent hover:underline">
                    {h.branchId}
                  </Link>
                  <div className="min-w-0">
                    <Badge tone="bad" dot>{h.kind === "channel_coverage_gap" ? "Channel imbalance" : h.refusedRevision ? "Spend revision refused" : KIND_LABEL[h.kind] ?? h.kind}</Badge>
                    <p className="mt-1 leading-5 text-text">{h.summary}</p>
                  </div>
                  <span className="col-start-2 flex gap-3 text-xs sm:col-start-auto sm:flex-col sm:items-end sm:gap-0">
                    <IncidentRef
                      href={`/exceptions/${h.exceptionId}?period=${period.key}#recovery`}
                      companyLevel={h.companyLevel}
                      scoped={viewer.branchIds !== null}
                      className="inline-flex min-h-6 items-center font-medium text-accent hover:underline"
                    >
                      incident #{h.exceptionId}
                    </IncidentRef>
                    <Link href={`/decisions?branch=${h.branchId}&period=${period.key}`} className="inline-flex min-h-6 items-center text-accent hover:underline">readiness</Link>
                  </span>
                </li>
              ))}
              {held.map((h) => (
                <li key={`${h.branchId}:${h.channelCode}:${h.code}`} className="grid grid-cols-[3.25rem_1fr] gap-x-3 gap-y-1 px-4 py-3 sm:grid-cols-[3.25rem_1fr_auto]" data-testid="evidence-hold" data-code={h.code}>
                  <Link href={`/branches/${h.branchId}?period=${period.key}`} className="font-semibold text-accent hover:underline">
                    {h.branchId}
                  </Link>
                  <div className="min-w-0">
                    <Badge tone="warn" dot>{h.code === "held" ? "Spend held at intake" : h.code === "no_spend" ? "No spend recorded" : "Cost counted at another branch"}</Badge>
                    <p className="mt-1 break-words leading-5 text-text">{h.summary}</p>
                  </div>
                  <span className="col-start-2 flex gap-3 text-xs sm:col-start-auto sm:flex-col sm:items-end sm:gap-0">
                    {h.href && (viewer.can.sync || viewer.can.approve) && (
                      <Link href={h.href} className="inline-flex min-h-6 items-center font-medium text-accent hover:underline">held records</Link>
                    )}
                    <Link href={`/decisions?branch=${h.branchId}&period=${period.key}`} className="inline-flex min-h-6 items-center text-accent hover:underline">readiness</Link>
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
        <Card className="xl:col-span-2" title="New customers serviced, by week" subtitle={`How their source is known · Sep–Oct${period.key === "oct" ? " (October in full colour)" : ""}`}>
          <Suspense fallback={<Skeleton lines={6} />}>
            <WeeksAsync weeks={weeksReady} periodKey={period.key} />
          </Suspense>
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
                    <Td align="right">
                      {money(paidCac(r.paidSpendCents, r.paidAcquired))}
                      {r.paidAcquired > 0 && !cacDefined(r.paidSpendCents, r.paidAcquired) && <div className="text-[11px] text-faint">no spend mapped here</div>}
                    </Td>
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

      <Suspense fallback={null}>
        <BrandsAsync brands={brandsReady} periodKey={period.key} />
      </Suspense>

      <Suspense fallback={<Card title="Data freshness" subtitle="Every number above is only as current as these feeds"><Skeleton lines={2} /></Card>}>
        <FreshnessAsync streams={streamsReady} />
      </Suspense>
    </div>
  );
}

/**
 * The six tiles: their values from this period's totals, their deltas once September arrives
 * (`pending` holds each delta's line meanwhile, so the cards below do not move).
 */
function StatTiles({ t, before, pending = false }: { t: Totals; before: Totals | null; pending?: boolean }) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
      <Stat deltaPending={pending} metric="paidSpend" value={money(t.paidSpendCents, true)} delta={delta(t.paidSpendCents, before?.paidSpendCents ?? null, null)} sub={t.unallocatedSpendCents > 0 ? `+ ${money(t.unallocatedSpendCents)} on unmapped campaigns` : "all spend mapped"} subTone={t.unallocatedSpendCents > 0 ? "bad" : "neutral"} />
      <Stat deltaPending={pending} metric="prospects" value={count(t.prospects)} delta={delta(t.prospects, before?.prospects ?? null, "up")} sub={`${count(t.rawLeads)} lead records`} />
      <Stat deltaPending={pending} metric="acquired" value={count(t.acquired)} delta={delta(t.acquired, before?.acquired ?? null, "up")} sub={`${count(t.paidAcquired)} from paid media`} />
      <Stat deltaPending={pending} metric="paidCac" value={money(t.paidCacCents)} delta={delta(t.paidCacCents, before?.paidCacCents ?? null, "down")} sub="period CAC, not cohort" />
      <Stat deltaPending={pending} metric="unknownShare" value={pct(t.unknownShare)} delta={delta(t.unknownShare, before?.unknownShare ?? null, "down", "pts")} sub={`${count(t.unknownAcquired)} customers`} />
      <Stat deltaPending={pending} metric="newCollected" value={money(t.newCustomerCollectedCents, true)} delta={delta(t.newCustomerCollectedCents, before?.newCustomerCollectedCents ?? null, "up")} sub={`${money(t.newCustomerAcvCents, true)} booked annual value (not revenue)`} />
    </div>
  );
}

async function StatTilesAsync({ t, before }: { t: Totals; before: Promise<Totals | null> }) {
  return <StatTiles t={t} before={await before} />;
}

async function WeeksAsync({ weeks, periodKey }: { weeks: ReturnType<typeof weeklySeries>; periodKey: string }) {
  return <StackedWeeks points={await weeks} label="New customers serviced per week, by source: paid media, unknown, other" highlightFrom={periodKey === "oct" ? "2026-09-28" : undefined} />;
}

async function BrandsAsync({ brands, periodKey }: { brands: Promise<Awaited<ReturnType<typeof brandRows>>>; periodKey: string }) {
  const lines = await brands;
  if (lines.length <= 1) return null;
  return (
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
          {lines.map((b) => (
            <tr key={b.brandId}>
              <Td className="whitespace-nowrap">
                <Link className="font-medium text-accent hover:underline" href={`/?brand=${b.brandId}&period=${periodKey}`}>
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
  );
}

async function FreshnessAsync({ streams }: { streams: ReturnType<typeof freshness> }) {
  const feeds = await streams;
  return (
    <Card title="Data freshness" subtitle="Every number above is only as current as these feeds" action={<Link href="/integrations" className="text-xs font-medium text-accent hover:underline">Integration runs</Link>}>
      <ul className="grid grid-cols-1 gap-2 sm:grid-cols-3 lg:grid-cols-5">
        {feeds.map((f) => (
          <li key={f.stream} className="rounded-md border border-border px-3 py-2 text-xs">
            <div className="flex items-center justify-between gap-2">
              <span className="truncate font-mono text-[11px] text-text">{f.stream}</span>
              <Badge dot tone={f.lastRunStatus === "succeeded" ? "good" : "bad"}>{f.lastRunStatus ?? "never"}</Badge>
            </div>
            <div className="mt-1 text-muted">last success {dateTime(f.lastSuccessAt)}</div>
            {f.quarantined > 0 && <div className="mt-0.5 font-medium text-bad">{f.quarantined} quarantined in source</div>}
          </li>
        ))}
      </ul>
    </Card>
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
