"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";

/**
 * Accept or reject one ambiguous identity match. Rendered only for roles holding
 * `reviewIdentity`; the API re-checks permission, scope and that the conflict is still pending.
 * A reason is required: it is stored on the conflict and in the audit log.
 */
export function ConflictDecision({ conflictId, leadLabel, customerId }: { conflictId: number; leadLabel: string; customerId: number }) {
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"accept" | "reject" | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);
  const reasonId = `conflict-reason-${conflictId}`;

  async function decide(decision: "accept" | "reject") {
    setBusy(decision);
    setMessage(null);
    try {
      const res = await fetch(`/api/identity/conflicts/${conflictId}/decision`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ decision, reason }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.error ?? body.issues?.join("; ") ?? `HTTP ${res.status}`);
      setMessage({ ok: true, text: body.message });
      router.refresh();
    } catch (err) {
      setMessage({ ok: false, text: (err as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const tooShort = reason.trim().length < 5;
  return (
    <form
      onSubmit={(e) => e.preventDefault()}
      className="space-y-1.5 text-xs"
      aria-label={`Decide whether ${leadLabel} is CRM customer ${customerId}`}
      data-testid={`conflict-decision-${conflictId}`}
    >
      <label htmlFor={reasonId} className="sr-only">Reason for the decision</label>
      <input
        id={reasonId}
        required
        minLength={5}
        maxLength={500}
        value={reason}
        onChange={(e) => setReason(e.target.value)}
        placeholder="Reason (audited), e.g. caller confirmed account on recording"
        className="w-full rounded border border-border bg-surface px-2 py-1"
      />
      <div className="flex flex-wrap gap-1.5">
        <button
          type="button"
          disabled={!!busy || tooShort}
          onClick={() => decide("accept")}
          className="rounded bg-good px-2 py-1 font-medium text-white disabled:opacity-50"
        >
          {busy === "accept" ? "Linking…" : `Same person: link to ${customerId}`}
        </button>
        <button
          type="button"
          disabled={!!busy || tooShort}
          onClick={() => decide("reject")}
          className="rounded border border-bad/40 px-2 py-1 font-medium text-bad hover:bg-bad-soft disabled:opacity-50"
        >
          {busy === "reject" ? "Saving…" : "Different person"}
        </button>
      </div>
      {tooShort && !message && <p className="text-faint">A reason of at least 5 characters is required.</p>}
      {message && (
        <p role="status" className={message.ok ? "text-good" : "text-bad"}>
          {message.text}
        </p>
      )}
    </form>
  );
}
