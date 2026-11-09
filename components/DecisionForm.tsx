"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** One human decision on an exception. Posts to the actions API; the server re-checks everything. */
export function DecisionForm({
  exceptionId,
  action,
  branchOptions,
  defaultBranch,
  submitLabel,
  hint,
}: {
  exceptionId: number;
  action: "map_campaign" | "override_lead_branch" | "close" | "acknowledge";
  branchOptions?: Array<{ id: string; label: string }>;
  defaultBranch?: string;
  submitLabel: string;
  hint?: string;
}) {
  const router = useRouter();
  const [branchId, setBranchId] = useState(defaultBranch ?? branchOptions?.[0]?.id ?? "");
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/exceptions/${exceptionId}/actions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ action, branchId: branchOptions ? branchId : undefined, reason }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setMessage({ ok: true, text: body.message });
      router.refresh();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="space-y-2 text-sm" data-testid="decision-form">
      {branchOptions && (
        <label className="flex items-center gap-2">
          <span className="w-16 text-muted">Branch</span>
          <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="rounded border border-border bg-surface px-2 py-1">
            {branchOptions.map((b) => (
              <option key={b.id} value={b.id}>{b.label}</option>
            ))}
          </select>
        </label>
      )}
      <label className="flex items-start gap-2">
        <span className="w-16 pt-1 text-muted">Reason</span>
        <input
          required
          minLength={5}
          value={reason}
          onChange={(e) => setReason(e.target.value)}
          placeholder="Why — this goes in the audit log"
          className="flex-1 rounded border border-border bg-surface px-2 py-1"
        />
      </label>
      {hint && <p className="text-xs text-faint">{hint}</p>}
      <button type="submit" disabled={busy} className="rounded bg-text px-3 py-1.5 font-medium text-white disabled:opacity-50">
        {busy ? "Saving…" : submitLabel}
      </button>
      {message && <p role="status" className={message.ok ? "text-good" : "text-bad"}>{message.text}</p>}
    </form>
  );
}
