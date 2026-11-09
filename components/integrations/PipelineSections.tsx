import Link from "next/link";
import { Badge, Card, KV, TableWrap, Td, Th } from "@/components/ui";
import { ACTIVE_VERSION } from "@/lib/adapters/registry";
import type { Queryable } from "@/lib/db";
import { count, dateTime, money } from "@/lib/format";
import { auditTrail, failedRunsWithRecovery, listExceptions, recentRuns, replayHistory, streamTotals } from "@/lib/queries";

/**
 * The ingestion pipeline view that predates the Studio: the raw event log, quarantine groups,
 * failed-run recovery, recent runs, replays and the audit log. Unchanged in substance; it now
 * lives below the connector sections because connector syncs write into the same log.
 */
export async function PipelineSections({ db }: { db: Queryable }) {
  const [totals, runs, failures, replays, audit, quarantines] = await Promise.all([
    streamTotals(db),
    recentRuns(db, 27),
    failedRunsWithRecovery(db),
    replayHistory(db),
    auditTrail(db),
    listExceptions(db, { branchIds: null, kind: "quarantined_source_records", status: undefined }),
  ]);
  const deliveries = totals.reduce((a, t) => a + Number(t.deliveries), 0);
  const events = totals.reduce((a, t) => a + Number(t.events), 0);

  return (
    <div className="space-y-6">
      <div className="grid gap-6 lg:grid-cols-3">
        <Card title="Raw event log" subtitle="Deliveries vs. distinct record versions">
          <KV
            items={[
              ["Deliveries received", count(deliveries)],
              ["Distinct record versions", count(events)],
              ["Duplicate deliveries absorbed", count(deliveries - events)],
              ["Deployed mappers", Object.entries(ACTIVE_VERSION).map(([s, v]) => `${s}@${v}`).join(" · ")],
            ]}
          />
          <TableWrap>
            <thead><tr><Th>Source</Th><Th align="right">Versions</Th><Th align="right">Deliveries</Th><Th align="right">Quarantined</Th></tr></thead>
            <tbody>
              {totals.map((t) => (
                <tr key={t.source}>
                  <Td className="font-mono text-xs">{t.source}</Td>
                  <Td align="right">{count(Number(t.events))}</Td>
                  <Td align="right">{count(Number(t.deliveries))}</Td>
                  <Td align="right">{Number(t.quarantined) > 0 ? <span className="text-bad">{count(Number(t.quarantined))}</span> : 0}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        </Card>

        <Card className="lg:col-span-2" title="Quarantine groups" subtitle="Grouped by source, error and branch">
          {quarantines.length === 0 ? (
            <p className="text-sm text-muted">Nothing quarantined.</p>
          ) : (
            <ul className="space-y-2">
              {quarantines.map((q) => (
                <li key={q.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border p-3 text-sm">
                  <div>
                    <Link href={`/exceptions/${q.id}`} className="font-medium text-accent hover:underline">{q.summary}</Link>
                    <div className="text-xs text-muted">{String(q.evidence.sampleError ?? "")}</div>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-xs tabular-nums text-muted">{money(q.amountCents)}</span>
                    <Badge tone={q.status === "open" ? "bad" : "good"}>{q.status}</Badge>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>

      <Card title="Failed runs and how they recovered" subtitle="A failed run never advances its cursor, so the next run re-reads the missed window">
        {failures.length === 0 ? (
          <p className="text-sm text-muted">No failed runs.</p>
        ) : (
          <TableWrap>
            <thead><tr><Th>Run</Th><Th>Stream</Th><Th>When</Th><Th>Error</Th><Th>Recovered by</Th></tr></thead>
            <tbody>
              {failures.map((f) => (
                <tr key={f.id}>
                  <Td className="font-mono text-xs">#{f.id}</Td>
                  <Td className="font-mono text-xs">{f.stream}</Td>
                  <Td className="text-xs">{dateTime(f.started_at)}</Td>
                  <Td className="text-xs text-bad">{f.error}</Td>
                  <Td className="text-xs">{f.recovered_by ? <>run #{f.recovered_by}, window from {dateTime(f.recovery_window_start)}</> : <Badge tone="bad">not yet</Badge>}</Td>
                </tr>
              ))}
            </tbody>
          </TableWrap>
        )}
      </Card>

      <Card title="Latest scheduled ingestion runs" subtitle="One run per stream per day in the simulation; each is one transaction">
        <TableWrap>
          <thead>
            <tr><Th>Run</Th><Th>Stream</Th><Th>Mapper</Th><Th>Window</Th><Th align="right">Fetched</Th><Th align="right">New</Th><Th align="right">Dupes</Th><Th align="right">Quarantined</Th><Th>Status</Th></tr>
          </thead>
          <tbody>
            {runs.map((r) => (
              <tr key={r.id}>
                <Td className="font-mono text-xs">#{r.id}</Td>
                <Td className="font-mono text-xs">{r.stream}</Td>
                <Td className="font-mono text-xs">{r.adapter_version}</Td>
                <Td className="text-xs">{dateTime(r.window_start)} → {dateTime(r.window_end)}</Td>
                <Td align="right">{count(r.fetched)}</Td>
                <Td align="right">{count(r.inserted)}</Td>
                <Td align="right">{count(r.duplicates)}</Td>
                <Td align="right">{r.quarantined > 0 ? <span className="text-bad">{r.quarantined}</span> : 0}</Td>
                <Td><Badge tone={r.status === "succeeded" ? "good" : "bad"}>{r.status}</Badge></Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      </Card>

      <div className="grid gap-6 lg:grid-cols-2">
        <Card title="Replays" subtitle="Each keyed by an idempotency key; repeats return the stored result">
          {replays.length === 0 ? (
            <p className="text-sm text-muted">No replays yet.</p>
          ) : (
            <TableWrap>
              <thead><tr><Th>Key</Th><Th>Mapper</Th><Th>By</Th><Th align="right">Claimed</Th><Th align="right">Projected</Th></tr></thead>
              <tbody>
                {replays.map((r) => (
                  <tr key={r.id}>
                    <Td className="font-mono text-[11px]">{String(r.idempotency_key).slice(0, 13)}…</Td>
                    <Td className="font-mono text-xs">{r.adapter_version}</Td>
                    <Td className="text-xs">{r.actor}</Td>
                    <Td align="right">{r.claimed}</Td>
                    <Td align="right">{r.projected}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
        </Card>
        <Card title="Audit log" subtitle="Every replay, decision, sync request and job transition: who, what, why">
          {audit.length === 0 ? (
            <p className="text-sm text-muted">No decisions recorded yet.</p>
          ) : (
            <ul className="space-y-2 text-sm" data-testid="audit-log">
              {audit.map((a) => (
                <li key={a.id} className="border-b border-dashed border-border pb-2">
                  <span className="font-medium">{a.actor}</span> · <span className="font-mono text-xs">{a.action}</span> · {a.subject}
                  <div className="text-xs text-muted">{dateTime(a.at)} · {JSON.stringify(a.detail)}</div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      </div>
    </div>
  );
}
