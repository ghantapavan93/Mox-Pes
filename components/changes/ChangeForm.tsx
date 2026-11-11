"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

export interface CampaignOption {
  id: number;
  label: string;
  currentBranchId: string | null;
}

/**
 * Proposes a campaign → branch mapping change; the server preflights it at once. With
 * `supersedes`, it is a corrected resubmission of an earlier change.
 */
export function ChangeForm({
  campaigns,
  branches,
  defaults,
  supersedes = null,
  submitLabel = "Propose and preflight",
}: {
  campaigns: CampaignOption[];
  branches: Array<{ id: string; label: string }>;
  defaults?: { campaignId?: number; branchId?: string; reason?: string };
  supersedes?: number | null;
  submitLabel?: string;
}) {
  const router = useRouter();
  const [campaignId, setCampaignId] = useState(defaults?.campaignId ?? campaigns[0]?.id ?? 0);
  const [branchId, setBranchId] = useState(defaults?.branchId ?? branches[0]?.id ?? "");
  const [reason, setReason] = useState(defaults?.reason ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = campaigns.find((c) => c.id === campaignId)?.currentBranchId ?? null;

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/changes", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ kind: "campaign_mapping", payload: { campaignId, branchId }, reason, supersedes }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? (body.issues ? body.issues.join("; ") : `HTTP ${res.status}`));
      router.push(`/changes/${body.change.id}`);
      router.refresh();
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="grid gap-3 sm:grid-cols-2" aria-label={supersedes ? "Resubmit a corrected change" : "Propose a mapping change"}>
      <label className="flex flex-col gap-1 text-xs font-medium text-muted">
        Campaign
        <select value={campaignId} onChange={(e) => setCampaignId(Number(e.target.value))} disabled={supersedes !== null} className="h-8 rounded-md border border-border-strong bg-surface px-2 text-sm text-text">
          {campaigns.map((c) => (
            <option key={c.id} value={c.id}>
              {c.label} ({c.currentBranchId ?? "unmapped"})
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-muted">
        Map to branch {current && <span className="font-normal">(now {current})</span>}
        <select value={branchId} onChange={(e) => setBranchId(e.target.value)} className="h-8 rounded-md border border-border-strong bg-surface px-2 text-sm text-text">
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
      <label className="flex flex-col gap-1 text-xs font-medium text-muted sm:col-span-2">
        Why (at least 10 characters)
        <input value={reason} onChange={(e) => setReason(e.target.value)} maxLength={1000} className="h-8 rounded-md border border-border-strong bg-surface px-2 text-sm text-text" />
      </label>
      <div className="flex items-center gap-3 sm:col-span-2">
        <button type="submit" disabled={busy} className="h-8 rounded-md bg-text px-3 text-sm font-medium text-white disabled:opacity-50">
          {busy ? "Preflighting…" : submitLabel}
        </button>
        <span className="text-xs text-muted">The preflight runs the real write in a transaction that is rolled back. Nothing changes until a different person approves and it is released.</span>
        {error && (
          <p role="alert" className="text-xs text-bad">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}
