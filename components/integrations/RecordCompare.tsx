"use client";

import { useState } from "react";
import { Badge, TableWrap, Td, Th } from "@/components/ui";
import { fmtTime } from "@/lib/connectors/views";

interface CompareView {
  entity: string;
  recordId: number;
  officeId: number | null;
  branchId: string | null;
  source: { found: boolean; payload: Record<string, unknown> | null; error: string | null };
  mapped: { ok: boolean; error: string | null; mapperVersion: string };
  fields: Array<{ column: string; mapped: string | null; stored: string | null; match: boolean }>;
  versions: Array<{ rawEventId: number; externalId: string; status: string; errorCode: string | null; receivedAt: string; deliveryCount: number; live: boolean }>;
  verdict: "in_sync" | "differs" | "missing_downstream" | "missing_at_source" | "unmappable";
}

const VERDICT: Record<CompareView["verdict"], { tone: "good" | "warn" | "bad"; text: string }> = {
  in_sync: { tone: "good", text: "In sync: the stored row is exactly what the deployed mapper makes of the source record." },
  differs: { tone: "warn", text: "Differs: the source has a version the projection does not reflect yet — sync this office, or look for a quarantined version." },
  missing_downstream: { tone: "warn", text: "Not stored: the source has it, the projection does not. It has not been synced, or every version was quarantined." },
  missing_at_source: { tone: "bad", text: "Not at the source: the source did not return it (deleted, merged, out of the key's office, or an error)." },
  unmappable: { tone: "bad", text: "Unmappable: the deployed mapper rejects the source record; ingestion would quarantine it." },
};

/**
 * One record, source vs destination. The source side is fetched through the connector client
 * (real HTTP against the mock) and redacted exactly as the pipeline redacts; the destination is
 * the projection row and every raw version received.
 */
export function RecordCompare({ connectorId, offices, entities }: { connectorId: number; offices: Array<{ officeId: number; label: string }>; entities: readonly string[] }) {
  const [entity, setEntity] = useState(entities[0] ?? "customer");
  const [recordId, setRecordId] = useState("");
  const [office, setOffice] = useState("auto");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<CompareView | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const qs = new URLSearchParams({ entity, recordId: recordId.trim() });
      if (office !== "auto") qs.set("officeId", office);
      const res = await fetch(`/api/connectors/${connectorId}/compare?${qs}`, { cache: "no-store" });
      const body = await res.json();
      if (!res.ok) throw new Error(body.issues?.join("; ") ?? body.error ?? `HTTP ${res.status}`);
      setResult(body as CompareView);
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const select = "rounded border border-border bg-surface px-2 py-1";
  return (
    <div className="space-y-3 text-sm" data-testid="record-compare">
      <form onSubmit={submit} className="flex flex-wrap items-end gap-2">
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Entity</span>
          <select value={entity} onChange={(e) => setEntity(e.target.value)} className={select}>
            {entities.map((x) => <option key={x} value={x}>{x}</option>)}
          </select>
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Record id</span>
          <input required inputMode="numeric" pattern="[0-9]+" value={recordId} onChange={(e) => setRecordId(e.target.value)} className={`${select} w-32`} placeholder="e.g. a customerID" />
        </label>
        <label className="flex flex-col gap-1">
          <span className="text-xs text-muted">Office</span>
          <select value={office} onChange={(e) => setOffice(e.target.value)} className={select}>
            <option value="auto">From the stored row</option>
            {offices.map((o) => <option key={o.officeId} value={o.officeId}>{o.label}</option>)}
          </select>
        </label>
        <button type="submit" disabled={busy || !recordId.trim()} className="rounded border border-border px-3 py-1.5 hover:bg-surface-2 disabled:opacity-50">
          {busy ? "Fetching…" : "Compare"}
        </button>
      </form>
      {error && <p role="alert" className="text-xs text-bad">{error}</p>}
      {result && (
        <div className="space-y-3" aria-live="polite">
          <p className="flex flex-wrap items-center gap-2">
            <Badge tone={VERDICT[result.verdict].tone}>{result.verdict.replace(/_/g, " ")}</Badge>
            <span className="text-xs text-muted">
              {result.entity} {result.recordId} · office {result.officeId} ({result.branchId}) · mapper crm@{result.mapped.mapperVersion}
            </span>
          </p>
          <p className="text-xs text-muted">{VERDICT[result.verdict].text}</p>
          {result.source.error && <p className="text-xs text-bad">Source: {result.source.error}</p>}
          {result.mapped.error && <p className="text-xs text-bad">Mapper: {result.mapped.error}</p>}
          {result.fields.length > 0 && (
            <TableWrap>
              <thead><tr><Th>Column</Th><Th>Source → mapper</Th><Th>Stored</Th><Th>Match</Th></tr></thead>
              <tbody>
                {result.fields.map((f) => (
                  <tr key={f.column}>
                    <Td className="font-mono text-xs">{f.column}</Td>
                    <Td className="break-all font-mono text-xs">{f.mapped ?? "null"}</Td>
                    <Td className={`break-all font-mono text-xs ${f.match ? "" : "text-warn"}`}>{f.stored ?? "null"}</Td>
                    <Td>{f.match ? <Badge tone="good">same</Badge> : <Badge tone="warn">differs</Badge>}</Td>
                  </tr>
                ))}
              </tbody>
            </TableWrap>
          )}
          {result.source.payload && (
            <details className="rounded border border-border">
              <summary className="px-3 py-2 text-xs text-muted">Source record (redacted wire payload)</summary>
              <pre className="overflow-x-auto bg-surface-2 p-3 text-[11px]">{JSON.stringify(result.source.payload, null, 2)}</pre>
            </details>
          )}
          <div>
            <p className="mb-1 text-xs font-medium text-muted">Raw versions received ({result.versions.length})</p>
            {result.versions.length === 0 ? (
              <p className="text-xs text-faint">None — this record has never been delivered.</p>
            ) : (
              <ul className="space-y-1 text-xs">
                {result.versions.map((v) => (
                  <li key={v.rawEventId} className="flex flex-wrap items-center gap-2">
                    <span className="font-mono">#{v.rawEventId}</span>
                    <span className="font-mono text-muted">{v.externalId}</span>
                    <Badge tone={v.status === "quarantined" ? "bad" : v.live ? "good" : "neutral"}>{v.live ? "live" : v.status}</Badge>
                    {v.errorCode && <span className="text-bad">{v.errorCode}</span>}
                    <span className="text-faint">received {fmtTime(v.receivedAt)} · {v.deliveryCount}× delivered</span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
