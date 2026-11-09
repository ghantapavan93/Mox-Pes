import type { Pool } from "pg";
import { ActionError } from "@/lib/actions";
import { getNow } from "@/lib/db";
import { BRANCH_BY_ID } from "@/lib/reference";
import { requirePermission, resolveScope, type Viewer } from "@/lib/viewer";
import { groundDraft } from "./analyst";
import { InvestigationResultSchema, MODE_LABEL, type DraftFindings, type InvestigationResult } from "./contract";
import { ACTION_REFUSAL, detectIntent, runDeterministic, type PlanContext } from "./deterministic";
import { MODEL_ID, anthropicModelClient, costMicros, runModelInvestigator, type ModelClient, type TokenUsage } from "./model";
import { planProposals } from "./planner";
import { StepRecorder, executeTool, type InvestigationStep } from "./steps";
import type { ToolContext, ToolData, ToolName } from "./tools";

/**
 * One investigation, end to end:
 *
 *   permission + scope → investigations row (running) → investigator (model tool loop, or the
 *   deterministic plan) → analyst (grounding + classification) → planner (Action Center
 *   proposals, source 'ai') → validated result stored (completed) → audit.
 *
 * Every step is written to investigation_steps as it happens and passed to `onStep`, which is
 * how the NDJSON route streams the live trace. A failure marks the row failed (with the error)
 * and is rethrown; the steps recorded so far stay, so a failed run is still explainable.
 */

export interface RunInvestigationInput {
  question: string;
  /** Branch the viewer asked about; must be in the viewer's scope. Null = the whole scope. */
  branchId: string | null;
  viewer: Viewer;
  /** "deterministic" forces the no-model path; "auto" uses the model when a client is available. */
  mode?: "auto" | "deterministic";
  /** Injected model client (tests, evaluation); undefined = the configured production client. */
  client?: ModelClient | null;
  /** Business clock; defaults to app_clock. */
  now?: Date;
  onStart?: (info: { id: number; mode: "deterministic" | "model" }) => void;
  onStep?: (step: InvestigationStep) => void;
  /** Model loop bounds (tests use small ones). */
  limits?: { maxToolCalls?: number; maxTurns?: number; timeoutMs?: number };
}

export interface InvestigationOutcome {
  id: number;
  status: "completed";
  mode: "deterministic" | "model";
  result: InvestigationResult;
  steps: InvestigationStep[];
  usage: TokenUsage;
  costMicros: number;
  latencyMs: number;
}

const QUESTION_MAX = 2000;

export async function runInvestigation(pool: Pool, input: RunInvestigationInput): Promise<InvestigationOutcome> {
  requirePermission(input.viewer, "investigate", "run investigations");
  const question = input.question.trim().replace(/\s+/g, " ");
  if (question.length < 3) throw new ActionError("Ask a question of at least 3 characters", 400);
  if (question.length > QUESTION_MAX) throw new ActionError(`Questions are limited to ${QUESTION_MAX} characters`, 400);
  if (input.branchId !== null) {
    if (!BRANCH_BY_ID.has(input.branchId)) throw new ActionError(`Unknown branch ${input.branchId}`, 400);
    resolveScope(input.viewer, input.branchId);
  }

  const started = performance.now();
  const now = input.now ?? (await getNow(pool));
  const client = input.mode === "deterministic" ? null : input.client !== undefined ? input.client : anthropicModelClient();
  let mode: "deterministic" | "model" = client ? "model" : "deterministic";
  const actor = input.viewer.role;

  const { rows } = await pool.query<{ id: string }>(
    `insert into investigations (question, branch_id, scope_branch_ids, actor, mode, model, status, created_at)
     values ($1, $2, $3, $4, $5, $6, 'running', $7) returning id`,
    [question, input.branchId, input.viewer.branchIds, actor, mode, mode === "model" ? MODEL_ID : null, now],
  );
  const id = Number(rows[0].id);
  await audit(pool, now, actor, "investigation_start", id, { question, branchId: input.branchId, mode });
  input.onStart?.({ id, mode });

  const recorder = new StepRecorder(pool, id, now, input.onStep);
  const toolCtx: ToolContext = { db: pool, viewer: input.viewer, now };
  const detected = detectIntent(question, input.viewer, input.branchId);
  const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  try {
    let draft: DraftFindings | null = null;
    let intent: string = detected.intent;
    let refusal: string | null = null;

    if (client) {
      const run = await runModelInvestigator({
        client, question, requestedBranch: input.branchId, viewer: input.viewer, toolCtx, recorder, ...input.limits,
      });
      Object.assign(usage, run.usage);
      draft = run.draft;
      if (!draft) {
        // The model path failed (API error, refusal, budget). Fall back to the deterministic
        // investigator over the same tools, and say so: the stored mode is what actually answered.
        await recorder.record({
          stage: "investigator", kind: "model_turn", tool: null, input: {}, outputSummary: `Model path ended without findings (${run.error}); falling back to the deterministic investigator`,
          output: null, evidenceIds: [], status: "error", error: run.error, ms: 0,
        });
        mode = "deterministic";
      } else {
        refusal = detected.actionRequest ? ACTION_REFUSAL : null;
      }
    }
    if (!draft) {
      const outcome = await runDeterministic(planContext(toolCtx, recorder), question, input.branchId);
      draft = outcome.draft;
      intent = outcome.intent;
      refusal = outcome.refusal;
    }

    // Analyst: ground every claim in this run's tool evidence, classify, adjust confidence.
    const analystStarted = performance.now();
    const grounded = groundDraft(draft, recorder.returnedEvidence);
    await recorder.record({
      stage: "analyst", kind: "analysis", tool: null, input: { claims: grounded.report.claimsIn },
      outputSummary: `Kept ${grounded.report.claimsKept} of ${grounded.report.claimsIn} claim(s); dropped ${grounded.report.claimsDropped} unsupported; downgraded ${grounded.report.downgraded}; ${recorder.returnedEvidence.size} evidence id(s) returned by tools`,
      output: grounded.report, evidenceIds: [], status: "ok", error: null, ms: performance.now() - analystStarted,
    });

    // Planner: suggestions → Action Center proposals (source 'ai', pending dry run + approval).
    const proposals = await planProposals(pool, recorder, {
      suggestions: grounded.draft.proposals, viewer: input.viewer, returned: recorder.returnedEvidence, refusal: refusal !== null, investigationId: id, now,
    });

    const g = grounded.draft;
    const result = InvestigationResultSchema.parse({
      mode,
      modeLabel: MODE_LABEL[mode],
      intent,
      summary: refusal ? `${refusal} ${g.summary}` : g.summary,
      observations: g.observations,
      suspectedCause: g.suspectedCause,
      confidence: g.confidence,
      recommendedNextAction: g.recommendedNextAction,
      expectedEffect: g.expectedEffect,
      risks: g.risks,
      missingInformation: g.missingInformation,
      approvalRequired: proposals.length > 0 || refusal !== null,
      proposals,
      refusal: refusal ? { reason: refusal } : null,
      grounding: grounded.report,
      warnings: recorder.warnings,
    });
    const latencyMs = Math.round(performance.now() - started);
    const cost = mode === "model" || usage.input + usage.output > 0 ? costMicros(usage) : 0;
    await pool.query(
      `update investigations set status = 'completed', mode = $2, model = $3, intent = $4, result = $5, grounding = $6, warnings = $7,
         input_tokens = $8, output_tokens = $9, cost_micros = $10, latency_ms = $11, finished_at = $12
       where id = $1`,
      [id, mode, usage.input + usage.output > 0 ? MODEL_ID : null, intent, result, result.grounding, JSON.stringify(result.warnings),
        usage.input + usage.cacheRead + usage.cacheWrite, usage.output, cost, latencyMs, now],
    );
    await audit(pool, now, actor, "investigation_complete", id, {
      mode, intent, claimsDropped: result.grounding.claimsDropped, warnings: result.warnings.length,
      proposals: proposals.map((p) => ({ kind: p.kind, exceptionId: p.exceptionId, status: p.status, proposalId: p.proposalId })),
    });
    return { id, status: "completed", mode, result, steps: recorder.steps, usage, costMicros: cost, latencyMs };
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    await pool.query(
      `update investigations set status = 'failed', error = $2, latency_ms = $3, finished_at = $4, input_tokens = $5, output_tokens = $6, cost_micros = $7 where id = $1`,
      [id, message.slice(0, 2000), Math.round(performance.now() - started), now, usage.input + usage.cacheRead + usage.cacheWrite, usage.output, costMicros(usage)],
    );
    await audit(pool, now, actor, "investigation_failed", id, { error: message.slice(0, 500) });
    throw error;
  }
}

/** The deterministic plans' tool access: the same executor, failures collected for the draft. */
function planContext(toolCtx: ToolContext, recorder: StepRecorder): PlanContext {
  const failures: PlanContext["failures"] = [];
  return {
    viewer: toolCtx.viewer,
    failures,
    warningCount: () => recorder.warnings.length,
    async call<N extends ToolName>(name: N, toolInput: unknown): Promise<ToolData<N> | null> {
      const result = await executeTool(toolCtx, recorder, name, toolInput);
      if (result.status !== "ok") {
        failures.push({ tool: name, status: result.status, message: result.error ?? result.status });
        return null;
      }
      return result.data as ToolData<N>;
    },
  };
}

async function audit(pool: Pool, now: Date, actor: string, action: string, id: number, detail: Record<string, unknown>) {
  await pool.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, $3, $4, $5)", [now, actor, action, `investigation:${id}`, detail]);
}
