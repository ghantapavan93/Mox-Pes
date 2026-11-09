import Link from "next/link";
import { Suspense } from "react";
import { CaseStateBadge, ProposalStatusBadge, SourceBadge } from "@/components/actions/badges";
import { ConnectorCard } from "@/components/integrations/StudioSections";
import { Badge, Card, Forbidden, KV, Skeleton, TableWrap, Td, Th } from "@/components/ui";
import { connectorSummaries } from "@/lib/connectors/studio";
import { consumerHealth, recentEvents } from "@/lib/events/health";
import { count, date, dateTime } from "@/lib/format";
import { freshness } from "@/lib/metrics/scorecard";
import { failedRunsWithRecovery } from "@/lib/queries";
import { businessNow, getPool, getViewer } from "@/lib/server";
import { auditFacets, auditFeed, ingestionHealth, throughput, type AuditFilters } from "@/lib/workflow/queries";

type SearchParams = Promise<Record<string, string | string[] | undefined>>;
const one = (v: string | string[] | undefined) => (Array.isArray(v) ? v[0] : v)?.trim() || undefined;

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
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Audit &amp; Health</h1>
        <p className="mt-1 max-w-3xl text-sm text-muted">
          Who changed what, and whether the pipes are healthy: the audit log behind every decision and execution, Action Center throughput,
          stream freshness and ingestion runs. Synthetic data; times are the demo&apos;s business clock (UTC).
        </p>
      </div>
      <Suspense fallback={<Skeleton lines={12} />}>
        <AuditAndHealth searchParams={searchParams} />
      </Suspense>
    </div>
  );
}

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
    limit: 100,
  };
  const pool = getPool();
  const now = await businessNow();
  const [facets, feed, flow, streams, runs, failures, connectors, consumers, events] = await Promise.all([
    auditFacets(pool),
    auditFeed(pool, filters),
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

  return (
    <div className="space-y-6">
      <Card
        title={`Audit log (${count(feed.length)}${feed.length === filters.limit ? "+" : ""} shown of ${count(facets.total)})`}
        subtitle="Newest first. Every case transition, proposal decision, execution and legacy decision writes one row."
      >
        <form method="get" action="/audit" className="mb-3 flex flex-wrap items-end gap-2 text-xs" aria-label="Filter the audit log">
          <Field label="Actor">
            <select name="actor" defaultValue={filters.actor ?? ""} className="rounded border border-border bg-surface px-1.5 py-1">
              <option value="">Anyone</option>
              {facets.actors.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Action">
            <select name="action" defaultValue={filters.action ?? ""} className="rounded border border-border bg-surface px-1.5 py-1">
              <option value="">Any</option>
              {facets.actions.map((a) => (
                <option key={a} value={a}>
                  {a}
                </option>
              ))}
            </select>
          </Field>
          <Field label="Subject starts with">
            <input name="subject" defaultValue={filters.subject ?? ""} placeholder="case:12, campaign:" className="w-36 rounded border border-border bg-surface px-1.5 py-1" />
          </Field>
          <Field label="From (UTC day)">
            <input type="date" name="from" defaultValue={one(sp.from) ?? ""} className="rounded border border-border bg-surface px-1.5 py-1" />
          </Field>
          <Field label="To (UTC day)">
            <input type="date" name="to" defaultValue={one(sp.to) ?? ""} className="rounded border border-border bg-surface px-1.5 py-1" />
          </Field>
          <button type="submit" className="rounded bg-text px-2.5 py-1 font-medium text-white">
            Apply
          </button>
          {filtered && (
            <Link href="/audit" className="py-1 text-accent hover:underline">
              Clear
            </Link>
          )}
        </form>
        {(from === "invalid" || to === "invalid") && (
          <p role="alert" className="mb-2 text-xs text-bad">
            Dates must be YYYY-MM-DD; the invalid one was ignored.
          </p>
        )}
        {feed.length === 0 ? (
          <p className="text-sm text-muted">{filtered ? "No audit rows match these filters." : "The audit log is empty."}</p>
        ) : (
          <TableWrap>
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
              {feed.map((a) => (
                <tr key={a.id}>
                  <Td className="whitespace-nowrap text-xs">{dateTime(a.at)}</Td>
                  <Td className="text-xs">{a.actor}</Td>
                  <Td className="font-mono text-xs">{a.action}</Td>
                  <Td className="font-mono text-xs">
                    <SubjectLink subject={a.subject} />
                  </Td>
                  <Td>
                    <code className="block max-w-md truncate text-[11px] text-muted" title={JSON.stringify(a.detail)}>
                      {JSON.stringify(a.detail)}
                    </code>
                  </Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Action Center throughput" subtitle="Cases and proposals, all time">
          <div className="space-y-3 text-sm">
            <div>
              <p className="mb-1 text-xs text-muted">Cases by state</p>
              {flow.casesByState.length === 0 ? (
                <p className="text-xs text-faint">No cases yet.</p>
              ) : (
                <ul className="flex flex-wrap gap-1.5">
                  {flow.casesByState.map((c) => (
                    <li key={c.state} className="flex items-center gap-1 text-xs">
                      <CaseStateBadge state={c.state} /> <span className="tabular-nums">{count(c.n)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <div>
              <p className="mb-1 text-xs text-muted">Proposals by status and source</p>
              {flow.proposalsByStatus.length === 0 ? (
                <p className="text-xs text-faint">No proposals yet.</p>
              ) : (
                <ul className="space-y-1">
                  {flow.proposalsByStatus.map((p) => (
                    <li key={`${p.status}-${p.source}`} className="flex items-center gap-1.5 text-xs">
                      <ProposalStatusBadge status={p.status} /> <SourceBadge source={p.source} /> <span className="tabular-nums">{count(p.n)}</span>
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <KV
              items={[
                ["Executions succeeded", count(flow.executions.succeeded)],
                ["Executions failed (rolled back)", count(flow.executions.failed)],
                ["Case re-openings", count(flow.reopened)],
              ]}
            />
          </div>
        </Card>

        <Card className="lg:col-span-2" title="Daily flow" subtitle={`Last ${flow.daily.length} business days to ${date(now)} (UTC)`}>
          <TableWrap>
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

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Stream freshness" subtitle="Last run, last success and newest source event per stream">
          {streams.length === 0 ? (
            <p className="text-sm text-muted">No ingestion runs recorded.</p>
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th>Stream</Th>
                  <Th>Last run</Th>
                  <Th>Last success</Th>
                  <Th>Newest event</Th>
                  <Th align="right">Quarantined</Th>
                </tr>
              </thead>
              <tbody data-testid="stream-freshness">
                {streams.map((s) => (
                  <tr key={s.stream}>
                    <Td className="font-mono text-xs">{s.stream}</Td>
                    <Td className="text-xs">
                      {s.lastRunStatus && <Badge tone={s.lastRunStatus === "succeeded" ? "good" : s.lastRunStatus === "failed" ? "bad" : "warn"}>{s.lastRunStatus}</Badge>}{" "}
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

        <Card title="Ingestion run health" subtitle="Runs per stream; a failed run is retried by the next run's window">
          {runs.length === 0 ? (
            <p className="text-sm text-muted">No ingestion runs recorded.</p>
          ) : (
            <TableWrap>
              <thead>
                <tr>
                  <Th>Stream</Th>
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
                            <div className="max-w-48 truncate text-faint" title={r.lastError ?? undefined}>
                              {r.lastError}
                            </div>
                          </>
                        ) : (
                          <span className="text-faint">none</span>
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
        title="Domain events"
        subtitle="Contexts publish facts in the same transaction as the change; reconciliation and identity catch up from them, and re-run only for changes their last run did not see."
      >
        <div className="grid gap-6 lg:grid-cols-2">
          <TableWrap>
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
                    <div className="font-mono text-[10px] text-faint">{c.triggers.join(" · ")}</div>
                    {c.lastError && <div className="mt-1 text-xs text-bad">Failing since {dateTime(c.lastErrorAt)}: {c.lastError}</div>}
                  </Td>
                  <Td align="right">
                    {c.uncovered > 0 ? <Badge tone="warn">{count(c.uncovered)}</Badge> : count(0)}
                    {c.undelivered > c.uncovered && <div className="text-[10px] text-faint">{count(c.undelivered - c.uncovered)} seen, not yet marked</div>}
                  </Td>
                  <Td align="right">{count(c.runs)}</Td>
                  <Td align="right">{count(c.eventsHandled)}</Td>
                  <Td>{c.lastRunAt ? dateTime(c.lastRunAt) : "never"}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
          <ul className="divide-y divide-border text-xs" data-testid="recent-events">
            {events.length === 0 && <li className="py-2 text-muted">No events published yet.</li>}
            {events.map((e) => (
              <li key={e.id} className="flex flex-wrap items-baseline gap-x-3 py-1.5">
                <span className="font-mono">{e.type}</span>
                {e.subject && <SubjectLink subject={e.subject} />}
                <span className="ml-auto text-faint">{dateTime(e.occurredAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      </Card>

      <section aria-labelledby="connector-health-heading" className="space-y-3" data-testid="connector-health">
        <h2 id="connector-health-heading" className="text-sm font-semibold">
          Connector health
        </h2>
        {connectors.length === 0 ? (
          <p className="text-sm text-muted">No CRM connector is configured.</p>
        ) : (
          connectors.map((summary) => (
            <ConnectorCard
              key={summary.connector.id}
              summary={summary}
              controls={
                <Link href="/integrations" className="text-sm text-accent hover:underline">
                  Run a sync, inject faults and open job traces in the Integration Studio →
                </Link>
              }
            />
          ))
        )}
      </section>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-[10px] uppercase tracking-wide text-faint">{label}</span>
      {children}
    </label>
  );
}

/** Case and exception subjects link to their pages; everything else is plain text. */
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
    <Link href={`/audit?subject=${encodeURIComponent(subject)}`} className="hover:underline">
      {subject}
    </Link>
  );
}
