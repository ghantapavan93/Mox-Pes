"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { JOBS_CHANGED_EVENT } from "@/lib/connectors/views";

/**
 * Starts a sync. The request only QUEUES jobs (one per office × entity); the server runs them
 * after responding, and the live jobs table shows progress. Each click is a new request key;
 * a double-submit of the same click cannot queue twice.
 */
export function RunSync({
  connectorId,
  offices,
  entities,
}: {
  connectorId: number;
  offices: Array<{ officeId: number; label: string }>;
  entities: readonly string[];
}) {
  const router = useRouter();
  const [office, setOffice] = useState<string>("all");
  const [entity, setEntity] = useState<string>("all");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/connectors/${connectorId}/sync`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          officeIds: office === "all" ? undefined : [Number(office)],
          entities: entity === "all" ? undefined : [entity],
          idempotencyKey: crypto.randomUUID(),
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      const parts = [`Queued ${body.created} job${body.created === 1 ? "" : "s"}`];
      if (body.reusedQueued > 0) parts.push(`${body.reusedQueued} already waiting in the queue`);
      setMessage({ ok: true, text: `${parts.join("; ")}. Running in the background.` });
      window.dispatchEvent(new Event(JOBS_CHANGED_EVENT));
      router.refresh();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="flex flex-wrap items-end gap-2 text-sm" data-testid="run-sync">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">Offices</span>
        <select value={office} onChange={(e) => setOffice(e.target.value)} className="rounded border border-border bg-surface px-2 py-1">
          <option value="all">All {offices.length} offices</option>
          {offices.map((o) => (
            <option key={o.officeId} value={o.officeId}>{o.label}</option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">Entities</span>
        <select value={entity} onChange={(e) => setEntity(e.target.value)} className="rounded border border-border bg-surface px-2 py-1">
          <option value="all">All {entities.length} entities</option>
          {entities.map((x) => (
            <option key={x} value={x}>{x}</option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={busy} className="rounded bg-accent px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50">
        {busy ? "Queueing…" : "Run sync"}
      </button>
      {message && (
        <p role="status" className={`basis-full text-xs ${message.ok ? "text-good" : "text-bad"}`}>{message.text}</p>
      )}
    </form>
  );
}
