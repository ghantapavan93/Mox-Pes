"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Opens a workspace for "Why did <branch>'s paid CAC increase?" and goes to it. */
export function OpenInquiry({ branches, initial }: { branches: Array<{ id: string; label: string }>; initial?: string }) {
  const router = useRouter();
  const [branch, setBranch] = useState(initial ?? branches[0]?.id ?? "");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (branches.length === 0) return null;

  async function open(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      const res = await fetch("/api/inquiries", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ kind: "cac_change", branchId: branch }) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      router.push(`/investigator/inquiries/${json.id}`);
    } catch (err) {
      setError((err as Error).message);
      setBusy(false);
    }
  }

  return (
    <form onSubmit={open} className="flex flex-wrap items-end gap-2 text-sm" data-testid="open-inquiry">
      <label className="flex flex-col gap-1">
        <span className="text-xs text-muted">Branch</span>
        <select value={branch} onChange={(e) => setBranch(e.target.value)} className="rounded border border-border bg-surface px-2 py-1">
          {branches.map((b) => (
            <option key={b.id} value={b.id}>
              {b.label}
            </option>
          ))}
        </select>
      </label>
      <button type="submit" disabled={busy || !branch} className="rounded bg-text px-3 py-1 text-white disabled:opacity-50">
        {busy ? "Testing six hypotheses…" : "Why did paid CAC increase?"}
      </button>
      {error && (
        <p role="alert" className="w-full text-bad">
          {error}
        </p>
      )}
    </form>
  );
}
