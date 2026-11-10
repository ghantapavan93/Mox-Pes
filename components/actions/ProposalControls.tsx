"use client";

import { useEffect, useId, useRef, useState } from "react";
import { useAction } from "./useAction";

/**
 * The next step for one proposal, as the server allows it for this viewer. Buttons appear
 * only when the proposal is live and the action is available; otherwise `blocked` explains
 * who can act. The server enforces the same rules again on every request.
 *
 * The component stays mounted for every proposal, live or not, so its status region (and the
 * last action's message) survives the refresh that follows an action, including the Execute
 * that ends the proposal's live life. After an execute, focus moves to the new execution result.
 */
export function ProposalControls({
  proposalId,
  live,
  canDryRun,
  canDecide,
  canExecute,
  dryRunLabel,
  blocked,
  executionTargetId,
  executionId,
}: {
  proposalId: number;
  /** Whether the proposal can still be acted on; when false only the status region renders. */
  live: boolean;
  canDryRun: boolean;
  /** approve / reject */
  canDecide: boolean;
  canExecute: boolean;
  dryRunLabel: string;
  blocked: string[];
  /** DOM id of the execution result element (tabIndex -1) that receives focus after an execute. */
  executionTargetId: string;
  /** The stored execution's id, or null: a new id after an execute means the result is on screen. */
  executionId: number | null;
}) {
  const id = useId();
  const [reason, setReason] = useState("");
  const { busy, message, run } = useAction();
  const url = `/api/proposals/${proposalId}`;
  const reasonOk = reason.trim().length >= 5;
  // Set when Execute is pressed: the execution id the page showed then. Focus moves once the
  // refreshed page shows a different (new) execution.
  const focusAfter = useRef<{ from: number | null } | null>(null);

  useEffect(() => {
    if (!focusAfter.current || executionId === null || executionId === focusAfter.current.from) return;
    focusAfter.current = null;
    document.getElementById(executionTargetId)?.focus();
  });

  /** Busy controls stay focusable (aria-disabled), so a press while busy is ignored here. */
  const act = (label: string, body: Record<string, unknown>) => {
    if (busy) return;
    if (label === "execute") focusAfter.current = { from: executionId };
    void run(label, url, body).then((ok) => {
      if (!ok) focusAfter.current = null;
    });
  };
  const busyProps = { "aria-disabled": busy ? true : undefined } as const;

  return (
    <div className={`space-y-2 text-sm ${live || message ? "mt-3" : ""}`} data-testid="proposal-controls">
      {live && (canDryRun || canExecute) && (
        <div className="flex flex-wrap items-center gap-2">
          {canDryRun && (
            <button
              type="button"
              {...busyProps}
              onClick={() => act("dry", { action: "dry_run" })}
              className="rounded border border-border px-3 py-1.5 hover:bg-surface-2 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            >
              {busy === "dry" ? "Running…" : dryRunLabel}
            </button>
          )}
          {canExecute && (
            <button
              type="button"
              {...busyProps}
              onClick={() => act("execute", { action: "execute" })}
              className="rounded bg-accent px-3 py-1.5 font-medium text-white hover:opacity-90 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
            >
              {busy === "execute" ? "Executing…" : "Execute (application, once)"}
            </button>
          )}
        </div>
      )}
      {live && canDecide && (
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
            {...busyProps}
            disabled={!reasonOk}
            onClick={() => act("approve", { action: "approve", reason })}
            className="rounded bg-good px-3 py-1.5 font-medium text-white disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          >
            {busy === "approve" ? "Approving…" : "Approve"}
          </button>
          <button
            type="button"
            {...busyProps}
            disabled={!reasonOk}
            onClick={() => act("reject", { action: "reject", reason })}
            className="rounded border border-bad/40 px-3 py-1.5 font-medium text-bad disabled:opacity-50 aria-disabled:cursor-not-allowed aria-disabled:opacity-50"
          >
            {busy === "reject" ? "Rejecting…" : "Reject"}
          </button>
        </div>
      )}
      {live &&
        blocked.map((b) => (
          <p key={b} className="text-xs text-muted">
            {b}
          </p>
        ))}
      {/* Always mounted, so assistive tech is already watching it when the message arrives. */}
      <p role="status" aria-live="polite" className={message ? (message.ok ? "text-good" : "text-bad") : "sr-only"}>
        {message?.text ?? ""}
      </p>
    </div>
  );
}
