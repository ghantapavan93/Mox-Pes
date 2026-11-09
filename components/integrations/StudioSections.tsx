import Link from "next/link";
import type { ReactNode } from "react";
import { Badge, Card, KV, TableWrap, Td, Th } from "@/components/ui";
import { count, dateTime } from "@/lib/format";
import type { FieldSpec } from "@/lib/connectors/fieldroutes-mapping";
import type { ConnectorSummary, HealthStatus, OfficeRow } from "@/lib/connectors/studio";
import { fmtDuration, jobTone } from "@/lib/connectors/views";

/** Server-rendered Studio sections. Every number comes from the read models in lib/connectors/studio.ts. */

/** A single-column fact list: KV's two columns are too tight inside a three-column card. */
function Facts({ items }: { items: Array<[string, ReactNode]> }) {
  return (
    <dl className="space-y-1 text-sm">
      {items.map(([k, v]) => (
        <div key={k} className="flex justify-between gap-3 border-b border-dashed border-border pb-1">
          <dt className="text-muted">{k}</dt>
          <dd className="text-right font-medium tabular-nums">{v}</dd>
        </div>
      ))}
    </dl>
  );
}

const HEALTH_TONE: Record<HealthStatus, "good" | "warn" | "bad" | "neutral"> = { healthy: "good", degraded: "warn", failing: "bad", idle: "neutral" };

export function ConnectorCard({ summary, controls }: { summary: ConnectorSummary; controls: ReactNode }) {
  const { connector: c, health: h, credentialSources: cred } = summary;
  return (
    <Card
      title={
        <span className="flex flex-wrap items-center gap-2">
          {c.displayName}
          <Badge tone={HEALTH_TONE[h.status]}>{h.status}</Badge>
          {c.synthetic && <Badge tone="accent">synthetic</Badge>}
          {!c.enabled && <Badge tone="bad">disabled</Badge>}
        </span>
      }
      subtitle={<span className="font-mono">{c.slug} · {c.baseUrl}</span>}
    >
      <div className="space-y-4">
        <p className="text-sm text-muted" data-testid="connector-health-reason">{h.reason}</p>
        <div className="grid gap-x-6 gap-y-4 lg:grid-cols-3">
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Activity</h3>
            <Facts
              items={[
                ["Last success", dateTime(h.lastSuccessAt)],
                ["Queued / running", `${count(h.jobs.queued)} / ${count(h.jobs.running)}`],
                ["Backing off", count(h.jobs.retrying)],
                ["Succeeded / failed", `${count(h.jobs.succeeded)} / ${count(h.jobs.failed)}`],
              ]}
            />
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">Records</h3>
            <Facts
              items={[
                ["Read", count(h.records.read)],
                ["Changed (new versions)", count(h.records.changed)],
                ["Duplicates absorbed", count(h.records.duplicates)],
                ["Quarantined", h.records.quarantined > 0 ? <span className="text-bad">{count(h.records.quarantined)}</span> : 0],
                ["Rejected (wrong office)", h.records.rejected > 0 ? <span className="text-bad">{count(h.records.rejected)}</span> : 0],
              ]}
            />
          </div>
          <div>
            <h3 className="mb-2 text-xs font-semibold uppercase tracking-wide text-faint">API and freshness</h3>
            <Facts
              items={[
                ["API calls / errors", <>{count(h.apiCalls.total)} / {h.apiCalls.errors > 0 ? <span className="text-bad">{count(h.apiCalls.errors)}</span> : 0}</>],
                ["Rate limited (429s)", h.rateLimit.count > 0 ? <span className="text-warn">{count(h.rateLimit.count)}, last {dateTime(h.rateLimit.last429At)}</span> : "never"],
                ["Next rate-limit retry", dateTime(h.rateLimit.nextRetryAt)],
                ["Streams checkpointed", `${count(h.freshness.streamsWithCheckpoint)} of ${count(h.freshness.streams)}`],
                ["Oldest checkpoint lag", fmtDuration(h.freshness.worstLagMs)],
              ]}
            />
          </div>
        </div>
        {h.apiCalls.lastError && (
          <p className="text-xs text-bad">Last API error ({dateTime(h.apiCalls.lastErrorAt)}): {h.apiCalls.lastError}</p>
        )}
        <details className="text-xs text-muted">
          <summary className="text-accent">Connection settings (no secrets)</summary>
          <div className="mt-2">
            <KV
              items={[
                ["Base URL source", c.baseUrlSource === "env" ? `env ${c.baseUrlEnv}` : `connector row${c.baseUrlEnv ? ` (override with ${c.baseUrlEnv})` : ""}`],
                ["Credentials", `env ${c.keyEnvTemplate} / ${c.tokenEnvTemplate}`],
                ["Offices on env keys / demo keys / missing", `${count(cred.env)} / ${count(cred.demo)} / ${count(cred.missing)}`],
                ["Timeout", `${count(c.timeoutMs)} ms`],
                ["Wire time zone", c.wireTimeZone === "office" ? "each office's zone (mapper assumption)" : c.wireTimeZone],
                ["First window", `${count(c.initialLookbackHours)} h back`],
                ["Max attempts", count(c.maxAttempts)],
                ["Writes", "not implemented (read-only client)"],
              ]}
            />
          </div>
        </details>
        {controls}
      </div>
    </Card>
  );
}

export function OfficeGrid({ rows, entities }: { rows: OfficeRow[]; entities: readonly string[] }) {
  if (rows.length === 0) return <p className="text-sm text-muted">No offices in your scope.</p>;
  return (
    // Own scroll box (both axes): TableWrap's negative margin would be clipped inside it.
    <div className="max-h-[30rem] overflow-auto rounded border border-border">
      <table className="w-full min-w-[760px] border-collapse">
        <thead className="sticky top-0 bg-surface">
          <tr>
            <Th>Office</Th>
            <Th>Key</Th>
            {entities.map((e) => <Th key={e}>{e}</Th>)}
          </tr>
        </thead>
        <tbody>
          {rows.map((o) => (
            <tr key={o.officeId}>
              <Td className="whitespace-nowrap text-xs">
                <span className="font-medium">{o.branchId}</span> {o.branchName} <span className="font-mono text-faint">· {o.officeId}</span>
              </Td>
              <Td>
                <Badge tone={o.credentialSource === "missing" ? "bad" : o.credentialSource === "env" ? "good" : "neutral"}>{o.credentialSource}</Badge>
              </Td>
              {o.streams.map((s) => (
                <Td key={s.entity} className="whitespace-nowrap text-xs">
                  {s.latestJob ? (
                    <Link
                      href={`/integrations/jobs/${s.latestJob.id}`}
                      className="hover:underline"
                      aria-label={`${o.branchId} ${s.entity}: latest job ${s.latestJob.id} ${s.latestJob.state}`}
                      title={s.latestJob.lastError ?? undefined}
                    >
                      <Badge tone={jobTone(s.latestJob.state, s.latestJob.state === "queued" && s.latestJob.lastErrorKind !== null)}>{s.latestJob.state}</Badge>
                    </Link>
                  ) : (
                    <span className="text-faint">not synced</span>
                  )}
                  <div className="mt-0.5 text-[11px] text-faint">
                    {s.cursorAt ? `cursor ${dateTime(s.cursorAt)} · lag ${fmtDuration(s.lagMs)}` : "no checkpoint"}
                  </div>
                </Td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

const EVIDENCE_TONE = { documented: "good", inferred: "warn", deviation: "bad" } as const;

export function MappingInspector({ spec, entities }: { spec: FieldSpec[]; entities: readonly string[] }) {
  return (
    <div className="space-y-2">
      {entities.map((entity, i) => {
        const rows = spec.filter((s) => s.entity === entity);
        const deviations = rows.filter((r) => r.evidence === "deviation").length;
        return (
          <details key={entity} open={i === 0} className="rounded border border-border">
            <summary className="flex flex-wrap items-center gap-2 px-3 py-2 text-sm">
              <span className="font-mono font-medium">{entity}</span>
              <span className="text-xs text-muted">{rows.length} fields</span>
              {deviations > 0 && <Badge tone="bad">{deviations} doc deviation{deviations === 1 ? "" : "s"}</Badge>}
            </summary>
            <div className="px-4 pb-3">
              <TableWrap>
                <thead><tr><Th>FieldRoutes field</Th><Th>Canonical destination</Th><Th>Transform</Th><Th>Rule</Th><Th>Evidence</Th></tr></thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.field}>
                      <Td className="font-mono text-xs">{r.field}</Td>
                      <Td className="font-mono text-xs">{r.target}</Td>
                      <Td className="text-xs">{r.transform}</Td>
                      <Td className="text-xs">{r.rule}</Td>
                      <Td className="text-xs">
                        <Badge tone={EVIDENCE_TONE[r.evidence]}>{r.evidence}</Badge>
                        {r.deviation && <p className="mt-1 text-muted">{r.deviation}</p>}
                      </Td>
                    </tr>
                  ))}
                </tbody>
              </TableWrap>
            </div>
          </details>
        );
      })}
    </div>
  );
}

export function MapperVersions({ deployed, available, usage }: { deployed: string; available: string[]; usage: Array<{ adapterVersion: string; events: number; quarantined: number }> }) {
  return (
    <div className="space-y-3">
      <Facts items={[["Deployed CRM mapper", `crm@${deployed}`], ["Versions shipped", available.map((v) => `crm@${v}`).join(" · ")]]} />
      {usage.length === 0 ? (
        <p className="text-sm text-muted">No CRM records stored yet.</p>
      ) : (
        <TableWrap>
          <thead><tr><Th>Mapped by</Th><Th align="right">Stored versions</Th><Th align="right">Quarantined</Th></tr></thead>
          <tbody>
            {usage.map((u) => (
              <tr key={u.adapterVersion}>
                <Td className="font-mono text-xs">{u.adapterVersion}</Td>
                <Td align="right">{count(u.events)}</Td>
                <Td align="right">{u.quarantined > 0 ? <span className="text-bad">{count(u.quarantined)}</span> : 0}</Td>
              </tr>
            ))}
          </tbody>
        </TableWrap>
      )}
      <p className="text-xs text-faint">Connector syncs and the scheduled pipeline write through the same mapper and the same raw event log.</p>
    </div>
  );
}
