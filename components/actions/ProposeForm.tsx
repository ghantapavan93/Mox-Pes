"use client";

import { useId, useState } from "react";
import { useAction } from "./useAction";

export interface ParamField {
  name: string;
  label: string;
  type: "select" | "number";
  options?: Array<{ value: string; label: string }>;
  defaultValue: string;
  hint?: string;
}

export interface ProposableKind {
  kind: string;
  title: string;
  label: string;
  fields: ParamField[];
}

const initialValues = (kind: ProposableKind | undefined) => Object.fromEntries((kind?.fields ?? []).map((f) => [f.name, f.defaultValue]));

/**
 * Proposes a fix for this exception. Only kinds that apply to the exception and whose
 * executor is connected are offered (computed on the server); the server validates again.
 * Proposing changes nothing in the data: it starts the dry run, approval, execution path.
 */
export function ProposeForm({ exceptionId, kinds }: { exceptionId: number; kinds: ProposableKind[] }) {
  const id = useId();
  const [kind, setKind] = useState(kinds[0]?.kind ?? "");
  const spec = kinds.find((k) => k.kind === kind);
  const [values, setValues] = useState<Record<string, string>>(() => initialValues(kinds[0]));
  const [rationale, setRationale] = useState("");
  const { busy, message, run } = useAction();

  function choose(next: string) {
    setKind(next);
    setValues(initialValues(kinds.find((k) => k.kind === next)));
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!spec) return;
    const params = Object.fromEntries(spec.fields.map((f) => [f.name, f.type === "number" ? Number(values[f.name]) : values[f.name]]));
    const ok = await run("propose", "/api/proposals", { exceptionId, kind, params, rationale });
    if (ok) setRationale("");
  }

  if (kinds.length === 0) return null;
  return (
    <form onSubmit={submit} className="space-y-2 text-sm" data-testid="propose-form">
      <label className="flex items-center gap-2" htmlFor={`${id}-kind`}>
        <span className="w-20 shrink-0 text-muted">Fix</span>
        <select id={`${id}-kind`} value={kind} onChange={(e) => choose(e.target.value)} className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1">
          {kinds.map((k) => (
            <option key={k.kind} value={k.kind}>
              {k.title} — {k.label}
            </option>
          ))}
        </select>
      </label>
      {spec?.fields.map((f) => (
        <div key={f.name}>
          <label className="flex items-center gap-2" htmlFor={`${id}-${f.name}`}>
            <span className="w-20 shrink-0 text-muted">{f.label}</span>
            {f.type === "select" ? (
              <select
                id={`${id}-${f.name}`}
                value={values[f.name] ?? ""}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1"
              >
                {f.options?.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            ) : (
              <input
                id={`${id}-${f.name}`}
                type="number"
                required
                min={1}
                value={values[f.name] ?? ""}
                onChange={(e) => setValues({ ...values, [f.name]: e.target.value })}
                className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1"
              />
            )}
          </label>
          {f.hint && <p className="mt-0.5 pl-[5.5rem] text-[11px] text-faint">{f.hint}</p>}
        </div>
      ))}
      <label className="flex items-start gap-2" htmlFor={`${id}-why`}>
        <span className="w-20 shrink-0 pt-1 text-muted">Rationale</span>
        <textarea
          id={`${id}-why`}
          required
          minLength={10}
          rows={2}
          value={rationale}
          onChange={(e) => setRationale(e.target.value)}
          placeholder="Why this fixes the exception (stored with the proposal and audited)"
          className="min-w-0 flex-1 rounded border border-border bg-surface px-2 py-1"
        />
      </label>
      <button type="submit" disabled={!!busy} className="rounded bg-text px-3 py-1.5 font-medium text-white disabled:opacity-50">
        {busy ? "Recording…" : "Propose fix"}
      </button>
      {message && (
        <p role={message.ok ? "status" : "alert"} className={message.ok ? "text-good" : "text-bad"}>
          {message.text}
        </p>
      )}
    </form>
  );
}
