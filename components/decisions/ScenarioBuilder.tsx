"use client";

import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import { LoaderCircle } from "lucide-react";
import type { ScenarioAssumptions, ScenarioResult } from "@/lib/decision/scenario";
import { ScenarioResultView } from "./ScenarioResultView";
import { usd } from "./fmt";

export interface ScenarioChannelOption {
  channelCode: string;
  label: string;
  /** Observed spend in the baseline period, scaled to 30 days. */
  monthlySpendCents: number;
}

const field = "w-full rounded border border-border bg-surface px-2 py-1 text-sm";

/**
 * Scenario builder: one budget shift at one branch, with its assumptions editable. "Run" asks
 * the server for a projection and stores nothing; "Save" stores the same request with its
 * result and the actor (audited). The server re-validates and re-checks permission and scope.
 */
export function ScenarioBuilder({
  branchId,
  periodKey,
  channels,
  defaultFrom,
  defaultTo,
  defaults,
}: {
  branchId: string;
  periodKey: "oct" | "sep" | "all";
  channels: ScenarioChannelOption[];
  defaultFrom: string;
  defaultTo: string;
  defaults: ScenarioAssumptions;
}) {
  const router = useRouter();
  const id = useId();
  const [from, setFrom] = useState(defaultFrom);
  const [to, setTo] = useState(defaultTo);
  const [amount, setAmount] = useState("500");
  const [elasticity, setElasticity] = useState(String(defaults.elasticity));
  const [sensitivity, setSensitivity] = useState(defaults.sensitivityElasticities.map(String));
  const [closeRate, setCloseRate] = useState(String(defaults.closeRateFactor));
  const [busy, setBusy] = useState<"run" | "save" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saved, setSaved] = useState<number | null>(null);
  const [result, setResult] = useState<ScenarioResult | null>(null);

  const fromChannel = channels.find((c) => c.channelCode === from);
  const dollars = Number(amount);
  const localProblem =
    !from || !to
      ? "Choose the two channels to compare. Nothing is preselected while this branch's budget recommendation is held."
      : from === to
      ? "Choose two different channels."
      : !Number.isFinite(dollars) || dollars <= 0
        ? "Enter a positive amount."
        : fromChannel && dollars * 100 > fromChannel.monthlySpendCents
          ? `${fromChannel.label} only spends ${usd(fromChannel.monthlySpendCents)} a month here.`
          : null;

  async function submit(save: boolean) {
    setBusy(save ? "save" : "run");
    setError(null);
    setSaved(null);
    try {
      const res = await fetch("/api/decisions/scenarios", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          branchId,
          period: periodKey,
          changes: [{ fromChannel: from, toChannel: to, amountCents: Math.round(dollars * 100) }],
          assumptions: {
            elasticity: Number(elasticity),
            sensitivityElasticities: sensitivity.map(Number),
            closeRateFactor: Number(closeRate),
          },
          save,
        }),
      });
      const body = await res.json();
      if (!res.ok) throw new Error(body.issues ? `${body.error}: ${body.issues.join("; ")}` : (body.error ?? `HTTP ${res.status}`));
      // A compute returns { result }; a save returns the stored scenario, which carries it too.
      setResult(body.result as ScenarioResult);
      if (save) {
        setSaved(body.id as number);
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
        className="space-y-3 text-sm"
        onSubmit={(e) => {
          e.preventDefault();
          void submit(false);
        }}
        data-testid="scenario-form"
      >
        <div className="grid gap-3 sm:grid-cols-3">
          <label className="space-y-1">
            <span className="block text-xs text-muted">Move budget from</span>
            <select value={from} onChange={(e) => setFrom(e.target.value)} className={field}>
              {!defaultFrom && <option value="">Choose a channel</option>}
              {channels.map((c) => (
                <option key={c.channelCode} value={c.channelCode}>
                  {c.label} ({usd(c.monthlySpendCents)}/mo)
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted">To</span>
            <select value={to} onChange={(e) => setTo(e.target.value)} className={field}>
              {!defaultTo && <option value="">Choose a channel</option>}
              {channels.map((c) => (
                <option key={c.channelCode} value={c.channelCode}>
                  {c.label} ({usd(c.monthlySpendCents)}/mo)
                </option>
              ))}
            </select>
          </label>
          <label className="space-y-1">
            <span className="block text-xs text-muted">Amount per month (USD)</span>
            <input type="number" min={1} step="any" required value={amount} onChange={(e) => setAmount(e.target.value)} className={field} />
          </label>
        </div>

        <fieldset className="rounded border border-border p-3">
          <legend className="px-1 text-xs font-medium text-muted">Assumptions</legend>
          <div className="grid gap-3 sm:grid-cols-3">
            <label className="space-y-1">
              <span className="block text-xs text-muted">Elasticity β (0–1]</span>
              <input type="number" min={0.05} max={1} step={0.05} required value={elasticity} onChange={(e) => setElasticity(e.target.value)} className={field} aria-describedby={`${id}-beta`} />
            </label>
            <div className="space-y-1">
              <span className="block text-xs text-muted">Sensitivity at β =</span>
              <div className="flex gap-1">
                {sensitivity.map((v, i) => (
                  <input
                    key={i}
                    type="number"
                    min={0.05}
                    max={1}
                    step={0.05}
                    required
                    aria-label={`Sensitivity elasticity ${i + 1} of 3`}
                    value={v}
                    onChange={(e) => setSensitivity(sensitivity.map((s, k) => (k === i ? e.target.value : s)))}
                    className={field}
                  />
                ))}
              </div>
            </div>
            <label className="space-y-1">
              <span className="block text-xs text-muted">Close rate of new leads (× history)</span>
              <input type="number" min={0.5} max={1.5} step={0.05} required value={closeRate} onChange={(e) => setCloseRate(e.target.value)} className={field} />
            </label>
          </div>
          <p id={`${id}-beta`} className="mt-2 text-[11px] text-faint">
            β = 1: every extra dollar buys customers at today&apos;s average cost. Lower β: diminishing returns. 1.0 close rate = close rates stay as they were.
          </p>
        </fieldset>

        {/* The form's footer: why it cannot run yet on the left; its actions on the right, the
            primary one last, where the eye ends (docs/design-system.md, "Decision Lab"). */}
        <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-border pt-3">
          <span className="min-w-0 text-xs text-warn">{localProblem}</span>
          <div className="ml-auto flex flex-wrap items-center gap-2">
            <button
              type="button"
              disabled={!!busy || !!localProblem}
              onClick={() => void submit(true)}
              className="inline-flex items-center gap-1.5 rounded-md border border-border px-3 py-1.5 hover:bg-surface-2 disabled:opacity-50"
            >
              {busy === "save" && <LoaderCircle aria-hidden className="size-3.5 animate-spin" />}
              {busy === "save" ? "Saving…" : "Save scenario"}
            </button>
            <button type="submit" disabled={!!busy || !!localProblem} className="inline-flex items-center gap-1.5 rounded-md bg-accent px-3 py-1.5 font-medium text-white hover:bg-accent-hover disabled:opacity-50">
              {busy === "run" && <LoaderCircle aria-hidden className="size-3.5 animate-spin" />}
              {busy === "run" ? "Projecting…" : "Run projection"}
            </button>
          </div>
        </div>
        {error && (
          <p role="alert" className="text-sm text-bad">
            {error}
          </p>
        )}
        {saved !== null && (
          <p role="status" className="text-sm text-good">
            Saved as scenario #{saved} (audited).
          </p>
        )}
      </form>

      <div aria-live="polite">
        {result ? (
          <ScenarioResultView result={result} />
        ) : (
          <p className="text-xs text-faint">Run a projection to see the forecast, its range and its sensitivity. Nothing is stored until you save.</p>
        )}
      </div>
    </div>
  );
}
