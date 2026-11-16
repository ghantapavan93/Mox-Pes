"use client";

import { useRouter } from "next/navigation";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import type { FieldSuggestion } from "@/lib/onboarding/assistant";
import type { MappingSpec, SpecProblem } from "@/lib/onboarding/compile";
import type { DatasetId, FieldKind, MoneyMeaning } from "@/lib/onboarding/targets";

export interface EditorField {
  key: string;
  label: string;
  meaning: string;
  kind: FieldKind;
  required: boolean;
  values?: readonly string[];
  moneyMeaning?: MoneyMeaning;
  personal?: boolean;
  untrustedText?: boolean;
}

export interface EditorDataset {
  id: DatasetId;
  label: string;
  authority: "publish" | "reconcile";
  fields: EditorField[];
  branches: Array<{ id: string; name: string }>;
}

export interface ColumnFacts {
  name: string;
  looksLike: string;
  slashDates: boolean;
  zoneless: boolean;
}

type ValueRow = { value: string; rows: number; proposed: string | null };

const STATUS: Record<FieldSuggestion["status"], { text: string; className: string }> = {
  suggested: { text: "Suggested", className: "border-good/30 bg-good-soft text-text" },
  ambiguous: { text: "Needs your choice", className: "border-warn/40 bg-warn-soft text-text" },
  blocked: { text: "No safe column", className: "border-bad/30 bg-bad-soft text-text" },
  unmapped: { text: "Not found", className: "border-border bg-surface-2 text-muted" },
};

const ABSENT = "";
const LEAVE = "__leave__";

/** Polls for an element for up to ten seconds: the refreshed page arrives after the request ends. */
async function waitFor<T>(find: () => T | null, ms = 10_000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const found = find();
    if (found || Date.now() > end) return found;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
}

/**
 * Human review of a mapping. The assistant's suggestions are pre-selected only when it
 * suggested; anything ambiguous starts empty and must be chosen. Submitting proposes a mapping
 * VERSION (the server validates it again) and then dry-runs it; nothing is imported here.
 */
export function MappingEditor(props: {
  uploadId: number;
  datasets: EditorDataset[];
  moneyMeanings: Record<MoneyMeaning, string>;
  columns: ColumnFacts[];
  suggestions: FieldSuggestion[];
  suggestedDataset: DatasetId | null;
  initial: MappingSpec | null;
  initialValues: Record<string, ValueRow[]>;
  canPropose: boolean;
  proposeReason: string | null;
}) {
  const id = useId();
  const router = useRouter();
  const [dataset, setDataset] = useState<DatasetId | "">(props.initial?.dataset ?? props.suggestedDataset ?? "");
  const target = props.datasets.find((d) => d.id === dataset) ?? null;
  const fromSuggestions = (ds: DatasetId | "") =>
    ds === props.suggestedDataset ? Object.fromEntries(props.suggestions.map((s) => [s.field, s.status === "suggested" ? s.column : null])) : {};
  const [columns, setColumns] = useState<Record<string, string | null>>(() => props.initial?.columns ?? fromSuggestions(dataset));
  const [constants, setConstants] = useState<Record<string, string>>(props.initial?.constants ?? {});
  const [moneyMeaning, setMoneyMeaning] = useState<Record<string, MoneyMeaning>>(props.initial?.moneyMeaning ?? {});
  const [valueMaps, setValueMaps] = useState<Record<string, Record<string, string>>>(props.initial?.valueMaps ?? {});
  const [values, setValues] = useState<Record<string, ValueRow[]>>(props.initialValues);
  const [dateOrder, setDateOrder] = useState<"MDY" | "DMY" | null>(props.initial?.dateOrder ?? null);
  const [localTime, setLocalTime] = useState<boolean>(props.initial?.localTime === "branch_local");
  const [exportedAt, setExportedAt] = useState<string>(props.initial?.exportedAt ? props.initial.exportedAt.slice(0, 16) : "");
  const [busy, setBusy] = useState(false);
  const [problems, setProblems] = useState<SpecProblem[]>([]);
  const [error, setError] = useState<string | null>(null);
  const firstLoad = useRef(true);

  const byField = useMemo(() => new Map(props.suggestions.map((s) => [s.field, s])), [props.suggestions]);
  const facts = useMemo(() => new Map(props.columns.map((c) => [c.name, c])), [props.columns]);
  const mappedDateColumns = (target?.fields ?? []).filter((f) => (f.kind === "datetime" || f.kind === "date") && columns[f.key]).map((f) => facts.get(columns[f.key]!)!).filter(Boolean);
  const askDateOrder = mappedDateColumns.some((c) => c.slashDates);
  const askLocalTime = (target?.fields ?? []).some((f) => f.kind === "datetime" && columns[f.key] && facts.get(columns[f.key]!)?.zoneless);

  // Value translations follow the chosen columns: refetch the distinct values when they change.
  const valueKey = JSON.stringify((target?.fields ?? []).filter((f) => f.kind === "enum" || f.kind === "branch").map((f) => [f.key, columns[f.key] ?? null]));
  useEffect(() => {
    if (firstLoad.current) {
      firstLoad.current = false;
      return;
    }
    if (!dataset) return;
    const ctrl = new AbortController();
    fetch(`/api/onboarding/uploads/${props.uploadId}/values`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ dataset, columns }), signal: ctrl.signal })
      .then((r) => r.json())
      .then((j: { values?: Record<string, ValueRow[]> }) => j.values && setValues(j.values))
      .catch(() => {});
    return () => ctrl.abort();
    // eslint-disable-next-line react-hooks/exhaustive-deps -- valueKey captures the relevant columns
  }, [valueKey, dataset, props.uploadId]);

  function translation(field: string, row: ValueRow): string {
    const saved = valueMaps[field]?.[row.value];
    if (saved !== undefined) return saved;
    return row.proposed ?? LEAVE;
  }

  function buildSpec(): MappingSpec {
    const maps: MappingSpec["valueMaps"] = {};
    for (const [field, rows] of Object.entries(values)) {
      if (!columns[field]) continue;
      const m: Record<string, string> = {};
      for (const r of rows) {
        const t = translation(field, r);
        if (t !== LEAVE) m[r.value] = t;
      }
      maps[field] = m;
    }
    const keep = new Set(target?.fields.map((f) => f.key));
    return {
      dataset: dataset as DatasetId,
      columns: Object.fromEntries(Object.entries(columns).filter(([k]) => keep.has(k))),
      constants: Object.fromEntries(Object.entries(constants).filter(([k, v]) => keep.has(k) && !columns[k] && v.trim() !== "")),
      valueMaps: maps,
      dateOrder: askDateOrder ? dateOrder : null,
      localTime: localTime ? "branch_local" : null,
      moneyMeaning: Object.fromEntries(Object.entries(moneyMeaning).filter(([k]) => keep.has(k) && columns[k])),
      exportedAt: dataset === "ad_spend" && exportedAt ? new Date(`${exportedAt}:00Z`).toISOString().replace(".000Z", "Z") : null,
    };
  }

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    if (!target) return;
    setBusy(true);
    setError(null);
    setProblems([]);
    try {
      const res = await fetch(`/api/onboarding/uploads/${props.uploadId}/mappings`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ spec: buildSpec() }) });
      const json = (await res.json()) as { mappingId?: number; problems?: SpecProblem[]; error?: string; issues?: string[] };
      if (!res.ok || !json.mappingId) throw new Error([json.error ?? `HTTP ${res.status}`, ...(json.issues ?? [])].join(" — "));
      if (json.problems && json.problems.length > 0) {
        setProblems(json.problems);
        router.refresh();
        return;
      }
      const dry = await fetch(`/api/onboarding/uploads/${props.uploadId}/dry-run`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ mappingId: json.mappingId }) });
      const dj = (await dry.json()) as { id?: number; error?: string };
      if (!dry.ok) throw new Error(dj.error ?? `HTTP ${dry.status}`);
      router.refresh();
      // Land on the result of THIS dry run once the refreshed page renders it (BYOF-WORKFLOW.md).
      // Scrolling straight away left the reader on the mapping form: the result was not there yet.
      const result = await waitFor(() => document.querySelector<HTMLElement>(`[data-testid="upload-result"][data-dry-run="${dj.id}"]`));
      (result ?? document.getElementById("dry-run"))?.scrollIntoView({ behavior: "smooth", block: "start" });
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const disabled = !props.canPropose || busy;
  return (
    <form onSubmit={submit} className="space-y-5" data-testid="mapping-editor">
      {!props.canPropose && props.proposeReason && <p className="text-sm text-muted">{props.proposeReason}</p>}
      <label htmlFor={`${id}-dataset`} className="flex max-w-xl flex-col gap-1 text-sm">
        <span className="font-medium">This file contains</span>
        <select
          id={`${id}-dataset`}
          value={dataset}
          disabled={disabled}
          onChange={(e) => {
            const next = e.target.value as DatasetId | "";
            setDataset(next);
            setColumns(fromSuggestions(next));
          }}
          className="rounded border border-border bg-surface px-2 py-1.5"
        >
          <option value="">Choose a dataset…</option>
          {props.datasets.map((d) => (
            <option key={d.id} value={d.id}>
              {d.label} ({d.authority === "publish" ? "can be published" : "compare only"})
            </option>
          ))}
        </select>
      </label>

      {target && (
        <ol className="divide-y divide-border rounded-lg border border-border" aria-label="Field mapping">
          {target.fields.map((f) => {
            const s = dataset === props.suggestedDataset ? byField.get(f.key) : undefined;
            const column = columns[f.key] ?? null;
            const canConstant = f.kind === "enum" || f.key === "account_id";
            const vals = column ? values[f.key] : undefined;
            const mm = moneyMeaning[f.key];
            return (
              <li key={f.key} className="grid grid-cols-1 gap-3 p-3 lg:grid-cols-[minmax(0,15rem)_minmax(0,1fr)]" data-testid={`field-${f.key}`}>
                <div className="min-w-0">
                  <p className="text-sm font-medium">
                    {f.label} {f.required ? <span className="text-xs font-normal text-bad">required</span> : <span className="text-xs font-normal text-faint">optional</span>}
                  </p>
                  <p className="text-xs text-muted">{f.meaning}</p>
                  {(f.personal || f.untrustedText) && (
                    <p className="mt-1 text-[11px] text-faint">{f.personal ? "Personal data: hashed before it is stored. " : ""}{f.untrustedText ? "Free text: stored as untrusted data, never read as instructions." : ""}</p>
                  )}
                </div>
                <div className="min-w-0 space-y-2">
                  <div className="flex flex-wrap items-center gap-2">
                    <label htmlFor={`${id}-${f.key}`} className="sr-only">Column for {f.label}</label>
                    <select
                      id={`${id}-${f.key}`}
                      value={column ?? ABSENT}
                      disabled={disabled}
                      onChange={(e) => setColumns({ ...columns, [f.key]: e.target.value === ABSENT ? null : e.target.value })}
                      className="min-w-0 max-w-full flex-1 rounded border border-border bg-surface px-2 py-1 text-sm sm:max-w-xs"
                    >
                      <option value={ABSENT}>Not in this file</option>
                      {props.columns.map((c) => (
                        <option key={c.name} value={c.name}>
                          {c.name} ({c.looksLike})
                        </option>
                      ))}
                    </select>
                    {s && (
                      <span className={`rounded border px-1.5 py-0.5 text-xs ${STATUS[s.status].className}`}>
                        {STATUS[s.status].text}
                        {s.status === "suggested" && s.confidence ? ` · ${s.confidence} confidence` : ""}
                      </span>
                    )}
                  </div>
                  {s && (s.evidence.length > 0 || s.abstainReasons.length > 0) && (
                    <details className="text-xs text-muted">
                      <summary className="cursor-pointer text-accent">Why</summary>
                      <ul className="mt-1 list-disc space-y-0.5 pl-5">
                        {s.evidence.map((x, i) => (
                          <li key={`e${i}`}>{x}</li>
                        ))}
                        {s.abstainReasons.map((x, i) => (
                          <li key={`a${i}`} className="text-text">{x}</li>
                        ))}
                      </ul>
                    </details>
                  )}
                  {!column && canConstant && (
                    <label className="flex flex-wrap items-center gap-2 text-sm">
                      <span className="text-muted">Same value for every row</span>
                      {f.values ? (
                        <select value={constants[f.key] ?? ""} disabled={disabled} onChange={(e) => setConstants({ ...constants, [f.key]: e.target.value })} className="rounded border border-border bg-surface px-2 py-1">
                          <option value="">None</option>
                          {f.values.map((v) => (
                            <option key={v} value={v}>{v}</option>
                          ))}
                        </select>
                      ) : (
                        <input value={constants[f.key] ?? ""} disabled={disabled} onChange={(e) => setConstants({ ...constants, [f.key]: e.target.value })} className="min-w-0 rounded border border-border bg-surface px-2 py-1" />
                      )}
                    </label>
                  )}
                  {f.kind === "money" && column && (
                    <div className="space-y-1">
                      <label className="flex flex-wrap items-center gap-2 text-sm">
                        <span className="text-muted">What &ldquo;{column}&rdquo; measures</span>
                        <select
                          value={mm ?? ""}
                          disabled={disabled}
                          onChange={(e) => setMoneyMeaning({ ...moneyMeaning, [f.key]: e.target.value as MoneyMeaning })}
                          className="min-w-0 max-w-full rounded border border-border bg-surface px-2 py-1"
                          data-testid={`money-${f.key}`}
                        >
                          <option value="">Choose…</option>
                          {(Object.entries(props.moneyMeanings) as Array<[MoneyMeaning, string]>).map(([k, v]) => (
                            <option key={k} value={k}>{v}</option>
                          ))}
                        </select>
                      </label>
                      {mm && f.moneyMeaning && mm !== f.moneyMeaning && (
                        <p role="alert" className="text-xs text-bad">
                          {props.moneyMeanings[mm]} cannot be used as {f.label.toLowerCase()}: it is a different measure of money.
                        </p>
                      )}
                    </div>
                  )}
                  {vals && vals.length > 0 && (
                    <table className="w-full text-xs">
                      <caption className="sr-only">Translations for {f.label}</caption>
                      <thead>
                        <tr className="text-left text-faint">
                          <th scope="col" className="py-1 pr-2 font-medium">Value in file</th>
                          <th scope="col" className="py-1 pr-2 text-right font-medium">Rows</th>
                          <th scope="col" className="py-1 font-medium">Means</th>
                        </tr>
                      </thead>
                      <tbody>
                        {vals.map((r) => {
                          const t = translation(f.key, r);
                          return (
                            <tr key={r.value} className="border-t border-border">
                              <td className="py-1 pr-2 font-mono">{r.value}</td>
                              <td className="py-1 pr-2 text-right tabular-nums">{r.rows}</td>
                              <td className="py-1">
                                <select
                                  aria-label={`${f.label} for "${r.value}"`}
                                  value={t}
                                  disabled={disabled}
                                  onChange={(e) => setValueMaps({ ...valueMaps, [f.key]: { ...(valueMaps[f.key] ?? {}), [r.value]: e.target.value } })}
                                  className={`max-w-full rounded border bg-surface px-1.5 py-0.5 ${t === LEAVE ? "border-warn" : "border-border"}`}
                                >
                                  <option value={LEAVE}>No match: quarantine these rows</option>
                                  {(f.kind === "branch" ? target.branches.map((b) => [b.id, `${b.id} · ${b.name}`]) : (f.values ?? []).map((v) => [v, v])).map(([v, l]) => (
                                    <option key={v} value={v}>{l}</option>
                                  ))}
                                </select>
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                  )}
                </div>
              </li>
            );
          })}
        </ol>
      )}

      {target && (askDateOrder || askLocalTime || dataset === "ad_spend") && (
        <fieldset className="space-y-3 rounded-lg border border-warn/40 bg-warn-soft p-3 text-sm" data-testid="mapping-questions">
          <legend className="px-1 text-sm font-semibold">Questions the file cannot answer</legend>
          {askDateOrder && (
            <div role="radiogroup" aria-label="Date order" className="flex flex-wrap items-center gap-3">
              <span>Dates like 03/04/2026 are</span>
              {(["MDY", "DMY"] as const).map((o) => (
                <label key={o} className="flex items-center gap-1">
                  <input type="radio" name={`${id}-order`} checked={dateOrder === o} disabled={disabled} onChange={() => setDateOrder(o)} />
                  {o === "MDY" ? "month first (March 4)" : "day first (3 April)"}
                </label>
              ))}
            </div>
          )}
          {askLocalTime && (
            <label className="flex items-start gap-2">
              <input type="checkbox" checked={localTime} disabled={disabled} onChange={(e) => setLocalTime(e.target.checked)} className="mt-1" />
              <span>Times without a time zone are in each row&apos;s branch local time (daylight saving applied; Arizona has none).</span>
            </label>
          )}
          {dataset === "ad_spend" && (
            <label className="flex flex-wrap items-center gap-2">
              <span>Report exported at (UTC)</span>
              <input type="datetime-local" value={exportedAt} disabled={disabled} onChange={(e) => setExportedAt(e.target.value)} className="rounded border border-border bg-surface px-2 py-1" />
            </label>
          )}
        </fieldset>
      )}

      {problems.length > 0 && (
        <div role="alert" className="rounded-lg border border-bad/30 bg-bad-soft p-3 text-sm" data-testid="mapping-problems">
          <p className="font-semibold">The mapping was saved as a draft, but it is not complete enough to dry-run:</p>
          <ul className="mt-1 list-disc pl-5">
            {problems.map((p, i) => (
              <li key={i}>{p.message}</li>
            ))}
          </ul>
        </div>
      )}
      {error && <p role="alert" className="text-sm text-bad">{error}</p>}
      {target && (
        <button type="submit" disabled={disabled} className="rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white hover:bg-accent-hover disabled:opacity-50" data-testid="propose-and-dry-run">
          {busy ? "Checking every row…" : "Save mapping version and dry-run"}
        </button>
      )}
    </form>
  );
}
