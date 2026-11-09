import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { BudgetSignalCard } from "@/components/BudgetSignalCard";
import { ExceptionTable } from "@/components/ExceptionTable";
import { WeeklyBars } from "@/components/WeeklyBars";
import { Card, Forbidden, PeriodTabs, Skeleton, Stat, TableWrap, Td, Th } from "@/components/ui";
import { count, money, pct } from "@/lib/format";
import { budgetSignal } from "@/lib/metrics/decision";
import { branchRows, channelRows, totals } from "@/lib/metrics/scorecard";
import { parsePeriod } from "@/lib/period";
import { listExceptions, weeklySeries } from "@/lib/queries";
import { BRANCH_BY_ID } from "@/lib/reference";
import { getPool, getViewer } from "@/lib/server";
import { ForbiddenError, resolveScope } from "@/lib/viewer";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export default function BranchPage(props: Props) {
  return (
    <Suspense fallback={<Skeleton lines={10} />}>
      <Branch {...props} />
    </Suspense>
  );
}

async function Branch({ params, searchParams }: Props) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const branch = BRANCH_BY_ID.get(id);
  if (!branch) notFound();
  const period = parsePeriod(sp.period);
  const viewer = await getViewer();
  let branchIds: string[] | null;
  try {
    branchIds = resolveScope(viewer, id);
  } catch (error) {
    if (error instanceof ForbiddenError) return <Forbidden message={error.message} />;
    throw error;
  }
  const pool = getPool();
  const scope = { from: period.from, to: period.to, branchIds };
  const companyScope = { from: period.from, to: period.to, branchIds: null };

  const [rows, channels, weeks, exceptions, company, signal] = await Promise.all([
    branchRows(pool, scope),
    channelRows(pool, scope),
    weeklySeries(pool, branchIds),
    listExceptions(pool, { branchIds, status: "open" }),
    viewer.branchIds ? Promise.resolve(null) : totals(pool, companyScope),
    budgetSignal(pool, branch.id, { from: period.from, to: period.to }),
  ]);
  const t = await totals(pool, scope, rows);
  const companyUnknown = company?.unknownShare ?? null;

  return (
    <div className="space-y-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <p className="text-xs text-faint">
            <Link href={`/?period=${period.key}`} className="hover:underline">Overview</Link> / Branch
          </p>
          <h1 className="mt-1 text-2xl font-semibold tracking-tight">
            {branch.id} {branch.name} <span className="text-base font-normal text-muted">· {branch.region} · {branch.timezone}</span>
          </h1>
          <p className="mt-1 text-sm text-muted">Which part of the acquisition-to-revenue path deserves investigation?</p>
          <p className="mt-2 flex flex-wrap gap-3 text-xs">
            <Link href={`/decisions?branch=${branch.id}&period=${period.key}`} className="text-accent hover:underline">Decision readiness →</Link>
            <Link href={`/exceptions?branch=${branch.id}`} className="text-accent hover:underline">Incidents →</Link>
            {viewer.can.investigate && (
              <Link href={`/investigator?branch=${branch.id}`} className="text-accent hover:underline">Investigate this branch →</Link>
            )}
          </p>
        </div>
        <PeriodTabs current={period.key} base={`/branches/${branch.id}`} />
      </div>

      <div className="grid grid-cols-2 gap-3 md:grid-cols-3 xl:grid-cols-6">
        <Stat metric="paidSpend" value={money(t.paidSpendCents, true)} />
        <Stat metric="prospects" value={count(t.prospects)} sub={`${count(t.paidProspects)} paid`} />
        <Stat metric="acquired" value={count(t.acquired)} sub={`${count(t.sold)} sold in period`} />
        <Stat metric="paidCac" value={money(t.paidCacCents)} sub={company ? `company ${money(company.paidCacCents)}` : undefined} tone={company?.paidCacCents && t.paidCacCents && t.paidCacCents > company.paidCacCents * 1.4 ? "bad" : "neutral"} />
        <Stat metric="unknownShare" value={pct(t.unknownShare)} sub={companyUnknown !== null ? `company ${pct(companyUnknown)}` : undefined} tone={companyUnknown && t.unknownShare && t.unknownShare > companyUnknown * 1.6 ? "bad" : "neutral"} />
        <Stat metric="atRisk" value={money(t.atRiskCents)} sub={`${count(t.openExceptions)} open exceptions`} tone={t.openExceptions > 0 ? "bad" : "good"} />
      </div>

      <Card title="Weekly trend" subtitle="New customers by week of initial service. Spend by week of spend.">
        <div className="grid gap-6 md:grid-cols-2">
          <WeeklyBars points={weeks} label="Paid-media CAC" value={(p) => (p.paidAcquired > 0 ? p.spendCents / p.paidAcquired : null)} format={(v) => money(Math.round(v))} reference={company?.paidCacCents ? { value: company.paidCacCents, label: "company CAC" } : undefined} />
          <WeeklyBars points={weeks} label="Unattributed share of new customers" value={(p) => (p.acquired > 0 ? p.unknownAcquired / p.acquired : null)} format={(v) => pct(v)} reference={companyUnknown !== null ? { value: companyUnknown, label: "company share" } : undefined} />
        </div>
      </Card>

      <BudgetSignalCard signal={signal} periodLabel={period.label} periodKey={period.key} />

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Channels" subtitle="Acquisitions credited by first evidenced touch">
          <TableWrap>
            <thead>
              <tr>
                <Th>Channel</Th>
                <Th align="right">Spend</Th>
                <Th align="right">Prospects</Th>
                <Th align="right">New cust.</Th>
                <Th align="right">CAC</Th>
                <Th align="right">Collected</Th>
              </tr>
            </thead>
            <tbody>
              {channels.map((c) => (
                <tr key={c.channelCode} className={c.channelCode === "unknown" ? "bg-surface-2" : ""}>
                  <Td>
                    {c.label}
                    {c.costBasis === "commission" && <div className="text-[11px] text-faint">cost is rep commission — not in paid CAC</div>}
                  </Td>
                  <Td align="right">{c.costBasis === "media" ? money(c.spendCents, true) : "—"}</Td>
                  <Td align="right">{count(c.prospects)}</Td>
                  <Td align="right">{count(c.acquired)}</Td>
                  <Td align="right">{money(c.cacCents)}</Td>
                  <Td align="right">{money(c.revenueFromAcquiredCents, true)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>
        <Card title="Open exceptions" subtitle="Where the records stop agreeing">
          <ExceptionTable rows={exceptions.slice(0, 15)} empty="No open exceptions for this branch." />
          {exceptions.length > 15 && (
            <p className="mt-3 text-xs"><Link className="text-accent hover:underline" href={`/exceptions?branch=${branch.id}`}>All {exceptions.length} →</Link></p>
          )}
        </Card>
      </div>
    </div>
  );
}
