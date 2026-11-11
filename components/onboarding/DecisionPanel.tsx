"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";

/**
 * Approve or reject the mapping the latest dry run used, then publish. The buttons a role may
 * not use are not hidden: they are disabled with the reason, and the server refuses them anyway.
 */
export function DecisionPanel(props: {
  uploadId: number;
  /** The dry run on screen: publication is bound to it. */
  dryRunId: number;
  mappingId: number | null;
  mappingStatus: string | null;
  canDecide: boolean;
  decideReason: string | null;
  canPublish: boolean;
  publishReason: string | null;
  publishable: number;
  authority: "publish" | "reconcile";
}) {
  const id = useId();
  const router = useRouter();
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function post(label: string, url: string, body?: unknown) {
    setBusy(label);
    setMessage(null);
    try {
      const res = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[]; published?: number; skipped?: { changedSinceDryRun: number } };
      if (!res.ok) throw new Error([json.error ?? `HTTP ${res.status}`, ...(json.issues ?? [])].join(" — "));
      setMessage({
        ok: true,
        text: label === "publish" ? `Published ${json.published ?? 0} rows through intake${json.skipped?.changedSinceDryRun ? `; ${json.skipped.changedSinceDryRun} skipped because the ledger gained them after the dry run` : ""}.` : "Decision recorded.",
      });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(null);
    }
  }

  const proposed = props.mappingStatus === "proposed";
  return (
    <div className="space-y-4 text-sm" data-testid="decision-panel">
      {proposed && props.mappingId !== null && (
        <div className="space-y-2">
          <label htmlFor={`${id}-reason`} className="block font-medium">Decision reason (stored and audited)</label>
          <textarea
            id={`${id}-reason`}
            rows={2}
            value={reason}
            onChange={(e) => setReason(e.target.value)}
            disabled={!props.canDecide || !!busy}
            placeholder="What you checked: columns, money meaning, the quarantined rows"
            className="w-full rounded border border-border bg-surface px-2 py-1"
          />
          <div className="flex flex-wrap gap-2">
            <button
              type="button"
              disabled={!props.canDecide || !!busy || reason.trim().length < 5}
              onClick={() => void post("approve", `/api/onboarding/mappings/${props.mappingId}/decision`, { decision: "approve", reason })}
              className="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            >
              {busy === "approve" ? "Approving…" : "Approve mapping"}
            </button>
            <button
              type="button"
              disabled={!props.canDecide || !!busy || reason.trim().length < 5}
              onClick={() => void post("reject", `/api/onboarding/mappings/${props.mappingId}/decision`, { decision: "reject", reason })}
              className="rounded-md border border-border-strong px-3 py-1.5 font-medium hover:bg-surface-2 disabled:opacity-50"
            >
              Reject
            </button>
          </div>
          {!props.canDecide && props.decideReason && <p className="text-xs text-muted">{props.decideReason}</p>}
        </div>
      )}
      {props.authority === "publish" ? (
        <div className="space-y-2">
          <button
            type="button"
            disabled={!props.canPublish || !!busy}
            onClick={() => void post("publish", `/api/onboarding/uploads/${props.uploadId}/publish`, { dryRunId: props.dryRunId })}
            className="rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-hover disabled:opacity-50"
            data-testid="publish"
          >
            {busy === "publish" ? "Publishing…" : `Publish ${props.publishable} new row${props.publishable === 1 ? "" : "s"}`}
          </button>
          {!props.canPublish && props.publishReason && <p className="text-xs text-muted">{props.publishReason}</p>}
        </div>
      ) : (
        <p className="text-muted">This dataset is compare-only. Approving the mapping records it for the next export of this layout; nothing is published.</p>
      )}
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-good" : "text-bad"}>
          {message.text}
        </p>
      )}
    </div>
  );
}
