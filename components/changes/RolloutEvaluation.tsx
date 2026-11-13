"use client";

import { useCallback, useEffect, useState } from "react";
import { Badge, Callout, EmptyState } from "@/components/ui";
import type { EvaluationView, StageRow } from "@/lib/twin/store";

type Variant = { id: string; label: string; description: string };
type Tone = "good" | "bad" | "warn" | "neutral" | "accent";

const GATE_MARK = { pass: "✓", fail: "✗", not_applicable: "–" } as const;
const kindOf = (s: StageRow) => (s.recovery as { kind?: string } | null)?.kind;

/** One label per state; "recovering" is said as what it is: resuming, or rolling back (review 2026-11-12, SRE M3). */
function result(s: StageRow, ev: EvaluationView): { label: string; tone: Tone } {
  switch (s.status) {
    case "PASSED":
      return { label: kindOf(s) === "resumed" ? "Passed · after a resume" : "Passed", tone: "good" };
    case "FAILED":
      return { label: kindOf(s) === "rollback" ? "Failed · rollback not verified" : "Failed", tone: "bad" };
    case "RECOVERED":
      return { label: "Failed · rolled back", tone: "warn" };
    case "RECOVERING":
      return kindOf(s) === "rollback" ? { label: "Rolling back", tone: "accent" } : { label: "Resuming", tone: "accent" };
    case "RUNNING":
      return ev.stale ? { label: "Interrupted", tone: "warn" } : { label: "Running", tone: "accent" };
    case "INTERRUPTED":
      return { label: "Stopped mid-way", tone: "warn" };
    case "BLOCKED":
      return { label: "Not run: blocked", tone: "neutral" };
    case "PENDING":
      return { label: ev.status === "RUNNING" ? "Not started" : "Not run", tone: "neutral" };
  }
}

const time = (iso: string | null) => (iso ? new Date(iso).toLocaleTimeString("en-US", { hour: "2-digit", minute: "2-digit", second: "2-digit" }) : "—");
const seconds = (ms: unknown) => (typeof ms === "number" ? `${(ms / 1000).toFixed(1)} s` : "—");
const firstSentence = (text: string) => text.split(/(?<=\.)\s/)[0];

function finding(s: StageRow, ev: EvaluationView): string {
  if (s.status === "BLOCKED") {
    const failed = ev.stages.find((x) => x.status === "FAILED" || x.status === "RECOVERED");
    return `Never executed: stage ${failed?.key ?? "?"} (${failed?.label ?? ""}) failed a gate, and a failed gate stops the rollout.`;
  }
  if (s.status === "PENDING") return ev.status === "RUNNING" ? "Waiting for the stage before it." : "Never executed: the evaluation stopped before this stage.";
  if (s.status === "INTERRUPTED" || (s.status === "RUNNING" && ev.stale)) {
    return `Stopped mid-way after ${Object.keys(s.steps).join(", ") || "no step"}. Those steps are applied in the twin and were not rolled back; no gate ran, so there is no verdict.`;
  }
  if (s.status === "RUNNING" || s.status === "RECOVERING") return `In progress. Done so far: ${Object.keys(s.steps).join(", ") || "nothing yet"}.`;
  const failed = s.gates.filter((g) => g.status === "fail");
  // Name the failed gate as what went wrong, not as the property it checks (review 2026-11-12, design L1).
  if (failed.length > 0) return failed.map((g) => `Gate ${g.id} failed (${g.label.toLowerCase()} did not hold): ${firstSentence(g.detail)}`).join(" ");
  const a = s.evidence.attribution as { changed?: number; paidToUnpaid?: number; unpaidToPaid?: number } | undefined;
  const cac = s.gates.find((g) => g.id === "G")?.detail ?? "";
  const f1 = s.gates.find((g) => g.id === "F1")?.detail.split(";")[0] ?? "";
  return `${a?.changed ?? 0} customer credit(s) moved (${a?.paidToUnpaid ?? 0} off a paid channel, ${a?.unpaidToPaid ?? 0} back onto one). ${cac.split(":")[0]}. ${f1}.${kindOf(s) === "resumed" ? " Resumed after the runner was lost." : ""}`;
}

function StageDetails({ s, twinDropped }: { s: StageRow; twinDropped: boolean }) {
  const evidence = s.evidence as Record<string, unknown>;
  const contract = evidence.contract as { from?: string[]; to?: string; routing?: string } | undefined;
  const inputs = evidence.inputs as { delivered?: Record<string, number>; reprojected?: number } | undefined;
  const attribution = evidence.attribution as { changed: number; inPeriod: number; paidToUnpaid: number; unpaidToPaid: number; outsideStage: number; sample: Array<{ customerId: number; branchId: string | null; fromChannel: string; toChannel: string; fromLeadBranch: string | null }> } | undefined;
  const refs = evidence.references as Record<string, unknown> | undefined;
  const recovery = s.recovery as Record<string, unknown> | null;
  const restored = recovery?.restoredBusinessState as { verified?: boolean; detail?: string; recordsStillOnNewVersion?: number; heldUnreadable?: number } | undefined;
  const preserved = recovery?.preservedAuditHistory as { verified?: boolean; detail?: string } | undefined;
  const metrics = s.metrics as { stepMs?: Record<string, number>; stageMs?: number; oracleMs?: number; scorecardMs?: { before: number; after: number }; peakRssMb?: number; msPerNewBranch?: number; records?: Record<string, number>; db?: Record<string, number>; retryOverhead?: Record<string, number> | null };
  return (
    <div className="space-y-4 border-t border-border pt-3 text-xs" data-testid={`stage-details-${s.key}`}>
      <section>
        <h3 className="font-semibold text-text">Inputs and contract</h3>
        <p className="text-muted">
          {contract ? `${contract.from?.join(", ")} → ${contract.to}. ${contract.routing}.` : "Not started."} New branches in this stage: {s.newBranchIds.length <= 8 ? s.newBranchIds.join(", ") : `${s.newBranchIds.length}`}. Stored calls re-projected: {inputs?.reprojected ?? "—"}. Delivered during the stage:{" "}
          {inputs?.delivered ? Object.entries(inputs.delivered).map(([k, n]) => `${n} ${k}`).join(", ") : "—"} (each sent twice).
        </p>
      </section>
      <section>
        <h3 className="font-semibold text-text">Gates</h3>
        <ul className="space-y-1" aria-label={`Stage ${s.key} gates`}>
          {s.gates.map((g) => (
            <li key={g.id} className="flex gap-2" data-gate={g.id} data-status={g.status}>
              <span aria-hidden className={`w-3 flex-none font-bold ${g.status === "fail" ? "text-bad" : g.status === "pass" ? "text-good" : "text-faint"}`}>{GATE_MARK[g.status]}</span>
              <span className="min-w-0">
                <span className="font-medium text-text">{g.id} · {g.label}</span>
                {g.status === "fail" ? <span className="font-medium text-bad"> — did not hold</span> : <span className="sr-only"> {g.status.replace("_", " ")}</span>}
                <span className="block break-words text-muted">{g.detail}</span>
              </span>
            </li>
          ))}
        </ul>
      </section>
      {attribution && (
        <section>
          <h3 className="font-semibold text-text">Attribution changes</h3>
          <p className="text-muted">
            {attribution.changed} customer credit(s) moved because of this stage&apos;s mapper ({attribution.inPeriod} counted in Sept–Oct): {attribution.paidToUnpaid} left a paid channel, {attribution.unpaidToPaid} returned to one, {attribution.outsideStage} belong to a branch outside the stage.
          </p>
          {attribution.sample.length > 0 && (
            <div className="mt-1 overflow-x-auto" role="region" aria-label={`Stage ${s.key} attribution changes`} tabIndex={0}>
              <table className="w-full min-w-[300px] text-left">
                <thead className="text-faint">
                  <tr><th className="py-0.5 font-medium">Customer</th><th className="py-0.5 font-medium">Branch</th><th className="py-0.5 font-medium">Credit before → after</th></tr>
                </thead>
                <tbody>
                  {attribution.sample.slice(0, 12).map((c) => (
                    <tr key={c.customerId} className="border-t border-border">
                      <td className="py-0.5 tabular-nums">{c.customerId}</td>
                      <td className="py-0.5">{c.branchId ?? "—"}</td>
                      <td className="py-0.5">{c.fromChannel}{c.fromLeadBranch && c.fromLeadBranch !== c.branchId ? ` (call at ${c.fromLeadBranch})` : ""} → {c.toChannel}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
      <section>
        <h3 className="font-semibold text-text">Branches</h3>
        <p className="text-muted">
          Affected: {((evidence.affected as string[] | undefined) ?? s.branchIds).join(", ")}. Unaffected (outside the stage, unchanged): {((evidence.unaffected as string[] | undefined) ?? []).length} branch(es).
        </p>
      </section>
      {recovery && (
        <section data-testid={`stage-recovery-${s.key}`}>
          <h3 className="font-semibold text-text">Recovery</h3>
          {recovery.kind === "rollback" ? (
            <dl className="grid gap-x-3 gap-y-1 text-muted sm:grid-cols-[max-content_1fr]">
              <dt className="font-medium text-text">What was done</dt>
              <dd>{String(recovery.action ?? "In progress.")}</dd>
              <dt className="font-medium text-text">Restored business state</dt>
              <dd>{restored ? `${restored.verified ? "Verified." : "NOT verified."} ${restored.detail}` : "—"}</dd>
              <dt className="font-medium text-text">Not restored</dt>
              <dd>
                {restored
                  ? `${restored.recordsStillOnNewVersion ?? 0} stored record(s) still read by the new mapper; ${restored.heldUnreadable ?? 0} record(s) neither mapper can read stay held for replay (they never counted).`
                  : "—"}
              </dd>
              <dt className="font-medium text-text">Preserved audit history</dt>
              <dd>{preserved ? `${preserved.verified ? "Verified." : "NOT verified."} ${preserved.detail}` : "—"}</dd>
              <dt className="font-medium text-text">Effects a rollback cannot reverse</dt>
              <dd>{String((recovery.unreversedExternalEffects as { inTwin?: string } | undefined)?.inTwin ?? "—")} {((recovery.unreversedExternalEffects as { inProduction?: string[] } | undefined)?.inProduction ?? []).join(" ")}</dd>
              <dt className="font-medium text-text">Not checked</dt>
              <dd>{((recovery.unverified as string[] | undefined) ?? []).join(" ")}</dd>
            </dl>
          ) : (
            <p className="text-muted">
              The runner was lost after a step committed and before it was acknowledged ({((recovery.interruptions as Array<{ acknowledgedSteps: string[] }> | undefined) ?? []).map((i) => `acknowledged then: ${i.acknowledgedSteps.join(", ") || "none"}`).join("; ")}). A new runner resumed from durable state and re-ran {((recovery.resumedSteps as string[] | undefined) ?? []).join(", ")}; gate F2 says what that changed.
            </p>
          )}
        </section>
      )}
      {metrics.stepMs && (
        <section>
          <h3 className="font-semibold text-text">Measured</h3>
          <p className="text-muted">
            Stage {seconds(metrics.stageMs)} ({Object.entries(metrics.stepMs).map(([k, v]) => `${k} ${seconds(v)}`).join(", ")}); {seconds(metrics.msPerNewBranch)} per new branch; reference {seconds(metrics.oracleMs)}; 44-branch scorecard query {metrics.scorecardMs ? `${metrics.scorecardMs.before} → ${metrics.scorecardMs.after} ms` : "—"}; peak memory {metrics.peakRssMb ?? "—"} MB.
            Records: {metrics.records ? Object.entries(metrics.records).map(([k, v]) => `${v} ${k}`).join(", ") : "—"}. Database: {metrics.db ? `${metrics.db.xact_commit} commits, ${metrics.db.tup_inserted} rows inserted, ${metrics.db.tup_updated} updated` : "—"}.
            {metrics.retryOverhead ? ` Retries: ${metrics.retryOverhead.retriesScheduled}, ${seconds(metrics.retryOverhead.simulatedWaitMs)} waited (simulated clock).` : ""}
          </p>
        </section>
      )}
      {refs && (
        <section>
          <h3 className="font-semibold text-text">Evidence references</h3>
          <p className="break-words text-muted">
            Twin database <code>{String(refs.twinDatabase)}</code>{twinDropped ? " (deleted: only the three most recent twins are kept; the figures above stay on record)" : ""}; replays {((refs.replayKeys as string[]) ?? []).map((k) => <code key={k} className="mr-1">{k}</code>)}; sync request <code>{String(refs.syncRequestKey)}</code>, jobs {((refs.syncJobIds as number[]) ?? []).length}; raw events {((refs.rawEventIds as number[]) ?? []).join("–") || "none added"}.
          </p>
        </section>
      )}
    </div>
  );
}

export function RolloutEvaluation({ changeId, initial, canRun, variants }: { changeId: number; initial: EvaluationView[]; canRun: boolean; variants: Variant[] }) {
  const [evaluations, setEvaluations] = useState<EvaluationView[]>(initial);
  const [selected, setSelected] = useState<number | null>(initial[0]?.id ?? null);
  const [variant, setVariant] = useState(variants[0]?.id ?? "standard");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const current = evaluations.find((e) => e.id === selected) ?? evaluations[0] ?? null;
  // Any evaluation still RUNNING blocks a new start (the server refuses it too; review 2026-11-12, design M2).
  const anyRunning = evaluations.some((e) => e.status === "RUNNING");
  const live = evaluations.some((e) => e.status === "RUNNING" && !e.stale);

  const refresh = useCallback(async () => {
    try {
      const res = await fetch(`/api/changes/${changeId}/rollout`, { cache: "no-store" });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setEvaluations(json.evaluations);
      setError(null);
    } catch (err) {
      setError(`Could not load the evaluation: ${(err as Error).message}. Retrying.`);
    }
  }, [changeId]);

  useEffect(() => {
    if (!live) return;
    const timer = setInterval(refresh, 2500);
    return () => clearInterval(timer);
  }, [live, refresh]);

  async function post(body: Record<string, unknown>) {
    setBusy(true);
    setError(null);
    try {
      const res = await fetch(`/api/changes/${changeId}/rollout`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const json = await res.json();
      if (!res.ok) throw new Error(json.error ?? `HTTP ${res.status}`);
      setSelected(json.evaluationId);
      await refresh();
    } catch (err) {
      setError((err as Error).message);
    } finally {
      setBusy(false);
    }
  }

  const twinDropped = Boolean(current?.summary.twinDropped);
  const failedStage = current?.stages.find((s) => s.status === "FAILED" || s.status === "RECOVERED");
  const runningStage = current?.stages.find((s) => s.status === "RUNNING" || s.status === "RECOVERING");
  const stoppedStage = current?.stages.find((s) => s.status === "INTERRUPTED");
  const actionButton = (label: string, body: Record<string, unknown>, testId: string) => (
    <button type="button" disabled={busy} onClick={() => post(body)} className="h-8 rounded-md border border-border-strong bg-surface px-3 text-sm font-medium" data-testid={testId}>
      {label}
    </button>
  );
  return (
    <div className="space-y-3" data-testid="rollout-evaluation">
      <p className="text-muted">
        A simulation, not a deployment. Each stage runs the production intake, re-projection, CRM sync worker and reconciliation against an isolated copy of the synthetic world, then checks the result against an independent reference. The product cannot activate a mapper for some branches only: a mapper version is chosen for every branch at once, by a code deploy. Nothing here changes that.
      </p>
      {canRun && (
        <div className="flex flex-wrap items-end gap-2">
          <label className="text-xs font-medium text-text">
            Scenario
            <select value={variant} onChange={(e) => setVariant(e.target.value)} className="ml-2 h-8 rounded-md border border-border-strong bg-surface px-2 text-sm" data-testid="rollout-variant">
              {variants.map((v) => <option key={v.id} value={v.id}>{v.label}</option>)}
            </select>
          </label>
          <button type="button" disabled={busy || anyRunning} onClick={() => post({ variant })} className="h-8 rounded-md bg-text px-3 text-sm font-medium text-white disabled:opacity-50" data-testid="rollout-run">
            {live ? "Evaluation running…" : anyRunning ? "An evaluation is unfinished" : "Run staged evaluation"}
          </button>
          <p className="w-full text-[11px] text-faint">{variants.find((v) => v.id === variant)?.description}</p>
        </div>
      )}
      {error && <p role="alert" className="text-xs text-bad">{error}</p>}
      {!current ? (
        <EmptyState title="Not evaluated yet" testId="rollout-empty">{canRun ? "Run a staged evaluation to see each stage's gates." : "An integration engineer or analyst with every branch in scope can run one."}</EmptyState>
      ) : (
        <>
          <div className="flex flex-wrap items-center gap-2 text-xs text-muted" data-testid="rollout-header">
            <span className="font-medium text-text">Evaluation #{current.id}</span>
            <Badge tone={current.status === "PASSED" ? "good" : current.status === "FAILED" ? "warn" : current.status === "ERROR" ? "bad" : current.stale ? "warn" : "accent"}>
              {current.status === "PASSED" ? "All stages passed (simulated)" : current.status === "FAILED" ? "Stopped at a failed gate" : current.status === "ERROR" ? "Evaluation error: no verdict" : current.stale ? "Runner not responding" : current.stalled ? "Not progressing" : "Running"}
            </Badge>
            {current.outdated && <Badge tone="warn">Outdated: the code has changed since</Badge>}
            <span>{variants.find((v) => v.id === current.variant)?.label ?? current.variant}</span>
            <span>· started {time(current.startedAt)}{current.finishedAt ? `, finished ${time(current.finishedAt)}` : ""}</span>
            {current.scenarioHash && <span>· scenario <code>{current.scenarioHash.slice(0, 10)}</code></span>}
            {current.codeFingerprint && <span>· code <code>{current.codeFingerprint.slice(0, 10)}</code></span>}
          </div>
          <div role="status" aria-live="polite" className="text-xs">
            {current.status === "RUNNING" && !current.stale && !current.stalled && <p className="text-accent">Running {runningStage ? `stage ${runningStage.key} (${runningStage.label})` : "the world setup"}; this page updates by itself.</p>}
          </div>
          {current.status === "RUNNING" && current.stale && (
            <Callout tone="warn" title="The runner stopped responding" testId="rollout-stale" action={canRun && actionButton("Resume", { resume: current.id }, "rollout-resume")}>
              Last heard from at {time(current.heartbeatAt)}. Its acknowledged steps are durable; resuming continues from them. Nothing after the last acknowledged step is assumed done.
            </Callout>
          )}
          {current.status === "RUNNING" && current.stalled && (
            <Callout tone="warn" title="The runner is alive but not progressing" testId="rollout-stalled" action={canRun && actionButton("Abandon", { abandon: current.id }, "rollout-abandon")}>
              No step has started or finished since {time(current.progressAt)}. Abandoning ends the evaluation with no verdict and stops its runner at its next write; the stage in progress is marked stopped mid-way.
            </Callout>
          )}
          {current.status === "ERROR" && (
            <Callout tone="bad" title="The evaluation stopped with an error: no verdict" testId="rollout-error" action={canRun && <div className="flex gap-2">{!twinDropped && !current.outdated && actionButton("Resume", { resume: current.id }, "rollout-resume")}{actionButton("Run again", { variant: current.variant }, "rollout-rerun")}</div>}>
              {current.error ?? "Unknown error"}.{" "}
              {stoppedStage ? `Stage ${stoppedStage.key} (${stoppedStage.label}) stopped mid-way: its finished steps (${Object.keys(stoppedStage.steps).join(", ") || "none"}) are applied in the twin and were not rolled back.` : ""} Resume continues from the acknowledged steps; Run again starts a fresh twin.
            </Callout>
          )}
          {current.status === "FAILED" && failedStage && (
            <Callout tone="warn" title={`Rollout stopped at stage ${failedStage.key} (${failedStage.label})`} testId="rollout-stopped">
              {failedStage.gates.filter((g) => g.status === "fail").map((g) => `Gate ${g.id} failed: ${g.label.toLowerCase()} did not hold. ${firstSentence(g.detail)}`).join(" ")} Later stages were never run.{" "}
              {failedStage.status === "RECOVERED" ? "The stage was rolled back and the restored state was verified against the reference." : "Its rollback is not verified."} Nothing is promoted automatically: a new evaluation is a new decision.
            </Callout>
          )}
          {current.status === "PASSED" && (
            <Callout tone="good" title="Every stage passed its gates in the simulation" testId="rollout-passed">
              1, 5 and 44 synthetic branches. This shows the rollout procedure is correct on this world; it is not evidence that 44 real branches are ready.
            </Callout>
          )}
          <div className="sm:overflow-x-auto" role="region" aria-label="Rollout stages" tabIndex={0}>
            {/* Fixed layout from sm up: the finding column takes the rest and wraps. On a phone each stage is a stacked block (review 2026-11-12, design M5). */}
            <table className="block w-full border-collapse text-left text-sm sm:table sm:min-w-[340px] sm:table-fixed" data-testid="rollout-stages">
              <thead className="hidden sm:table-header-group">
                <tr className="text-[11px] uppercase tracking-wide text-faint">
                  <th scope="col" className="w-24 border-b border-border py-2 pr-3 font-semibold">Stage</th>
                  <th scope="col" className="w-40 border-b border-border py-2 pr-3 font-semibold">Result</th>
                  <th scope="col" className="border-b border-border py-2 font-semibold">Important finding</th>
                </tr>
              </thead>
              <tbody className="block sm:table-row-group">
                {current.stages.map((s) => {
                  const r = result(s, current);
                  return (
                    <tr key={s.ordinal} className="block border-b border-border py-2 align-top sm:table-row sm:py-0" data-stage={s.key} data-status={s.status}>
                      <td className="block font-medium sm:table-cell sm:whitespace-nowrap sm:border-b sm:border-border sm:py-2 sm:pr-3">{s.label}</td>
                      <td className="block py-1 sm:table-cell sm:border-b sm:border-border sm:py-2 sm:pr-3"><Badge tone={r.tone} dot>{r.label}</Badge></td>
                      <td className="block min-w-0 [overflow-wrap:anywhere] sm:table-cell sm:border-b sm:border-border sm:py-2">
                        <p className="text-muted">{finding(s, current)}</p>
                        {s.gates.length > 0 && (
                          <details className="mt-1">
                            <summary className="cursor-pointer text-xs text-accent">Gates, inputs, recovery and evidence</summary>
                            <StageDetails s={s} twinDropped={twinDropped} />
                          </details>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
          {evaluations.length > 1 && (
            <div className="text-xs text-muted">
              Earlier evaluations:{" "}
              {evaluations.map((e) => (
                <button key={e.id} type="button" onClick={() => setSelected(e.id)} className={`mr-2 underline-offset-2 hover:underline ${e.id === current.id ? "font-semibold text-text" : "text-accent"}`} aria-pressed={e.id === current.id}>
                  #{e.id} {e.status.toLowerCase()}
                </button>
              ))}
            </div>
          )}
        </>
      )}
    </div>
  );
}
