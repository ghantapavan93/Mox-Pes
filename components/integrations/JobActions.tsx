"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";

/**
 * Cancel / retry for one job, and live refresh of the job page while it is queued or running.
 * The server re-checks permission, scope and state; these buttons only exist for viewers with
 * the sync permission.
 */
export function JobActions({ jobId, state, canAct }: { jobId: number; state: string; canAct: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string; retryId?: number } | null>(null);
  const active = state === "queued" || state === "running";

  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => router.refresh(), 2_000);
    return () => clearInterval(timer);
  }, [active, router]);

  async function act(action: "cancel" | "retry") {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/connectors/jobs/${jobId}`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(action === "cancel" ? { action } : { action, idempotencyKey: crypto.randomUUID() }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setMessage(
        action === "cancel"
          ? { ok: true, text: body.state === "cancelled" ? "Cancelled before it ran." : "Cancel requested: the worker stops after the batch in flight." }
          : { ok: true, text: `Queued as job #${body.jobId}.`, retryId: body.jobId },
      );
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="flex flex-wrap items-center gap-3 text-sm">
      {active && <span className="text-xs text-muted" aria-live="polite">Refreshing every 2 s while {state}.</span>}
      {canAct && active && (
        <button type="button" disabled={busy} onClick={() => void act("cancel")} className="rounded border border-border px-3 py-1.5 hover:bg-surface-2 disabled:opacity-50">
          {busy ? "Working…" : "Cancel job"}
        </button>
      )}
      {canAct && (state === "failed" || state === "cancelled") && (
        <button type="button" disabled={busy} onClick={() => void act("retry")} className="rounded bg-accent px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50">
          {busy ? "Working…" : "Retry as a new job"}
        </button>
      )}
      {!canAct && <span className="text-xs text-faint">Cancel and retry require the sync permission.</span>}
      {message && (
        <p role="status" className={`text-xs ${message.ok ? "text-good" : "text-bad"}`}>
          {message.text}{" "}
          {message.retryId && <Link href={`/integrations/jobs/${message.retryId}`} className="text-accent hover:underline">Open #{message.retryId}</Link>}
        </p>
      )}
    </div>
  );
}
