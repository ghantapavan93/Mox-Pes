"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import { Badge } from "@/components/ui";

export interface FaultView {
  id: number;
  kind: string;
  officeId: number | null;
  entity: string | null;
  action: string | null;
  recordId: number | null;
  remaining: number | null;
  skipRemaining: number;
  params: Record<string, unknown>;
  exhausted: boolean;
  fired: number;
  createdBy: string;
}

/** What each fault does to the MOCK's answers, shown next to the picker. */
const KIND_HELP: Record<string, string> = {
  rate_limit: "429 with Retry-After. The job backs off for that long, then resumes after its last committed batch.",
  expired_key: "403 invalid/expired credentials. The job fails at once (no retry); its checkpoint does not move.",
  timeout: "Holds the response past the client timeout. Retried with exponential backoff.",
  unavailable: "503. Retried with exponential backoff until max attempts.",
  malformed_record: "One record's amount becomes \"12.34.56\". That record is quarantined; the rest of the batch lands.",
  missing_timestamp: "One record loses dateUpdated (date for payments). Quarantined as INVALID_TIMESTAMP.",
  disappeared_record: "Search omits one id. Nothing is deleted downstream: absence is not evidence of deletion.",
  out_of_order: "Get returns the version before the latest. The older version is logged but never overwrites the projection.",
};

const AMOUNT_ENTITIES = ["subscription", "ticket", "payment"];

/**
 * Fault injection for the local FieldRoutes mock (engineers only). Faults change what the mock
 * answers — never a real system — and every create/clear is audited server-side.
 */
export function FaultPanel({
  faults,
  offices,
  entities,
  canEdit,
}: {
  faults: FaultView[];
  offices: Array<{ officeId: number; label: string }>;
  entities: readonly string[];
  canEdit: boolean;
}) {
  const router = useRouter();
  const [kind, setKind] = useState("rate_limit");
  const [office, setOffice] = useState(offices[0] ? String(offices[0].officeId) : "any");
  const [entity, setEntity] = useState("any");
  const [action, setAction] = useState("any");
  const [recordId, setRecordId] = useState("");
  const [times, setTimes] = useState("1");
  const [skip, setSkip] = useState("0");
  const [retryAfter, setRetryAfter] = useState("5");
  const [delayMs, setDelayMs] = useState("17000");
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<{ ok: boolean; text: string } | null>(null);

  async function post(payload: unknown, done: string) {
    setBusy(true);
    setMessage(null);
    try {
      const res = await fetch("/api/connectors/faults", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(payload) });
      const body = await res.json();
      if (!res.ok) throw new Error(body.issues?.join("; ") ?? body.error ?? `HTTP ${res.status}`);
      setMessage({ ok: true, text: done });
      router.refresh();
    } catch (e) {
      setMessage({ ok: false, text: (e as Error).message });
    } finally {
      setBusy(false);
    }
  }

  function submit(e: React.FormEvent) {
    e.preventDefault();
    const fault = {
      kind,
      officeId: office === "any" ? null : Number(office),
      entity: entity === "any" ? null : entity,
      action: action === "any" ? null : action,
      recordId: recordId.trim() ? Number(recordId) : null,
      remaining: times === "unlimited" ? null : Number(times),
      skip: Number(skip),
      ...(kind === "rate_limit" ? { retryAfterSeconds: Number(retryAfter) } : {}),
      ...(kind === "timeout" ? { delayMs: Number(delayMs) } : {}),
    };
    void post({ action: "create", fault }, `Fault armed: ${kind}.`);
  }

  const select = "rounded border border-border bg-surface px-2 py-1";
  return (
    <div className="space-y-4 text-sm" data-testid="fault-panel">
      {faults.length === 0 ? (
        <p className="text-muted">No faults armed: the mock answers like a healthy tenant.</p>
      ) : (
        <ul className="space-y-1.5">
          {faults.map((f) => (
            <li key={f.id} className="flex flex-wrap items-center justify-between gap-2 rounded border border-border px-3 py-2">
              <div className="text-xs">
                <Badge tone={f.exhausted ? "neutral" : "warn"}>{f.kind}</Badge>{" "}
                <span className="text-muted">
                  office {f.officeId ?? "any"} · {f.entity ?? "any entity"} · {f.action ?? "any action"}
                  {f.recordId ? ` · record ${f.recordId}` : ""} · fired {f.fired}
                  {f.exhausted ? " · exhausted" : f.remaining === null ? " · until cleared" : ` · ${f.remaining} left`}
                  {f.skipRemaining > 0 ? ` · skipping ${f.skipRemaining} more` : ""}
                </span>
              </div>
              {canEdit && (
                <button type="button" disabled={busy} onClick={() => void post({ action: "clear", faultId: f.id }, `Fault #${f.id} cleared.`)} className="text-xs text-accent hover:underline disabled:opacity-50">
                  Clear
                </button>
              )}
            </li>
          ))}
        </ul>
      )}

      {canEdit ? (
        <form onSubmit={submit} className="space-y-2 rounded border border-dashed border-border p-3">
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Fault</span>
              <select
                value={kind}
                onChange={(e) => {
                  const next = e.target.value;
                  setKind(next);
                  // Keep the other pickers valid for the new kind (the server re-validates anyway).
                  if (next === "disappeared_record" && action === "get") setAction("any");
                  if (next === "malformed_record" && entity !== "any" && !AMOUNT_ENTITIES.includes(entity)) setEntity("any");
                }}
                className={select}
              >
                {Object.keys(KIND_HELP).map((k) => <option key={k} value={k}>{k}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Office</span>
              <select value={office} onChange={(e) => setOffice(e.target.value)} className={select}>
                <option value="any">Any office</option>
                {offices.map((o) => <option key={o.officeId} value={o.officeId}>{o.label}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Entity</span>
              <select value={entity} onChange={(e) => setEntity(e.target.value)} className={select}>
                <option value="any">Any entity</option>
                {entities.filter((x) => kind !== "malformed_record" || AMOUNT_ENTITIES.includes(x)).map((x) => <option key={x} value={x}>{x}</option>)}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">On</span>
              <select value={action} onChange={(e) => setAction(e.target.value)} className={select}>
                <option value="any">search and get</option>
                <option value="search">search only</option>
                {kind !== "disappeared_record" && <option value="get">get only</option>}
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Record id (optional)</span>
              <input inputMode="numeric" pattern="[0-9]*" value={recordId} onChange={(e) => setRecordId(e.target.value)} className={select} placeholder="first matching" />
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Fires</span>
              <select value={times} onChange={(e) => setTimes(e.target.value)} className={select}>
                {["1", "2", "3", "5"].map((n) => <option key={n} value={n}>{n}×</option>)}
                <option value="unlimited">until cleared</option>
              </select>
            </label>
            <label className="flex flex-col gap-1">
              <span className="text-xs text-muted">Let through first</span>
              <input type="number" min={0} max={1000} value={skip} onChange={(e) => setSkip(e.target.value)} className={select} />
            </label>
            {kind === "rate_limit" && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">Retry-After (s)</span>
                <input type="number" min={0} max={3600} value={retryAfter} onChange={(e) => setRetryAfter(e.target.value)} className={select} />
              </label>
            )}
            {kind === "timeout" && (
              <label className="flex flex-col gap-1">
                <span className="text-xs text-muted">Delay (ms)</span>
                <input type="number" min={1} max={120000} value={delayMs} onChange={(e) => setDelayMs(e.target.value)} className={select} />
              </label>
            )}
          </div>
          <p className="text-xs text-muted">{KIND_HELP[kind]}</p>
          <div className="flex flex-wrap items-center gap-3">
            <button type="submit" disabled={busy} className="rounded bg-text px-3 py-1.5 font-medium text-white disabled:opacity-50">
              {busy ? "Saving…" : "Arm fault"}
            </button>
            {faults.length > 0 && (
              <button type="button" disabled={busy} onClick={() => void post({ action: "clear_all" }, "All faults cleared.")} className="text-xs text-accent hover:underline disabled:opacity-50">
                Clear all faults
              </button>
            )}
          </div>
        </form>
      ) : (
        <p className="text-xs text-faint">Arming faults requires the sync permission (integration engineer role).</p>
      )}
      {message && <p role="status" className={`text-xs ${message.ok ? "text-good" : "text-bad"}`}>{message.text}</p>}
    </div>
  );
}
