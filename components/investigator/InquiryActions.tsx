"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Re-test a workspace (a new version; the old one is kept) and add a note. */
export function InquiryActions({ id, canAct }: { id: number; canAct: boolean }) {
  const router = useRouter();
  const [busy, setBusy] = useState(false);
  const [note, setNote] = useState("");
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  if (!canAct) return <p className="text-xs text-muted">Your role can read this workspace but not re-test it or add notes.</p>;

  async function post(body: Record<string, unknown>, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch(`/api/inquiries/${id}`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setMessage({ ok: true, text: done.replace("{v}", String(json.version ?? "")) });
      if (body.action === "note") setNote("");
      router.refresh();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="space-y-2 text-sm" data-testid="inquiry-actions">
      <button type="button" disabled={busy} onClick={() => post({ action: "retest" }, "Re-tested: version {v}.")} className="rounded bg-text px-3 py-1 text-white disabled:opacity-50">
        Re-test against the current records
      </button>
      <form
        className="flex flex-wrap items-end gap-2"
        onSubmit={(e) => {
          e.preventDefault();
          void post({ action: "note", text: note }, "Note added.");
        }}
      >
        <label className="flex min-w-0 flex-1 flex-col gap-1">
          <span className="text-xs text-muted">Note</span>
          <input value={note} onChange={(e) => setNote(e.target.value)} className="rounded border border-border bg-surface px-2 py-1" placeholder="What you checked, or what to check next" />
        </label>
        <button type="submit" disabled={busy || note.trim().length < 3} className="rounded border border-border px-3 py-1 disabled:opacity-50">
          Add note
        </button>
      </form>
      {message && (
        <p role="status" className={message.ok ? "text-good" : "text-bad"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
