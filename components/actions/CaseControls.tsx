"use client";

import { useId, useState } from "react";
import { useAction } from "./useAction";

/** Owner assignment and closing a case without a fix (with a reason). Server-checked. */
export function CaseControls({
  caseId,
  owner,
  ownerOptions,
  canAssign,
  closeOptions,
}: {
  caseId: number;
  owner: string | null;
  ownerOptions: Array<{ value: string; label: string }>;
  canAssign: boolean;
  /** Empty when the viewer may not close or the case cannot be closed from its state. */
  closeOptions: Array<{ value: string; label: string }>;
}) {
  const id = useId();
  const [nextOwner, setNextOwner] = useState(owner ?? "");
  const [outcome, setOutcome] = useState(closeOptions[0]?.value ?? "");
  const [reason, setReason] = useState("");
  const { busy, message, run } = useAction();
  const url = `/api/cases/${caseId}`;

  if (!canAssign && closeOptions.length === 0) return null;
  return (
    <div className="space-y-3 text-sm" data-testid="case-controls">
      {canAssign && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${id}-owner`} className="text-muted">
            Owner
          </label>
          <select id={`${id}-owner`} value={nextOwner} onChange={(e) => setNextOwner(e.target.value)} className="rounded border border-border bg-surface px-2 py-1">
            <option value="">Unassigned</option>
            {ownerOptions.map((o) => (
              <option key={o.value} value={o.value}>
                {o.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            disabled={!!busy || nextOwner === (owner ?? "")}
            onClick={() => run("assign", url, { action: "assign", owner: nextOwner || null })}
            className="rounded border border-border px-3 py-1 hover:bg-surface-2 disabled:opacity-50"
          >
            {busy === "assign" ? "Saving…" : "Assign"}
          </button>
        </div>
      )}
      {closeOptions.length > 0 && (
        <details className="rounded border border-border p-2">
          <summary className="text-xs font-medium text-muted">Close without a fix…</summary>
          <form
            className="mt-2 space-y-2"
            onSubmit={(e) => {
              e.preventDefault();
              void run("close", url, { action: "close", outcome, reason });
            }}
          >
            <label htmlFor={`${id}-outcome`} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-muted">Outcome</span>
              <select id={`${id}-outcome`} value={outcome} onChange={(e) => setOutcome(e.target.value)} className="rounded border border-border bg-surface px-2 py-1">
                {closeOptions.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </label>
            <label htmlFor={`${id}-close-reason`} className="flex items-center gap-2">
              <span className="w-16 shrink-0 text-muted">Reason</span>
              <input
                id={`${id}-close-reason`}
                required
                minLength={10}
                value={reason}
                onChange={(e) => setReason(e.target.value)}
                placeholder="Why this case closes without a fix (audited)"
                className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1"
              />
            </label>
            <button type="submit" disabled={!!busy} className="rounded border border-border px-3 py-1 hover:bg-surface-2 disabled:opacity-50">
              {busy === "close" ? "Closing…" : "Close case"}
            </button>
          </form>
        </details>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-good" : "text-bad"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
