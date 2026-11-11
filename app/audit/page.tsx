import Link from "next/link";
import { Suspense } from "react";
import { CaseStateBadge, ProposalStatusBadge, SourceBadge } from "@/components/actions/badges";
import { ConnectorCard } from "@/components/integrations/StudioSections";
import { Badge, Callout, Card, EmptyState, FilterChips, Forbidden, KV, KpiTile, PageHeader, SectionNav, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { connectorSummaries } from "@/lib/connectors/studio";
import { consumerHealth, recentEvents } from "@/lib/events/health";
import { count, date, dateTime } from "@/lib/format";
import { feedAttention } from "@/lib/health/feeds";
import { freshness } from "@/lib/metrics/scorecard";
import { failedRunsWithRecovery } from "@/lib/queries";
import { businessNow, getPool, getViewer } from "@/lib/server";
import { auditFacets, auditFeedPage, ingestionHealth, parseAuditCursor, throughput, type AuditFilters } from "@/lib/workflow/queries";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

const FILTER_KEYS = ["actor", "action", "subject", "from", "to"] as const;
const AUDIT_PAGE_SIZE = 25;

/** "2026-10-31" → that UTC day's start; anything else → null (reported, not guessed). */
function parseDay(value: string | undefined): Date | null | "invalid" {
  if (!value) return null;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return "invalid";
  const d = new Date(`${value}T00:00:00Z`);
  return Number.isNaN(d.getTime()) ? "invalid" : d;
}

export default function AuditPage({ searchParams }: { searchParams: SearchParams }) {
  return (
    <div className="space-y-6">
      <PageHeader
        eyebrow="Systems · company-wide"
        title="Audit & Health"
        description={
          <p className="max-w-3xl">
            Who changed what, and whether the pipes are healthy: the audit trail behind every decision and execution, Action Center throughput, feed freshness,
            ingestion runs, domain events and the CRM connector. Synthetic data; times are the demo&apos;s business clock (UTC).
          </p>
        }
      />
      <Suspense fallback={<Skeleton lines={12} />}>
        <AuditAndHealth searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

/**
 * One page, two jobs, in the order people ask: "is anything broken?" (the health strip, linking to
 * the section that explains it), then "who did what?" (the filterable audit trail), then the detail
 * behind each health number. Filters and the keyset cursor live in the URL.
 */
async function AuditAndHealth({ searchParams }: { searchParams: SearchParams }) {
  const viewer = await getViewer();
  if (viewer.branchIds) {
    return <Forbidden message="The audit log and system health span every branch, so they are limited to company-wide roles." />;
  }
  const sp = await searchParams;
  const from = parseDay(one(sp.from));
  const to = parseDay(one(sp.to));
  const filters: AuditFilters = {
    actor: one(sp.actor),
    action: one(sp.action),
    subject: one(sp.subject),
    from: from instanceof Date ? from : undefined,
    // inclusive "to" day: everything before the next day's start
    to: to instanceof Date ? new Date(to.getTime() + 86_400_000) : undefined,
    // A page of the trail, not all of it: the health detail below must stay reachable. Older
    // entries are one keyset step away.
    limit: AUDIT_PAGE_SIZE,
    // Keyset cursor "<at>|<id>" from the previous page; a malformed one starts at the newest row.
    before: parseAuditCursor(one(sp.before)) ? one(sp.before) : undefined,
  };
  const pool = getPool();
  const now = await businessNow();
  const [facets, { rows: feed, next }, flow, streams, runs, failures, connectors, consumers, events] = await Promise.all([
    auditFacets(pool),
    auditFeedPage(pool, filters),
    throughput(pool, now),
    freshness(pool),
    ingestionHealth(pool),
    failedRunsWithRecovery(pool),
    // Company-wide roles only reach this point, so the connector health is unscoped.
    connectorSummaries(pool, null, now, new Date()),
    consumerHealth(pool),
    recentEvents(pool),
  ]);
  const filtered = Boolean(filters.actor || filters.action || filters.subject || filters.from || filters.to);
  /** The current filters as a query string, with one filter or the cursor patched in or out. */
  const feedHref = (patch: Partial<Record<(typeof FILTER_KEYS)[number] | "before", string | undefined>>) => {
    const q = new URLSearchParams();
    for (const key of FILTER_KEYS) {
      const v = key in patch ? patch[key] : one(sp[key]);
      if (v) q.set(key, v);
    }
    if (patch.before) q.set("before", patch.before);
    const qs = q.toString();
    return `${qs ? `/audit?${qs}` : "/audit"}#audit-trail`;
  };
  const chips = FILTER_KEYS.flatMap((key) => {
    const v = one(sp[key]);
    return v
      ? [
          {
            label: (
              <>
                {key[0].toUpperCase() + key.slice(1)}: {v}
              </>
            ),
            removeHref: feedHref({ [key]: undefined }),
          },
        ]
      : [];
  });

  const feeds = feedAttention(streams, now);
  const attention = new Set([...feeds.stale, ...feeds.failing].map((s) => s.stream));
  const unrecovered = failures.filter((f) => !f.recovered_by).length;
  const behind = consumers.reduce((n, c) => n + c.uncovered, 0);
  const consumerErrors = consumers.filter((c) => c.lastError).length;
  const crm = connectors[0]?.health;

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 gap-3 lg:grid-cols-4" data-testid="health-kpis">
        <KpiTile
          label="Feeds"
          value={feeds.ok ? "All fresh" : `${count(attention.size)} need attention`}
          sub={`${count(streams.length - attention.size)} of ${count(streams.length)} succeeded within 36 hours`}
          tone={feeds.ok ? "good" : "warn"}
          href="#feeds"
        />
        <KpiTile
          label="Failed ingestion runs"
          value={count(failures.length)}
          sub={unrecovered === 0 ? "All recovered by a later run" : `${count(unrecovered)} not yet recovered`}
          tone={unrecovered > 0 ? "bad" : failures.length > 0 ? "good" : "neutral"}
          href="#feeds"
        />
        <KpiTile
          label="Domain events not yet handled"
          value={count(behind)}
          sub={
            consumerErrors > 0
              ? `${count(consumerErrors)} consumer${consumerErrors === 1 ? "" : "s"} failing`
              : `${count(consumers.length)} consumers, none failing`
          }
          tone={consumerErrors > 0 ? "bad" : behind > 0 ? "warn" : "good"}
          href="#events"
        />
        <KpiTile
          label="CRM connector"
          value={crm ? crm.status : "none"}
          sub={
            crm
              ? `${count(crm.jobs.failed)} failed jobs · ${crm.rateLimit.count > 0 ? `${count(crm.rateLimit.count)} rate-limited calls` : "never rate-limited"}`
              : "No connector configured"
          }
          tone={!crm ? "neutral" : crm.status === "healthy" ? "good" : crm.status === "failing" ? "bad" : crm.status === "degraded" ? "warn" : "neutral"}
          href="#connector"
        />
      </div>

      <SectionNav
        label="Audit and health sections"
        testId="audit-sections"
        items={[
          ["#audit-trail", "Audit trail"],
          ["#throughput", "Action Center"],
          ["#feeds", "Feeds & runs"],
          ["#events", "Domain events"],
          ["#connector", "CRM connector"],
        ]}
      />

      <Card
        id="audit-trail"
        className="scroll-mt-28"
        title={`Audit trail (${count(feed.length)}${next ? "+" : ""} shown of ${count(facets.total)}${filters.before ? ", older entries" : ""})`}
        subtitle="Newest first. Every case transition, proposal decision, execution and legacy decision writes one row. Select a subject to see its whole history."
        flush
      >
        <form
          method="get"
          action="/audit#audit-trail"
          aria-label="Filter the audit log"
          className="grid grid-cols-2 items-end gap-3 border-b border-border bg-surface-2/60 px-4 py-3 sm:grid-cols-3 lg:grid-cols-[repeat(5,minmax(0,1fr))_auto]"
        >
          <Field label="Actor">
            <select name="actor" defaultValue={filters.actor ?? ""} className={INPUT}>
              <option value="">Anyone</option>
              {facets.actors.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Action">
            <select name="action" defaultValue={filters.action ?? ""} className={INPUT}>
              <option value="">Any</option>
              {facets.actions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Subject (exact, or type: for all)">
            <input name="subject" defaultValue={filters.subject ?? ""} placeholder="case:12, campaign:" className={INPUT} />
          </Field>
          <Field label="From (UTC day)">
            <input type="date" name="from" defaultValue={one(sp.from) ?? ""} className={INPUT} />
          </Field>
          <Field label="To (UTC day)">
            <input type="date" name="to" defaultValue={one(sp.to) ?? ""} className={INPUT} />
          </Field>
          <div className="flex items-center gap-3">
            <button type="submit" className="h-8 rounded-md bg-accent px-3 text-sm font-medium text-white hover:bg-accent-hover">
              Apply
            </button>
            {filtered && (
              <Link href="/audit#audit-trail" className="text-sm text-accent hover:underline">
                Clear
              </Link>
            )}
          </div>
        </form>
        {chips.length > 0 && (
          <div className="border-b border-border px-4 py-2">
            <FilterChips items={chips} clearHref="/audit#audit-trail" testId="audit-filters" />
          </div>
        )}
        {(from === "invalid" || to === "invalid") && (
          <div className="px-4 pt-3">
            <p role="alert" className="text-xs text-bad">
              Dates must be YYYY-MM-DD; the invalid one was ignored.
            </p>
          </div>
        )}
        {feed.length === 0 ? (
          <div className="p-4">
            <EmptyState title={filtered ? "No audit rows match these filters." : "The audit log is empty."}>
              {filtered && "Remove a filter, or widen the dates."}
            </EmptyState>
          </div>
        ) : (
          <>
            {/* Below md: one card per entry (the table is display:none there, so each entry is read once). */}
            <ul className="divide-y divide-border md:hidden" data-testid="audit-feed-cards">
              {feed.map((a) => (
                <li key={a.id} className="space-y-1 px-4 py-3 text-xs">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-3">
                    <span className="font-mono font-medium text-text">{a.action}</span>
                    <span className="text-muted">{dateTime(a.at)}</span>
                  </div>
                  <div className="text-muted">
                    {a.actor} · <SubjectLink subject={a.subject} />
                  </div>
                  <details className="group">
                    <summary className="min-h-6 truncate py-1 font-mono text-[11px] text-muted group-open:text-accent">{JSON.stringify(a.detail)}</summary>
                    <pre role="region" aria-label="Audit detail" tabIndex={0} className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 font-mono text-[11px] leading-4 text-text [overflow-wrap:anywhere]">
                      {JSON.stringify(a.detail, null, 2)}
                    </pre>
                  </details>
                </li>
              ))}
            </ul>
            <div className="hidden md:block">
              <TableWrap label="Audit trail" flush minWidth={860}>
                <thead>
                  <tr>
                    <Th>When</Th>
                    <Th>Actor</Th>
                    <Th>Action</Th>
                    <Th>Subject</Th>
                    <Th>Detail</Th>
                  </tr>
                </thead>
                <tbody data-testid="audit-feed">
                  {feed.map((a) => {
                    const detail = JSON.stringify(a.detail);
                    return (
                      <tr key={a.id}>
                        <Td className="whitespace-nowrap text-xs">{dateTime(a.at)}</Td>
                        <Td className="text-xs">{a.actor}</Td>
                        <Td className="font-mono text-xs">{a.action}</Td>
                        <Td className="font-mono text-xs">
                          <SubjectLink subject={a.subject} />
                        </Td>
                        <Td>
                          {/* One line by default; open it for the whole payload, formatted and wrapped. */}
                          <details className="group max-w-md">
                            <summary className="block truncate font-mono text-[11px] text-muted group-open:text-accent" title="Show the full detail">
                              {detail}
                            </summary>
                            <pre role="region" aria-label="Audit detail" tabIndex={0} className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded bg-surface-2 p-2 font-mono text-[11px] leading-4 text-text [overflow-wrap:anywhere]">
                              {JSON.stringify(a.detail, null, 2)}
                            </pre>
                          </details>
                        </Td>
                      </tr>
                    );
                  })}
                </tbody>
              </TableWrap>
            </div>
          </>
        )}
        {(next || filters.before) && (
          <nav aria-label="Audit log pages" className="flex flex-wrap items-center justify-between gap-2 px-4 py-3 text-xs" data-testid="audit-pagination">
            {filters.before ? (
              <Link href={feedHref({})} className="rounded-md border border-border bg-surface px-2.5 py-1 font-medium text-accent hover:bg-surface-2">
                ← Newest entries
              </Link>
            ) : (
              <span />
            )}
            {next ? (
              <Link
                href={feedHref({ before: next })}
                className="rounded-md border border-border bg-surface px-2.5 py-1 font-medium text-accent hover:bg-surface-2"
              >
                Older entries →
              </Link>
            ) : (
              <span className="text-faint">End of the audit log for these filters.</span>
            )}
          </nav>
        )}
      </Card>

      <div id="throughput" className="grid scroll-mt-28 gap-6 lg:grid-cols-3">
        <Card title="Action Center throughput" subtitle="Cases and proposals, all time">
          <div className="space-y-4 text-sm">
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted">Cases by state</p>
              {flow.casesByState.length === 0 ? (
                <p className="text-xs text-muted">No cases yet.</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {flow.casesByState.map((c) => (
                    <li key={c.state}>
                      <Link href={`/exceptions?state=${c.state}`} className="inline-flex items-center gap-1 text-xs hover:underline">
                        <CaseStateBadge state={c.state} /> <span className="tabular-nums">{count(c.n)}</span>
                      </Link>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-1.5 text-xs font-medium text-muted">Proposals by status and source</p>
              {flow.proposalsByStatus.length === 0 ? (
                <p className="text-xs text-muted">No proposals yet.</p>
              ) : (
                <ul className="space-y-1">
                  {flow.proposalsByStatus.map((p) => (
                    <li key={`${p.status}-${p.source}`} className="flex flex-wrap items-center gap-1.5 text-xs">
                      <ProposalStatusBadge status={p.status} /> <SourceBadge source={p.source} /> <span className="tabular-nums">{count(p.n)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <KV
              columns={1}
              items={[
                ["Executions succeeded", count(flow.executions.succeeded)],
                ["Executions failed (rolled back)", count(flow.executions.failed)],
                ["Case re-openings", count(flow.reopened)],
              ]}
            />
          </div>
        </Card>

        <Card className="lg:col-span-2" title="Daily flow" subtitle={`Last ${flow.daily.length} business days to ${date(now)} (UTC)`} flush>
          <TableWrap label="Daily flow" flush minWidth={480}>
            <thead>
              <tr>
                <Th>Day</Th>
                <Th align="right">Cases opened</Th>
                <Th align="right">Cases closed</Th>
                <Th align="right">Proposals</Th>
                <Th align="right">Executions</Th>
              </tr>
            </thead>
            <tbody>
              {flow.daily.map((d) => (
                <tr key={d.day}>
                  <Td className="text-xs">{date(d.day)}</Td>
                  <Td align="right">{count(d.casesOpened)}</Td>
                  <Td align="right">{count(d.casesClosed)}</Td>
                  <Td align="right">{count(d.proposals)}</Td>
                  <Td align="right">{count(d.executions)}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>
      </div>

      <div id="feeds" className="grid scroll-mt-28 gap-6 2xl:grid-cols-2">
        <Card
          title="Feed freshness"
          subtitle="Last run, last success and newest source event per feed. A feed needs attention when its last success is over 36 hours behind, or its last run failed."
          flush
        >
          {streams.length === 0 ? (
            <p className="p-4 text-sm text-muted">No ingestion runs recorded.</p>
          ) : (
            <TableWrap label="Feed freshness" flush minWidth={620}>
              <thead>
                <tr>
                  <Th>Feed</Th>
                  <Th>Last run</Th>
                  <Th>Last success</Th>
                  <Th>Newest event</Th>
                  <Th align="right">Quarantined</Th>
                </tr>
              </thead>
              <tbody data-testid="stream-freshness">
                {streams.map((s) => (
                  <tr key={s.stream}>
                    <Td className="font-mono text-xs">
                      {s.stream}
                      {attention.has(s.stream) && (
                        <div className="mt-0.5">
                          <Badge tone="warn">needs attention</Badge>
                        </div>
                      )}
                    </Td>
                    <Td className="text-xs">
                      {s.lastRunStatus && (
                        <Badge tone={s.lastRunStatus === "succeeded" ? "good" : s.lastRunStatus === "failed" ? "bad" : "warn"}>{s.lastRunStatus}</Badge>
                      )}{" "}
                      {dateTime(s.lastRunAt)}
                    </Td>
                    <Td className="text-xs">{dateTime(s.lastSuccessAt)}</Td>
                    <Td className="text-xs">{dateTime(s.latestEventAt)}</Td>
                    <Td align="right">{s.quarantined > 0 ? <span className="text-bad">{count(s.quarantined)}</span> : count(s.quarantined)}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>

        <Card title="Ingestion run health" subtitle="Runs per feed; a failed run never advances its cursor, so the next run re-reads the missed window" flush>
          {runs.length === 0 ? (
            <p className="p-4 text-sm text-muted">No ingestion runs recorded.</p>
          ) : (
            <TableWrap label="Ingestion run health" flush minWidth={640}>
              <thead>
                <tr>
                  <Th>Feed</Th>
                  <Th align="right">Runs</Th>
                  <Th align="right">Failed</Th>
                  <Th align="right">Fetched</Th>
                  <Th align="right">Quarantined</Th>
                  <Th>Last failure</Th>
                </tr>
              </thead>
              <tbody data-testid="ingestion-health">
                {runs.map((r) => {
                  const recovered = failures.filter((f) => f.stream === r.stream && f.recovered_by).length;
                  return (
                    <tr key={r.stream}>
                      <Td className="font-mono text-xs">{r.stream}</Td>
                      <Td align="right">{count(r.runs)}</Td>
                      <Td align="right">
                        {r.failed > 0 ? <span className="text-bad">{count(r.failed)}</span> : 0}
                        {r.failed > 0 && <div className="text-[11px] text-good">{count(recovered)} recovered</div>}
                      </Td>
                      <Td align="right">{count(r.fetched)}</Td>
                      <Td align="right">{count(r.quarantined)}</Td>
                      <Td className="text-xs">
                        {r.lastFailureAt ? (
                          <>
                            {dateTime(r.lastFailureAt)}
                            <div className="max-w-56 text-muted [overflow-wrap:anywhere]">{r.lastError}</div>
                          </>
                        ) : (
                          <span className="text-muted">none</span>
                        )}
                      </Td>
                    </tr>
                  );
                })}
              </tbody>
            </TableWrap>
          )}
        </Card>
      </div>

      <Card
        id="events"
        className="scroll-mt-28"
        title="Domain events"
        subtitle="Contexts publish facts in the same transaction as the change; reconciliation and identity catch up from them, and re-run only for changes their last run did not see."
      >
        {consumerErrors > 0 && (
          <div className="mb-4">
            <Callout tone="bad" title={`${count(consumerErrors)} consumer${consumerErrors === 1 ? " is" : "s are"} failing`}>
              Its error is shown in the table; events it has not handled stay in the outbox and are retried on the next dispatch.
            </Callout>
          </div>
        )}
        <div className="grid gap-6 xl:grid-cols-[minmax(0,3fr)_minmax(0,2fr)]">
          <TableWrap label="Domain event consumers" minWidth={560}>
            <thead>
              <tr>
                <Th>Consumer</Th>
                <Th align="right">Not yet seen</Th>
                <Th align="right">Runs</Th>
                <Th align="right">Delivered</Th>
                <Th>Last dispatch</Th>
              </tr>
            </thead>
            <tbody data-testid="event-consumers">
              {consumers.map((c) => (
                <tr key={c.consumer}>
                  <Td>
                    <div className="font-medium">{c.consumer}</div>
                    <div className="font-mono text-[10px] text-muted [overflow-wrap:anywhere]">{c.triggers.join(" · ")}</div>
                    {c.lastError && (
                      <div className="mt-1 text-xs text-bad">
                        Failing since {dateTime(c.lastErrorAt)}: {c.lastError}
                      </div>
                    )}
                  </Td>
                  <Td align="right">
                    {c.uncovered > 0 ? <Badge tone="warn">{count(c.uncovered)}</Badge> : count(0)}
                    {c.undelivered > c.uncovered && <div className="text-[10px] text-muted">{count(c.undelivered - c.uncovered)} seen, not yet marked</div>}
                  </Td>
                  <Td align="right">{count(c.runs)}</Td>
                  <Td align="right">{count(c.eventsHandled)}</Td>
                  <Td className="text-xs">{c.lastRunAt ? dateTime(c.lastRunAt) : "never"}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <div className="min-w-0">
            <h3 className="mb-1 text-xs font-medium text-muted">Latest events</h3>
            <ul className="divide-y divide-border text-xs" data-testid="recent-events">
              {events.length === 0 && <li className="py-2 text-muted">No events published yet.</li>}
              {events.map((e) => (
                <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
                  <span className="font-mono [overflow-wrap:anywhere]">{e.type}</span>
                  {e.subject && <SubjectLink subject={e.subject} />}
                  <span className="ml-auto whitespace-nowrap text-muted">{dateTime(e.occurredAt)}</span>
                </li>
              ))}
            </ul>
          </div>
        </div>
      </Card>

      <section id="connector" aria-labelledby="connector-health-heading" className="scroll-mt-28 space-y-3" data-testid="connector-health">
        <h2 id="connector-health-heading" className="text-[13px] font-semibold text-text">
          CRM connector health
        </h2>
        {connectors.length === 0 ? (
          <EmptyState title="No CRM connector is configured." />
        ) : (
          connectors.map((summary) => (
            <ConnectorCard
              key={summary.connector.id}
              summary={summary}
              controls={
                <Link href="/integrations" className="text-sm text-accent hover:underline">
                  Run a sync, inject faults and open job traces in Integrations →
                </Link>
              }
            />
          ))
        )}
      </section>
    </div>
  );
}

const INPUT = "h-8 w-full min-w-0 rounded-md border border-border-strong bg-surface px-2 text-sm text-text";

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-[11px] font-medium text-muted">{label}</span>
      {children}
    </label>
  );
}

/** Case and exception subjects link to their pages; everything else filters the trail to that subject. */
function SubjectLink({ subject }: { subject: string }) {
  const exception = subject.match(/^exception:(\d+)$/);
  if (exception) {
    return (
      <Link href={`/exceptions/${exception[1]}`} className="text-accent hover:underline">
        {subject}
      </Link>
    );
  }
  return (
    <Link href={`/audit?subject=${encodeURIComponent(subject)}#audit-trail`} className="[overflow-wrap:anywhere] hover:underline">
      {subject}
    </Link>
  );
}
