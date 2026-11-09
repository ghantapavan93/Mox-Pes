"use client";

import Link from "next/link";
import { useRouter } from "next/navigation";
import { useId, useState } from "react";
import type { InvestigationStep } from "@/lib/ai/steps";
import type { InvestigationStreamEvent } from "@/lib/ai/stream-events";
import { TraceTable } from "./TraceTable";

interface Suggestion {
  question: string;
  branchId: string | null;
  basis: string;
}

type RunState =
  | { state: "idle" }
  | { state: "running"; id: number | null; steps: InvestigationStep[] }
  | { state: "error"; id: number | null; steps: InvestigationStep[]; message: string };

/**
 * The question box. Submits to POST /api/investigations with `stream: true` and renders the
 * NDJSON trace as it arrives (each tool call, the analyst pass, the planner's proposals); when
 * the investigation finishes it opens the result page. If the stream breaks, the steps already
 * recorded are on the server and the result page is linked.
 */
export function InvestigateForm({
  branches,
  suggestions,
  initialQuestion,
  initialBranch,
  canInvestigate,
  denyReason,
}: {
  branches: Array<{ id: string; label: string }>;
  suggestions: Suggestion[];
  initialQuestion: string;
  initialBranch: string | null;
  canInvestigate: boolean;
  denyReason: string;
}) {
  const router = useRouter();
  const ids = { question: useId(), branch: useId(), help: useId() };
  const [question, setQuestion] = useState(initialQuestion);
  const [branch, setBranch] = useState(initialBranch ?? "");
  const [run, setRun] = useState<RunState>({ state: "idle" });
  const busy = run.state === "running";

  async function submit(e: { preventDefault(): void }) {
    e.preventDefault();
    if (!canInvestigate || busy || question.trim().length < 3) return;
    let id: number | null = null;
    const steps: InvestigationStep[] = [];
    setRun({ state: "running", id, steps: [] });
    try {
      const res = await fetch("/api/investigations", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ question: question.trim(), branchId: branch || null, stream: true }),
      });
      if (!res.ok || !res.body) {
        const body = (await res.json().catch(() => ({}))) as { error?: string; issues?: string[] };
        throw new Error([body.error ?? `HTTP ${res.status}`, ...(body.issues ?? [])].join(": "));
      }
      const reader = res.body.pipeThrough(new TextDecoderStream()).getReader();
      let buffer = "";
      for (;;) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += value;
        let newline: number;
        while ((newline = buffer.indexOf("\n")) >= 0) {
          const line = buffer.slice(0, newline).trim();
          buffer = buffer.slice(newline + 1);
          if (!line) continue;
          const event = JSON.parse(line) as InvestigationStreamEvent;
          if (event.type === "started") id = event.id;
          if (event.type === "step") steps.push(event.step);
          if (event.type === "error") throw new Error(event.message);
          if (event.type === "done") {
            router.push(`/investigator/${event.id}`);
            return;
          }
          setRun({ state: "running", id, steps: [...steps] });
        }
      }
      throw new Error("The stream ended before the investigation finished");
    } catch (error) {
      setRun({ state: "error", id, steps: [...steps], message: (error as Error).message });
    }
  }

  return (
    <div className="space-y-4">
      <form onSubmit={submit} className="space-y-3" aria-describedby={ids.help}>
        <div>
          <label htmlFor={ids.question} className="text-xs font-medium text-muted">
            Question
          </label>
          <textarea
            id={ids.question}
            name="question"
            value={question}
            onChange={(e) => setQuestion(e.target.value)}
            rows={3}
            maxLength={2000}
            disabled={!canInvestigate || busy}
            placeholder="Ask about a branch, a channel, a customer id or an exception"
            className="mt-1 w-full rounded border border-border bg-surface px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-60"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) void submit(e);
            }}
          />
        </div>
        <div className="flex flex-wrap items-end gap-3">
          <div>
            <label htmlFor={ids.branch} className="block text-xs font-medium text-muted">
              Scope
            </label>
            <select
              id={ids.branch}
              value={branch}
              onChange={(e) => setBranch(e.target.value)}
              disabled={!canInvestigate || busy}
              className="mt-1 rounded border border-border bg-surface px-2 py-1.5 text-sm"
            >
              <option value="">Branch named in the question (or my whole scope)</option>
              {branches.map((b) => (
                <option key={b.id} value={b.id}>
                  {b.label}
                </option>
              ))}
            </select>
          </div>
          <button
            type="submit"
            disabled={!canInvestigate || busy || question.trim().length < 3}
            className="rounded bg-accent px-4 py-1.5 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50"
          >
            {busy ? "Investigating…" : "Investigate"}
          </button>
          <span className="text-[11px] text-faint">Ctrl/⌘ + Enter</span>
        </div>
        <p id={ids.help} className="text-xs text-muted">
          {canInvestigate
            ? "Read-only: tools run with your role and branch scope. Fixes are proposed to the Action Center, never applied here."
            : denyReason}
        </p>
      </form>

      {suggestions.length > 0 && (
        <div>
          <p className="text-xs font-medium text-muted">Suggested from the data in your scope</p>
          <ul className="mt-2 flex flex-col gap-2">
            {suggestions.map((s) => (
              <li key={s.question}>
                <button
                  type="button"
                  disabled={!canInvestigate || busy}
                  onClick={() => {
                    setQuestion(s.question);
                    setBranch(s.branchId ?? "");
                  }}
                  className="w-full rounded border border-border px-3 py-2 text-left text-sm hover:bg-surface-2 focus:outline-none focus:ring-2 focus:ring-accent disabled:opacity-50"
                >
                  <span className="font-medium">{s.question}</span>
                  <span className="block text-[11px] text-faint">{s.basis}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}

      {run.state !== "idle" && (
        <section aria-label="Live tool trace" className="rounded border border-border bg-surface-2 p-3">
          <div className="mb-2 flex items-center justify-between gap-2 text-xs">
            <span className="font-semibold">
              {run.state === "running" ? "Running" : "Stopped"}
              {run.id ? ` · investigation #${run.id}` : ""}
            </span>
            {run.id && run.state === "error" && (
              <Link href={`/investigator/${run.id}`} className="text-accent hover:underline">
                Open what was recorded
              </Link>
            )}
          </div>
          {run.state === "error" && (
            <p role="alert" className="mb-2 rounded bg-bad-soft p-2 text-sm text-bad">
              {run.message}
            </p>
          )}
          <TraceTable steps={run.steps} live={run.state === "running"} />
        </section>
      )}
    </div>
  );
}
