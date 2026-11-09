import { z } from "zod";
import { ActionError } from "@/lib/actions";
import type { Queryable } from "@/lib/db";
import { ForbiddenError } from "@/lib/viewer";
import type { InjectionWarning } from "./contract";
import { scanForInstructions } from "./injection";
import { TOOLS, isToolName, type ToolContext } from "./tools";

/**
 * The investigation trace. Every tool call, model turn, analyst pass and planner decision is
 * written to investigation_steps as it happens (so a poller sees progress) and handed to an
 * optional listener (so the NDJSON route can stream it).
 */

export type StepStage = "investigator" | "analyst" | "planner";
export type StepKind = "tool_call" | "model_turn" | "analysis" | "proposal" | "warning";
export type StepStatus = "ok" | "error" | "forbidden" | "skipped";

export interface InvestigationStep {
  seq: number;
  stage: StepStage;
  kind: StepKind;
  tool: string | null;
  input: Record<string, unknown>;
  outputSummary: string;
  output: unknown;
  evidenceIds: string[];
  status: StepStatus;
  error: string | null;
  ms: number;
  at: string;
}

/** Stored outputs are bounded: a tool that returns more than this keeps only its summary. */
const MAX_STORED_OUTPUT_CHARS = 60_000;

export class StepRecorder {
  readonly steps: InvestigationStep[] = [];
  /** Every evidence id a tool returned in this run: the grounding set. */
  readonly returnedEvidence = new Set<string>();
  readonly warnings: InjectionWarning[] = [];
  private seq = 0;

  constructor(
    private readonly db: Queryable,
    readonly investigationId: number,
    private readonly now: Date,
    private readonly listener?: (step: InvestigationStep) => void,
  ) {}

  async record(step: Omit<InvestigationStep, "seq" | "at">): Promise<InvestigationStep> {
    const full: InvestigationStep = { ...step, seq: ++this.seq, at: this.now.toISOString() };
    const output = boundedOutput(full.output);
    await this.db.query(
      `insert into investigation_steps (investigation_id, seq, stage, kind, tool, input, output_summary, output, evidence_ids, status, error, ms, at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)`,
      [
        this.investigationId, full.seq, full.stage, full.kind, full.tool, full.input, full.outputSummary.slice(0, 2000),
        output === undefined ? null : JSON.stringify(output), full.evidenceIds, full.status, full.error, Math.max(0, Math.round(full.ms)), this.now,
      ],
    );
    this.steps.push(full);
    this.listener?.(full);
    return full;
  }
}

function boundedOutput(output: unknown): unknown {
  if (output === undefined || output === null) return output;
  const json = JSON.stringify(output);
  return json.length > MAX_STORED_OUTPUT_CHARS ? { truncated: true, chars: json.length } : output;
}

export interface ToolExecution {
  status: "ok" | "error" | "forbidden";
  data: unknown;
  evidenceIds: string[];
  summary: string;
  error: string | null;
  warnings: InjectionWarning[];
}

/**
 * Validates and runs one registry tool for the viewer, records the step, adds its evidence to
 * the grounding set and scans its output for instruction-like text. Never throws for a tool
 * failure: a refusal (scope) or error is a result the investigator has to reason about, and it
 * is in the trace either way. Unexpected errors (database down) propagate.
 */
export async function executeTool(ctx: ToolContext, recorder: StepRecorder, name: string, rawInput: unknown): Promise<ToolExecution> {
  const started = performance.now();
  const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>;
  const fail = async (status: "error" | "forbidden", message: string): Promise<ToolExecution> => {
    await recorder.record({
      stage: "investigator", kind: "tool_call", tool: name, input, outputSummary: message, output: null,
      evidenceIds: [], status, error: message, ms: performance.now() - started,
    });
    return { status, data: null, evidenceIds: [], summary: message, error: message, warnings: [] };
  };
  if (!isToolName(name)) return fail("error", `Unknown tool "${name}"`);
  const tool = TOOLS[name];
  let output;
  try {
    const parsed = tool.input.parse(rawInput ?? {});
    // The registry's union of tool signatures cannot be narrowed by name; the zod parse above is
    // what guarantees `parsed` is that tool's input.
    output = await (tool.run as (c: ToolContext, i: unknown) => ReturnType<typeof tool.run>)(ctx, parsed);
  } catch (error) {
    if (error instanceof ForbiddenError) return fail("forbidden", error.message);
    if (error instanceof ActionError) return fail("error", error.message);
    if (error instanceof z.ZodError) return fail("error", `Invalid input: ${error.issues.map((i) => `${i.path.join(".") || "input"}: ${i.message}`).join("; ")}`);
    throw error;
  }
  for (const id of output.evidenceIds) recorder.returnedEvidence.add(id);
  await recorder.record({
    stage: "investigator", kind: "tool_call", tool: name, input, outputSummary: output.summary, output: output.data,
    evidenceIds: output.evidenceIds, status: "ok", error: null, ms: performance.now() - started,
  });
  const warnings = scanForInstructions(name, output.data);
  for (const w of warnings) {
    recorder.warnings.push(w);
    console.warn(JSON.stringify({ level: "warn", msg: "instruction-like text in tool data ignored", investigationId: recorder.investigationId, ...w }));
    await recorder.record({
      stage: "investigator", kind: "warning", tool: null, input: { tool: w.tool, path: w.path, pattern: w.pattern },
      outputSummary: `Ignored instruction-like text in ${w.tool} output at ${w.path}: "${w.excerpt}"`, output: null,
      evidenceIds: [], status: "ok", error: null, ms: 0,
    });
  }
  return { status: "ok", data: output.data, evidenceIds: output.evidenceIds, summary: output.summary, error: null, warnings };
}
