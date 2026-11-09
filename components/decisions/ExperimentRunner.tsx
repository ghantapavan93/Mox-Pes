"use client";

import { useRouter } from "next/navigation";
import { useState } from "react";
import type { AaExperimentResult } from "@/lib/decision/experiment";
import { AaResultView } from "./AaResultView";

const field = "w-full rounded border border-border bg-surface px-2 py-1 text-sm";

async function readJson(res: Response) {
  const body = await res.json();
  if (!res.ok) throw new Error(body.issues ? `${body.error}: ${body.issues.join("; ")}` : (body.error ?? `HTTP ${res.status}`));
  return body;
}

/**
 * Re-runs the A/A analysis with another outcome window or salt (a GET: nothing stored) and, for
 * roles that may, records the current configuration as an experiment run (a POST: stored and
 * audited). A new salt re-randomizes every unit: the honest way to re-check an A/A result.
 */
export function ExperimentRunner({ initial, canRecord }: { initial: AaExperimentResult; canRecord: boolean }) {
  const router = useRouter();
  const [windowDays, setWindowDays] = useState(String(initial.config.windowDays));
  const [salt, setSalt] = useState(initial.config.salt);
  const [result, setResult] = useState<AaExperimentResult>(initial);
  const [busy, setBusy] = useState<"preview" | "record" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [recorded, setRecorded] = useState<number | null>(null);

  async function run(kind: "preview" | "record") {
    setBusy(kind);
    setError(null);
    setRecorded(null);
    try {
      if (kind === "preview") {
        const qs = new URLSearchParams({ period: initial.period.key, windowDays, salt });
        const body = await readJson(await fetch(`/api/decisions/experiments?${qs}`));
        setResult(body.live as AaExperimentResult);
      } else {
        const body = await readJson(
          await fetch("/api/decisions/experiments", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ period: initial.period.key, windowDays: Number(windowDays), salt }),
          }),
        );
        setResult(body.result as AaExperimentResult);
        setRecorded(body.id as number);
        router.refresh();
      }
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(null);
    }
  }

  return (
    <div className="space-y-4">
      <form
        className="flex flex-wrap items-end gap-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void run("preview");
        }}
      >
        <label className="w-40 space-y-1">
          <span className="block text-xs text-muted">Outcome window (days)</span>
          <input type="number" min={1} max={60} step={1} required value={windowDays} onChange={(e) => setWindowDays(e.target.value)} className={field} />
        </label>
        <label className="w-44 space-y-1">
          <span className="block text-xs text-muted">Assignment salt</span>
          <input type="text" required maxLength={60} value={salt} onChange={(e) => setSalt(e.target.value)} className={field} />
        </label>
        <button type="submit" disabled={!!busy} className="rounded border border-border px-3 py-1.5 hover:bg-surface-2 disabled:opacity-50">
          {busy === "preview" ? "Analysing…" : "Re-analyse (not stored)"}
        </button>
        {canRecord && (
          <button type="button" disabled={!!busy} onClick={() => void run("record")} className="rounded bg-text px-3 py-1.5 font-medium text-white disabled:opacity-50">
            {busy === "record" ? "Recording…" : "Record this run"}
          </button>
        )}
      </form>
      {!canRecord && <p className="text-xs text-faint">Recording a run needs the investigate permission (analyst, engineer, approver or partner role).</p>}
      {error && (
        <p role="alert" className="text-sm text-bad">
          {error}
        </p>
      )}
      {recorded !== null && (
        <p role="status" className="text-sm text-good">
          Recorded as experiment #{recorded} (audited).
        </p>
      )}
      <div aria-live="polite">
        <AaResultView result={result} />
      </div>
    </div>
  );
}
