"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/** Records a readiness override. The server recomputes the assessment and applies the policy. */
export function OverrideForm({ journey, period, branch, to }: { journey: string; period: string; branch: string | null; to: string }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/opportunities", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ journey, period, branch, to, reason }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? `HTTP ${res.status}`);
      setMessage({ ok: true, text: `Override recorded: ${body.override.assessedLevel} → ${body.override.overrideLevel}` });
      setReason("");
      router.refresh();
    } catch (error) {
      setMessage({ ok: false, text: (error as Error).message });
    } finally {
      setBusy(false);
    }
  }

  const id = `override-${journey}`;
  return (
    <form onSubmit={submit} className="space-y-2" aria-label={`Override readiness to ${to}`}>
      <label htmlFor={id} className="block text-xs font-medium text-text">
        Override to <span className="font-semibold">{to}</span>: why is this risk acceptable?
      </label>
      <textarea
        id={id}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        rows={2}
        maxLength={1000}
        className="w-full rounded-md border border-border bg-surface px-2 py-1.5 text-sm"
        placeholder="At least 20 characters. Recorded with your name and the assessment as it is now."
      />
      <div className="flex items-center gap-3">
        <button type="submit" disabled={busy} className="rounded-md bg-text px-3 py-1.5 text-xs font-medium text-white disabled:opacity-50">
          {busy ? "Recording…" : "Record override"}
        </button>
        {message && (
          <p role="status" className={`text-xs ${message.ok ? "text-good" : "text-bad"}`}>
            {message.text}
          </p>
        )}
      </div>
    </form>
  );
}
