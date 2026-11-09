import { Badge } from "@/components/ui";
import type { InvestigationStep } from "@/lib/ai/steps";

/**
 * The tool trace: every step an investigation recorded, in order. Rendered on the server for a
 * finished investigation and by the question form while one streams in, so it uses no hooks.
 */

const STATUS_TONE = { ok: "good", error: "bad", forbidden: "warn", skipped: "neutral" } as const;
const KIND_LABEL: Record<InvestigationStep["kind"], string> = {
  tool_call: "tool",
  model_turn: "model",
  analysis: "analyst",
  proposal: "planner",
  warning: "warning",
};

function inputText(step: InvestigationStep): string {
  const entries = Object.entries(step.input ?? {});
  if (entries.length === 0) return "";
  return entries.map(([k, v]) => `${k}=${typeof v === "string" ? v : JSON.stringify(v)}`).join(" ");
}

export function TraceTable({ steps, live = false }: { steps: InvestigationStep[]; live?: boolean }) {
  if (steps.length === 0) {
    return <p className="text-sm text-muted">{live ? "Waiting for the first step…" : "No steps were recorded."}</p>;
  }
  return (
    <ol className="divide-y divide-border text-sm" aria-live={live ? "polite" : undefined} data-testid="tool-trace">
      {steps.map((s) => (
        <li key={s.seq} className="grid grid-cols-[2.5rem_1fr_auto] gap-x-3 gap-y-1 py-2">
          <span className="pt-0.5 text-right font-mono text-[11px] text-faint">{s.seq}</span>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <Badge tone={s.kind === "warning" ? "warn" : s.kind === "proposal" || s.kind === "analysis" ? "accent" : "neutral"}>{KIND_LABEL[s.kind]}</Badge>
              {s.tool && <span className="font-mono text-xs font-semibold">{s.tool}</span>}
              {inputText(s) && <span className="truncate font-mono text-[11px] text-muted" title={inputText(s)}>{inputText(s)}</span>}
            </div>
            <p className={`mt-1 break-words text-xs ${s.status === "ok" ? "text-text" : "text-muted"}`}>{s.outputSummary}</p>
            {s.evidenceIds.length > 0 && (
              <p className="mt-1 break-words font-mono text-[10px] text-faint">
                {s.evidenceIds.length} evidence id(s): {s.evidenceIds.slice(0, 8).join(" · ")}
                {s.evidenceIds.length > 8 ? " …" : ""}
              </p>
            )}
          </div>
          <div className="flex flex-col items-end gap-1">
            <Badge tone={STATUS_TONE[s.status]}>{s.status}</Badge>
            <span className="font-mono text-[10px] tabular-nums text-faint">{Math.round(s.ms)} ms</span>
          </div>
        </li>
      ))}
    </ol>
  );
}

export function ModeBadge({ mode, label }: { mode: "deterministic" | "model"; label: string }) {
  return (
    <span data-testid="mode-badge">
      <Badge tone={mode === "model" ? "accent" : "warn"}>{label}</Badge>
    </span>
  );
}
