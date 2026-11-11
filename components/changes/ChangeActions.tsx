"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

type Action = { action: "preflight" } | { action: "release" } | { action: "monitor" } | { action: "decide"; decision: "approve" | "reject"; reason: string; configHash: string; preflightHash: string };

/**
 * The buttons for one change. Each posts to /api/changes/:id; the server re-checks permission,
 * scope, state and (for a decision) that the hashes shown here are the ones stored.
 */
export function ChangeActions({
  changeId,
  can,
  hashes,
}: {
  changeId: number;
  can: { preflight: boolean; decide: boolean; release: boolean; monitor: boolean; decideReason: string | null };
  hashes: { configHash: string; preflightHash: string | null };
}) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function send(label: string, body: Action) {
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch(`/api/changes/${changeId}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? (json.issues ? json.issues.join("; ") : `HTTP ${res.status}`));
      setMessage({ ok: true, text: `${label}: now ${json.change.status.replaceAll("_", " ")}` });
      setReason("");
      router.refresh();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const decide = (decision: "approve" | "reject") =>
    send(decision === "approve" ? "Approved" : "Rejected", { action: "decide", decision, reason, configHash: hashes.configHash, preflightHash: hashes.preflightHash ?? "" });

  return (
    <div className="space-y-3" data-testid="change-actions">
      {can.decide ? (
        <div className="space-y-2">
          <label htmlFor="decision-reason" className="block text-xs font-medium text-text">
            Your decision is bound to configuration <code className="text-[11px]">{hashes.configHash.slice(0, 12)}</code> and preflight{" "}
            <code className="text-[11px]">{hashes.preflightHash?.slice(0, 12)}</code>. Why?
          </label>
          <input id="decision-reason" value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} className="h-8 w-full rounded-md border border-border-strong bg-surface px-2 text-sm" placeholder="At least 10 characters" />
          <div className="flex gap-2">
            <button type="button" disabled={busy !== null} onClick={() => decide("approve")} className="h-8 rounded-md bg-text px-3 text-sm font-medium text-white disabled:opacity-50">
              Approve
            </button>
            <button type="button" disabled={busy !== null} onClick={() => decide("reject")} className="h-8 rounded-md border border-border-strong bg-surface px-3 text-sm font-medium disabled:opacity-50">
              Reject
            </button>
          </div>
        </div>
      ) : (
        can.decideReason && <p className="text-xs text-muted">{can.decideReason}</p>
      )}
      <div className="flex flex-wrap gap-2">
        {can.preflight && (
          <button type="button" disabled={busy !== null} onClick={() => send("Preflight re-run", { action: "preflight" })} className="h-8 rounded-md border border-border-strong bg-surface px-3 text-sm font-medium disabled:opacity-50">
            Re-run preflight
          </button>
        )}
        {can.release && (
          <button type="button" disabled={busy !== null} onClick={() => send("Released", { action: "release" })} className="h-8 rounded-md bg-accent px-3 text-sm font-medium text-white disabled:opacity-50">
            Release to the synthetic environment
          </button>
        )}
        {can.monitor && (
          <button type="button" disabled={busy !== null} onClick={() => send("Monitored", { action: "monitor" })} className="h-8 rounded-md border border-border-strong bg-surface px-3 text-sm font-medium disabled:opacity-50">
            Re-verify now
          </button>
        )}
      </div>
      {message && (
        <p role="status" className={`text-xs ${message.ok ? "text-good" : "text-bad"}`}>
          {message.text}
        </p>
      )}
    </div>
  );
}
