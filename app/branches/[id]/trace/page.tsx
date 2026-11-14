import Link from "next/link";
import { notFound } from "next/navigation";
import { Suspense } from "react";
import { Badge, ButtonLink, Callout, Card, Forbidden, KV, PageHeader, PeriodTabs, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { count, dateTime, money } from "@/lib/format";
import { CashTraceView } from "@/components/trace/CashTraceView";
import { OverviewSelection } from "@/components/trace/OverviewSelection";
import { parseChannel, parseWeek, selectionEvidence } from "@/lib/metrics/movement";
import { traceCash, type CashTrace } from "@/lib/lineage/cash";
import { compareTraces, exactDollars, traceBranchMetric, TRACEABLE, type MetricTrace, type TraceableMetric } from "@/lib/lineage/trace";
import { PERIODS, parsePeriod, type Period } from "@/lib/period";
import { BRAND_BY_ID, BRANCH_BY_ID, type Branch, type BrandId } from "@/lib/reference";
import { getPool, getViewer } from "@/lib/server";
import { ForbiddenError, type Viewer } from "@/lib/viewer";

type Props = { params: Promise<{ id: string }>; searchParams: Promise<Record<string, string | string[] | undefined>> };

export const metadata = { title: "Number trace" };

/**
 * /branches/[id]/trace — where a branch's paid-media CAC (or spend) comes from. The page shows
 * the number, the same number reproduced from the records below it, the definition and its
 * version, every contributing campaign and customer, what the definition leaves out, what the
 * number cannot see, and what changed since the comparison period. All of it is read from
 * lib/lineage/trace.ts; nothing here computes a financial figure.
 */
export default function TracePage(props: Props) {
  return (
    <Suspense fallback={<Skeleton lines={12} />}>
      <Trace {...props} />
    </Suspense>
  );
}

async function Trace({ params, searchParams }: Props) {
  const [{ id }, sp] = await Promise.all([params, searchParams]);
  const branch = BRANCH_BY_ID.get(id);
  if (!branch) notFound();
  const period = parsePeriod(sp.period);
  const viewer = await getViewer();
  const pool = getPool();
  if (sp.metric === "collected") return <CashTracePage branch={branch} period={period} viewer={viewer} />;
  const metric: TraceableMetric = typeof sp.metric === "string" && (TRACEABLE as readonly string[]).includes(sp.metric) ? (sp.metric as TraceableMetric) : "paid_cac";
  let trace: MetricTrace;
  let previous: MetricTrace | null = null;
  try {
    trace = await traceBranchMetric(pool, viewer, { branchId: branch.id, period, metric });
    if (period.key === "oct") previous = await traceBranchMetric(pool, viewer, { branchId: branch.id, period: PERIODS.sep, metric });
  } catch (error) {
    if (error instanceof ForbiddenError) return <Forbidden message={error.message} />;
    throw error;
  }
  const diff = previous ? compareTraces(previous, trace) : null;
  // Arrived from one point of the Overview's "What changed" chart: that point's records, and the
  // way back to the same selection. The branch passed the scope check above.
  const channel = parseChannel(sp.channel);
  const week = parseWeek(sp.week);
  const brandParam = typeof sp.brand === "string" && BRAND_BY_ID.has(sp.brand as BrandId) ? sp.brand : null;
  const selection = channel && week && metric === "paid_spend" ? await selectionEvidence(pool, { branchId: branch.id, channel, week }) : null;
  const overviewHref = `/?period=${period.key}${brandParam ? `&brand=${brandParam}` : ""}${selection ? `&branch=${branch.id}&channel=${channel}&week=${week}#movement` : ""}`;
  const v = trace.value;
  const isCac = metric === "paid_cac";
  const headline = isCac ? money(v.scorecard.paidCacCents) : money(v.scorecard.paidSpendCents);
  const question = `Why is ${trace.metric.label.toLowerCase()} ${headline} for ${branch.id} in ${period.label}?`;

  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ href: overviewHref, label: "Overview" }, { href: `/branches/${branch.id}?period=${period.key}`, label: `${branch.id} ${branch.name}` }, { label: "Trace" }]}
        eyebrow={`Trace · ${branch.id} ${branch.name} · ${period.label}`}
        title={`Where does ${headline} come from?`}
        description={`${trace.metric.label}: ${trace.metric.formula}. Every row below is a stored record you can open; the number is recomputed from them and checked against the scorecard.`}
        actions={
          <div className="flex flex-wrap gap-2">
            <ButtonLink href={`/investigator?branch=${branch.id}&q=${encodeURIComponent(question)}`} variant="primary" testId="trace-investigate">Investigate this number</ButtonLink>
            <ButtonLink href="/changes">Preview a mapping change</ButtonLink>
          </div>
        }
      />
      {selection && (
        <OverviewSelection
          branchId={branch.id}
          channel={channel!}
          channelLabel={selection.channelLabel}
          week={week!}
          days={selection.days}
          markers={selection.markers}
          backHref={overviewHref}
          incidentQuery={`?period=${period.key}&channel=${channel}&week=${week}${brandParam ? `&brand=${brandParam}` : ""}`}
        />
      )}
      <PeriodTabs base={`/branches/${branch.id}/trace`} current={period.key} extra={`&metric=${metric}`} />

      {v.matches ? (
        <Callout tone="good" title="Reproduced from the records below" testId="trace-reproduced">
          {isCac
            ? `${exactDollars(v.reproduced.paidSpendCents)} of paid media spend ÷ ${count(v.reproduced.paidAcquired)} new paid customers = ${v.reproduced.paidCacCents === null ? "n/a" : exactDollars(v.reproduced.paidCacCents)} (rounded to the cent), the same as the scorecard: spend to the cent, customers exactly.`
            : `${exactDollars(v.reproduced.paidSpendCents)} of paid media spend, the same as the scorecard to the cent.`}
        </Callout>
      ) : (
        <Callout tone="bad" title="The records do not add up to the scorecard" testId="trace-discrepancy">
          <ul className="list-disc pl-5">{v.discrepancies.map((d) => <li key={d}>{d}</li>)}</ul>
        </Callout>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Definition" subtitle={`Version ${trace.metric.definitionVersion}`}>
          <KV
            columns={1}
            items={[
              ["Formula", trace.metric.formula],
              ["Scope", `${branch.id} ${branch.name} (${branch.brandId}), ${period.label}`],
              ["Caveat", trace.metric.caveat],
            ]}
          />
        </Card>
        <Card title="What the number cannot see" subtitle={trace.missing.length ? `${trace.missing.length} item(s)` : "Nothing found"}>
          {trace.missing.length === 0 ? (
            <p className="text-sm text-muted">No unmapped campaign with leads here, no open exception, no failing feed, no held record.</p>
          ) : (
            <ul className="space-y-2 text-sm" data-testid="trace-missing">
              {trace.missing.map((m, i) => (
                <li key={`${m.kind}-${i}`} className="flex flex-col gap-1 sm:flex-row sm:items-start sm:gap-2">
                  <span className="shrink-0"><Badge tone="warn">{m.kind.replace(/_/g, " ").replace(":", " · ")}</Badge></span>
                  <span className="min-w-0 sm:flex-1">{m.detail}</span>
                  <span className="flex shrink-0 flex-wrap gap-2">
                    {m.evidenceIds.slice(0, 2).map((e) => <EvidenceLink key={e} id={e} />)}
                    {m.kind === "unmapped_campaign" && m.evidenceIds[0] && (
                      <Link
                        className="text-xs font-medium text-accent hover:underline"
                        href={`/changes?campaign=${m.evidenceIds[0].split(":")[1]}&branch=${branch.id}`}
                        data-testid="trace-preview-mapping"
                      >
                        Preview mapping it to {branch.id}
                      </Link>
                    )}
                  </span>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Spend: campaigns mapped to this branch" subtitle={`${trace.numerator.campaigns.length} campaign(s) · ${money(trace.numerator.totalCents)}`}>
        <TableWrap label="Contributing campaigns" testId="trace-campaigns" minWidth={900}>
          <thead>
            <tr>
              <Th>Campaign</Th>
              <Th>Channel</Th>
              <Th align="right">Spend</Th>
              <Th align="right">Days</Th>
              <Th>Mapping</Th>
              <Th>Produced by</Th>
              <Th>Currency</Th>
            </tr>
          </thead>
          <tbody>
            {trace.numerator.campaigns.map((c) => (
              <tr key={`${c.campaignId}-${c.channelCode}`} className="border-t border-border align-top">
                <Td>
                  <span className="font-medium">{c.externalCampaignId}</span>
                  <span className="block text-xs text-muted">{c.name} · {c.platform}</span>
                </Td>
                <Td>{c.channelCode}</Td>
                <Td align="right">{money(c.spendCents)}</Td>
                <Td align="right">{c.spendDays} <span className="block text-xs text-muted">{c.firstDay} → {c.lastDay}</span></Td>
                <Td>
                  {c.mapping.branchId} <span className="block text-xs text-muted">by {c.mapping.mappedBy}, {dateTime(c.mapping.mappedAt)}</span>
                  {c.mapping.version !== null && (
                    <span className="block text-xs text-muted">
                      version {c.mapping.version}
                      {c.mapping.changeId !== null && <> · <Link className="text-accent hover:underline" href={`/changes/${c.mapping.changeId}`}>change {c.mapping.changeId}</Link></>}
                    </span>
                  )}
                </Td>
                <Td>
                  <span className="text-xs">{Object.entries(c.mapperVersions).map(([k, n]) => `${k} ×${n}`).join(", ")}</span>
                  <span className="block font-mono text-[11px] text-faint">{c.sampleRawEventIds.join(" ")}</span>
                </Td>
                <Td>
                  {c.assumedCurrencyCents > 0 ? (
                    <Badge tone="warn">{money(c.assumedCurrencyCents)} not established</Badge>
                  ) : c.ruleCurrencyCents > 0 ? (
                    <Badge tone="neutral">{c.ruleCurrencyCents === c.spendCents ? "USD by account rule" : `${money(c.ruleCurrencyCents)} USD by account rule`}</Badge>
                  ) : (
                    <Badge tone="good">stated</Badge>
                  )}
                </Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Card>

      {isCac && (
        <Card title="Customers: new paid customers counted" subtitle={`${count(trace.denominator.count)} customer(s)${trace.denominator.truncated ? ", first 200 shown" : ""}`}>
          <CustomerTable customers={trace.denominator.customers.slice(0, 20)} label="Counted customers" testId="trace-customers" />
          {trace.denominator.customers.length > 20 && (
            <details className="mt-3">
              <summary className="cursor-pointer text-sm font-medium text-accent">Show the other {trace.denominator.customers.length - 20}</summary>
              <div className="mt-2">
                <CustomerTable customers={trace.denominator.customers.slice(20)} label="More counted customers" />
              </div>
            </details>
          )}
        </Card>
      )}

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Left out by the definition" subtitle={trace.excluded.length ? undefined : "Nothing"}>
          <ul className="space-y-2 text-sm" data-testid="trace-excluded">
            {trace.excluded.map((e) => (
              <li key={e.code}>
                <Badge>{count(e.count)} · {e.code}</Badge> <span className="text-muted">{e.reason}</span>{" "}
                {e.evidenceIds.slice(0, 3).map((x) => <EvidenceLink key={x} id={x} />)}
              </li>
            ))}
          </ul>
        </Card>
        <Card title="Records excluded or held at intake" subtitle={`${period.label}, this branch`}>
          {trace.sourceRecords.length === 0 ? (
            <p className="text-sm text-muted">None.</p>
          ) : (
            <ul className="space-y-2 text-sm" data-testid="trace-source-records">
              {trace.sourceRecords.map((r) => (
                <li key={`${r.source}-${r.status}-${r.code}`}>
                  <Badge tone={r.status === "quarantined" ? "warn" : "neutral"}>{r.status}</Badge> {count(r.count)} {r.source} · {r.code}
                  <span className="block font-mono text-[11px] text-faint">{r.sampleEvidenceIds.join(" ")}</span>
                </li>
              ))}
            </ul>
          )}
          <p className="mt-3 text-xs text-muted">Excluded: the source itself says the record is not counted (an outbound or spam call); it is kept as evidence. Held: the record could not be read and counts nowhere until it is fixed and replayed.</p>
        </Card>
      </div>

      {diff && (
        <Card title={`What changed since ${diff.before.period}`} subtitle={`Spend ${signed(diff.spendDeltaCents)} · paid customers ${diff.customersDelta >= 0 ? "+" : ""}${diff.customersDelta}`}>
          <TableWrap label="Changes by campaign" testId="trace-diff">
            <thead>
              <tr>
                <Th>Campaign</Th>
                <Th>Channel</Th>
                <Th align="right">{diff.before.period}</Th>
                <Th align="right">{diff.after.period}</Th>
                <Th align="right">Change</Th>
              </tr>
            </thead>
            <tbody>
              {diff.campaigns.slice(0, 20).map((c) => (
                <tr key={`${c.evidenceId}-${c.channelCode}`} className="border-t border-border">
                  <Td>{c.externalCampaignId} {c.status !== "changed" && <Badge tone="accent">{c.status}</Badge>}</Td>
                  <Td>{c.channelCode}</Td>
                  <Td align="right">{money(c.beforeCents)}</Td>
                  <Td align="right">{money(c.afterCents)}</Td>
                  <Td align="right">{signed(c.deltaCents)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <p className="mt-2 text-xs text-muted">
            {diff.before.period}: {money(diff.before.paidSpendCents)} ÷ {count(diff.before.paidAcquired)} = {money(diff.before.paidCacCents)}. {diff.after.period}: {money(diff.after.paidSpendCents)} ÷ {count(diff.after.paidAcquired)} = {money(diff.after.paidCacCents)}. A change in the number is not, by itself, a change in the business.
          </p>
        </Card>
      )}

      <Card title="Limitations">
        <ul className="list-disc space-y-1 pl-5 text-sm text-muted" data-testid="trace-limitations">
          {trace.limitations.map((l) => <li key={l}>{l}</li>)}
        </ul>
      </Card>
    </div>
  );
}

function CustomerTable({ customers, label, testId }: { customers: MetricTrace["denominator"]["customers"]; label: string; testId?: string }) {
  return (
    <TableWrap label={label} testId={testId} minWidth={760}>
      <thead>
        <tr>
          <Th>Customer</Th>
          <Th>First service completed</Th>
          <Th>Credited to</Th>
          <Th>Lead (evidence)</Th>
        </tr>
      </thead>
      <tbody>
        {customers.map((k) => (
          <tr key={k.crmCustomerId} className="border-t border-border">
            <Td><Link className="text-accent hover:underline" href={`/customers/${k.crmCustomerId}`}>CRM {k.crmCustomerId}</Link></Td>
            <Td>{dateTime(k.initialCompletedAt)}</Td>
            <Td>{k.channelCode}{k.campaignExternalId ? ` · ${k.campaignExternalId}` : ""}</Td>
            <Td><span className="font-mono text-[11px] text-muted">{[k.leadEvidenceId, k.leadRawEventId].filter(Boolean).join(" ← ")}</span></Td>
          </tr>
        ))}
      </tbody>
    </TableWrap>
  );
}

const signed = (cents: number) => `${cents >= 0 ? "+" : "−"}${money(Math.abs(cents))}`;

/** Opens the record behind an evidence id where the product has a page for it. */
/** Collected cash, its refunds and the payments behind it (lib/lineage/cash.ts). */
async function CashTracePage({ branch, period, viewer }: { branch: Branch; period: Period; viewer: Viewer }) {
  let trace: CashTrace;
  try {
    trace = await traceCash(getPool(), viewer, { branchId: branch.id, period });
  } catch (error) {
    if (error instanceof ForbiddenError) return <Forbidden message={error.message} />;
    throw error;
  }
  const question = `Why is collected cash ${exactDollars(trace.value.scorecard.collectedCents)} for ${branch.id} in ${period.label}?`;
  return (
    <div className="space-y-6">
      <PageHeader
        crumbs={[{ href: `/?period=${period.key}`, label: "Overview" }, { href: `/branches/${branch.id}?period=${period.key}`, label: `${branch.id} ${branch.name}` }, { label: "Cash trace" }]}
        eyebrow={`Trace · ${branch.id} ${branch.name} · ${period.label}`}
        title={`Where does ${exactDollars(trace.value.scorecard.collectedCents)} of collected cash come from?`}
        description="Successful payments minus refunds, each by its own payment date, in this branch's CRM office. Every record below is stored; the figure is recomputed from them and checked against the scorecard."
        actions={
          <ButtonLink href={`/investigator?branch=${branch.id}&q=${encodeURIComponent(question)}`} variant="primary" testId="trace-investigate">
            Investigate this number
          </ButtonLink>
        }
      />
      <PeriodTabs base={`/branches/${branch.id}/trace`} current={period.key} extra="&metric=collected" />
      <CashTraceView trace={trace} branchLabel={`${branch.id} ${branch.name}`} />
    </div>
  );
}

function EvidenceLink({ id }: { id: string }) {
  const [kind, key] = id.split(":");
  const href = kind === "customer" ? `/customers/${key}` : kind === "exception" ? `/exceptions/${key}` : null;
  return href ? (
    <Link href={href} className="font-mono text-[11px] text-accent hover:underline">{id}</Link>
  ) : (
    <span className="font-mono text-[11px] text-faint">{id}</span>
  );
}
