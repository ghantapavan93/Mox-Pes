"use client";

import { useId, useState } from "react";
import { useAction } from "./useAction";

/**
 * The next step for one proposal, as the server allows it for this viewer. Buttons appear
 * only when the action is available; otherwise `blocked` explains who can act. The server
 * enforces the same rules again on every request.
 */
export function ProposalControls({
  proposalId,
  canDryRun,
  canDecide,
  canExecute,
  dryRunLabel,
  blocked,
}: {
  proposalId: number;
  canDryRun: boolean;
  /** approve / reject */
  canDecide: boolean;
  canExecute: boolean;
  dryRunLabel: string;
  blocked: string[];
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const { busy, message, run } = useAction();
  const url = `/api/proposals/${proposalId}`;
  const reasonOk = reason.trim().length >= 5;

  return (
    <div className="space-y-2 text-sm" data-testid="proposal-controls">
      {(canDryRun || canExecute) && (
        <div className="flex flex-wrap items-center gap-2">
          {canDryRun && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => run("dry", url, { action: "dry_run" })}
              className="rounded border border-border px-3 py-1.5 hover:bg-surface-2 disabled:opacity-50"
            >
              {busy === "dry" ? "Running…" : dryRunLabel}
            </button>
          )}
          {canExecute && (
            <button
              type="button"
              disabled={!!busy}
              onClick={() => run("execute", url, { action: "execute" })}
              className="rounded bg-accent px-3 py-1.5 font-medium text-white hover:opacity-90 disabled:opacity-50"
            >
              {busy === "execute" ? "Executing…" : "Execute (application, once)"}
            </button>
          )}
        </div>
      )}
      {canDecide && (
        <div className="flex flex-wrap items-center gap-2">
          <label htmlFor={`${id}-reason`} className="sr-only">
            Decision reason
          </label>
          <input
            id={`${id}-reason`}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            minLength={5}
            placeholder="Decision reason (audited, 5+ characters)"
            className="min-w-48 flex-1 rounded border border-border bg-surface px-2 py-1"
          />
          <button
            type="button"
            disabled={!!busy || !reasonOk}
            onClick={() => run("approve", url, { action: "approve", reason })}
            className="rounded bg-good px-3 py-1.5 font-medium text-white disabled:opacity-50"
          >
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
          <button
            type="button"
            disabled={!!busy || !reasonOk}
            onClick={() => run("reject", url, { action: "reject", reason })}
            className="rounded border border-bad/40 px-3 py-1.5 font-medium text-bad disabled:opacity-50"
          >
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </button>
        </div>
      )}
      {blocked.map((b) => (
        <p key={b} className="text-xs text-muted">
          {b}
        </p>
      ))}
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-good" : "text-bad"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
