import type { Pool } from "pg";
import { ActionError } from "@/lib/actions";
import { getNow } from "@/lib/db";
import { BRANCH_BY_ID, BRANDS, BRAND_BY_ID, brandWords, branchesOfBrands } from "@/lib/reference";
import { ForbiddenError, requirePermission, resolveScope, type Viewer } from "@/lib/viewer";
import { countStart, deleteExpiredWorkspace, isWorkspaceOwner } from "@/lib/workspace";
import { buildClaims, evidenceFacts, groundDraft } from "./analyst";
import { fallbackModeLabel, InvestigationResultSchema, MODE_LABEL, modelModeLabel, type DraftFindings, type InvestigationResult } from "./contract";
import { ACTION_REFUSAL, brandNamed, detectIntent, runDeterministic, type PlanContext } from "./deterministic";
import { ANTHROPIC_PROFILE, costMicros, modelClientFromEnv, runModelInvestigator, type ModelClient, type ModelFailure, type ModelProfile, type TokenUsage } from "./model";
import { planProposals } from "./planner";
import { staleRevisions } from "./revisions";
import { StepRecorder, executeTool, tablesFor, type InvestigationStep } from "./steps";
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
 *
 * A model run that fails in any way (no answer, an error, or an answer whose every statement the
 * evidence check drops) falls back to the deterministic investigator, and the result says why in
 * a class (release design §5.9). A workspace guest on the hosted demo always gets the
 * deterministic path, in its own tables, counted against the start quota, never audited and never
 * proposing a fix (§5.2).
 */

export interface RunInvestigationInput {
  question: string;
  /** Branch the viewer asked about; must be in the viewer's scope. Null = the whole scope. */
  branchId: string | null;
  viewer: Viewer;
  /** "deterministic" forces the no-model path; "auto" uses the model when a client is available. */
  mode?: "auto" | "deterministic";
  /** Injected model client (tests, evaluation); undefined = the configured client (modelClientFromEnv). */
  client?: ModelClient | null;
  /** The injected client's profile; the Anthropic profile when a client is injected without one. */
  profile?: ModelProfile;
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

/**
 * A question that names what the viewer may not see is refused outright, not answered about
 * something else in scope (held-out IV-54, first contact: a branch partner asked for a brand-wide
 * figure and got an answer about their own branch). Branch ids named in the question must be in
 * scope; a brand-wide question needs every branch of the brand in scope.
 */
/** Branch ids however written: "B03", "b03", "B3", "B 03", "branch 3", "branch #03". */
const BRANCH_REF = /\b[Bb]\s?(\d{1,2})\b|\bbranch(?:es)?\s+(?:#|no\.?\s*|number\s+)?(\d{1,2})\b/gi;
/** A branch by its name: "Elm's", "the Summit branch" (names are common words, so only these forms). */
const BRANCH_NAME_REF = new RegExp(String.raw`\b(${[...BRANCH_BY_ID.values()].map((b) => b.name).join("|")})(?:['’]s|\s+branch)\b`, "g");
/**
 * A brand however capitalized, by id or by any of its names without the trade suffix: "Copper
 * Mesa's", "bluepine", "joshuas", "MISSION" (former names stay recognised, lib/reference.ts).
 */
const BRAND_OF_WORD = new Map<string, string>(
  BRANDS.flatMap((b) => [b.id, ...brandWords(b)].map((w) => [w.toLowerCase(), b.id] as const)),
);
const BRAND_REF = new RegExp(
  String.raw`\b(${[...BRAND_OF_WORD.keys()]
    .sort((a, b) => b.length - a.length)
    .map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("|")})(?:['’]?s)?\b`,
  "i",
);

function assertQuestionInScope(viewer: Viewer, question: string): void {
  if (!viewer.branchIds) return;
  const named = new Set<string>();
  for (const m of question.matchAll(BRANCH_REF)) named.add(`B${String(Number(m[1] ?? m[2])).padStart(2, "0")}`);
  for (const m of question.matchAll(BRANCH_NAME_REF)) {
    const branch = [...BRANCH_BY_ID.values()].find((b) => b.name === m[1]);
    if (branch) named.add(branch.id);
  }
  for (const id of named) {
    if (BRANCH_BY_ID.has(id) && !viewer.branchIds.includes(id)) throw new ForbiddenError(`${viewer.label} cannot view branch ${id}, which the question names`);
  }
  // A brand named at all, with any of its branches out of scope, is refused unless the question
  // also names an in-scope branch it is about: "What did Joshua's spend?" from a Moxie branch
  // partner was answered about the partner's own branch (review 2026-11-12, authorization 8).
  const word = BRAND_REF.exec(question)?.[1]?.toLowerCase();
  const brand = brandNamed(question) ?? (word ? ((BRAND_OF_WORD.get(word) as ReturnType<typeof brandNamed>) ?? null) : null);
  if (brand) {
    const ids = branchesOfBrands([brand]);
    const outside = ids.filter((id) => !viewer.branchIds?.includes(id));
    const aboutOwnBranch = [...named].some((id) => viewer.branchIds?.includes(id) && ids.includes(id));
    const brandWide = /\b(?:brand[- ]?wide|brand|across|all (?:of )?(?:its|their|the) branches|every branch|whole|entire|total|branches|best branch|benchmark\w*)\b/i.test(question);
    if (outside.length > 0 && (brandWide || !aboutOwnBranch)) throw new ForbiddenError(`${viewer.label} cannot view ${BRAND_BY_ID.get(brand)?.name ?? brand} as a whole (${outside.length} of its ${ids.length} branches are outside the scope)`);
  }
}

/** A role with `investigate`, or a workspace guest (its own deterministic investigations). */
function investigatorAccess(viewer: Viewer): "staff" | "workspace" {
  if (viewer.can.investigate) return "staff";
  if (viewer.can.workspace) return "workspace";
  requirePermission(viewer, "investigate", "run investigations");
  return "staff";
}

export async function runInvestigation(pool: Pool, input: RunInvestigationInput): Promise<InvestigationOutcome> {
  const workspace = investigatorAccess(input.viewer) === "workspace";
  if (workspace && !isWorkspaceOwner(input.viewer.subject)) {
    throw new Error("A workspace investigation needs a viewer that holds its own token (viewerForWorkspaceStart)");
  }
  const question = input.question.trim().replace(/\s+/g, " ");
  if (question.length < 3) throw new ActionError("Ask a question of at least 3 characters", 400);
  if (question.length > QUESTION_MAX) throw new ActionError(`Questions are limited to ${QUESTION_MAX} characters`, 400);
  if (input.branchId !== null) {
    if (!BRANCH_BY_ID.has(input.branchId)) throw new ActionError(`Unknown branch ${input.branchId}`, 400);
    resolveScope(input.viewer, input.branchId);
  }
  assertQuestionInScope(input.viewer, question);
  if (workspace) {
    // Expired workspace items go first; then the start is counted, refusals included (§5.2).
    await deleteExpiredWorkspace(pool);
    const capacity = await countStart(pool, "investigation");
    if (capacity) throw new ActionError(capacity.message, capacity.status);
  }

  const started = performance.now();
  const now = input.now ?? (await getNow(pool));
  const tables = tablesFor(input.viewer);
  // A workspace guest never runs a model; staff use the configured one, or the injected one.
  const configured =
    workspace || input.mode === "deterministic"
      ? null
      : input.client !== undefined
        ? input.client
          ? { client: input.client, profile: input.profile ?? ANTHROPIC_PROFILE }
          : null
        : modelClientFromEnv();
  let mode: "deterministic" | "model" = configured ? "model" : "deterministic";
  let failure: ModelFailure | null = null;
  const actor = input.viewer.role;

  const { rows } = await pool.query<{ id: string }>(
    workspace
      ? `insert into workspace_investigations (question, branch_id, scope_branch_ids, actor, mode, model, status, created_at, workspace_owner)
         values ($1, $2, $3, $4, $5, $6, 'running', $7, $8) returning id`
      : `insert into investigations (question, branch_id, scope_branch_ids, actor, mode, model, status, created_at)
         values ($1, $2, $3, $4, $5, $6, 'running', $7) returning id`,
    [question, input.branchId, input.viewer.branchIds, actor, mode, configured?.profile.model ?? null, now, ...(workspace ? [input.viewer.subject] : [])],
  );
  const id = Number(rows[0].id);
  if (!workspace) await audit(pool, now, actor, "investigation_start", id, { question, branchId: input.branchId, mode });
  input.onStart?.({ id, mode });

  const recorder = new StepRecorder(pool, id, now, input.onStep, tables.steps);
  const toolCtx: ToolContext = { db: pool, viewer: input.viewer, now };
  const detected = detectIntent(question, input.viewer, input.branchId);
  const usage: TokenUsage = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };

  // Analyst: ground every claim in this run's tool evidence, classify, adjust confidence.
  const ground = async (draft: DraftFindings, origin: "model" | "template") => {
    const analystStarted = performance.now();
    // Numbers are checked against what the tools returned, outside the model (lib/ai/numbers.ts).
    const facts = evidenceFacts(recorder.steps);
    // Every figure must follow from the typed facts it cites (lib/ai/proof.ts). The deterministic
    // investigator writes templates filled from structured results; the model writes free text.
    const cited = [...draft.observations.flatMap((o) => o.evidenceIds), ...(draft.suspectedCause?.evidenceIds ?? [])];
    const stale = await staleRevisions(pool, cited);
    const grounded = groundDraft(draft, recorder.returnedEvidence, facts, { origin, branchId: input.branchId, stale });
    const claims = buildClaims(grounded, facts);
    await recorder.record({
      stage: "analyst", kind: "analysis", tool: null, input: { claims: grounded.report.claimsIn },
      outputSummary: `Kept ${grounded.report.claimsKept} of ${grounded.report.claimsIn} claim(s); dropped ${grounded.report.claimsDropped} unsupported (${grounded.report.numericDropped ?? 0} for a figure no tool returned); downgraded ${grounded.report.downgraded}; ${recorder.returnedEvidence.size} evidence id(s) returned by tools`,
      output: grounded.report, evidenceIds: [], status: "ok", error: null, ms: performance.now() - analystStarted,
    });
    return { grounded, claims };
  };

  try {
    let checked: Awaited<ReturnType<typeof ground>> | null = null;
    let intent: string = detected.intent;
    let refusal: string | null = null;

    if (configured) {
      const run = await runModelInvestigator({
        client: configured.client, profile: configured.profile, question, requestedBranch: input.branchId, viewer: input.viewer, toolCtx, recorder, ...input.limits,
      });
      Object.assign(usage, run.usage);
      if (run.draft) {
        const model = await ground(run.draft, "model");
        // An answer with no statement the evidence supports is not an answer: fall back too.
        if (model.grounded.report.claimsKept > 0) {
          checked = model;
          refusal = detected.actionRequest ? ACTION_REFUSAL : null;
        } else failure = { class: "no_verified_statement", message: "gave no statement the records verify" };
      } else failure = run.failure ?? { class: "other", message: run.error ?? "ended without findings" };
      if (failure) {
        // The deterministic investigator answers over the same tools, and the result says why:
        // the stored mode is what actually answered.
        await recorder.record({
          stage: "investigator", kind: "model_turn", tool: null, input: { class: failure.class }, outputSummary: `The model path gave no answer (${failure.class}: ${failure.message}); the deterministic investigator answers`,
          output: null, evidenceIds: [], status: "error", error: failure.message, ms: 0,
        });
        mode = "deterministic";
      }
    }
    if (!checked) {
      const outcome = await runDeterministic(planContext(toolCtx, recorder), question, input.branchId);
      intent = outcome.intent;
      refusal = outcome.refusal;
      checked = await ground(outcome.draft, "template");
    }
    const { grounded, claims } = checked;

    // Planner: suggestions → Action Center proposals (source 'ai', pending dry run + approval).
    // A workspace investigation proposes nothing: it changes no shared data (§5.2).
    const proposals = workspace
      ? []
      : await planProposals(pool, recorder, {
          suggestions: grounded.draft.proposals, viewer: input.viewer, returned: recorder.returnedEvidence, refusal: refusal !== null, investigationId: id, now,
        });

    const g = grounded.draft;
    const result = InvestigationResultSchema.parse({
      mode,
      modeLabel: failure && configured ? fallbackModeLabel(configured.profile.provider, failure) : mode === "model" && configured ? modelModeLabel(configured.profile) : MODE_LABEL.deterministic,
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
      claims,
      ...(failure ? { fallback: failure } : {}),
    });
    const latencyMs = Math.round(performance.now() - started);
    // A local model is never priced; a fallback still paid for the tokens the model used.
    const cost = configured?.profile.priced && usage.input + usage.output > 0 ? costMicros(usage) : 0;
    await pool.query(
      `update ${tables.investigations} set status = 'completed', mode = $2, model = $3, intent = $4, result = $5, grounding = $6, warnings = $7,
         input_tokens = $8, output_tokens = $9, cost_micros = $10, latency_ms = $11, finished_at = $12
       where id = $1`,
      [id, mode, configured?.profile.model ?? null, intent, result, result.grounding, JSON.stringify(result.warnings),
        usage.input + usage.cacheRead + usage.cacheWrite, usage.output, cost, latencyMs, now],
    );
    if (!workspace) {
      await audit(pool, now, actor, "investigation_complete", id, {
        mode, intent, claimsDropped: result.grounding.claimsDropped, warnings: result.warnings.length, ...(failure ? { fallback: failure.class } : {}),
        proposals: proposals.map((p) => ({ kind: p.kind, exceptionId: p.exceptionId, status: p.status, proposalId: p.proposalId })),
      });
    }
    return { id, status: "completed", mode, result, steps: recorder.steps, usage, costMicros: cost, latencyMs };
  } catch (error) {
    const message = (error as Error).message ?? String(error);
    await pool.query(
      `update ${tables.investigations} set status = 'failed', error = $2, latency_ms = $3, finished_at = $4, input_tokens = $5, output_tokens = $6, cost_micros = $7 where id = $1`,
      [id, message.slice(0, 2000), Math.round(performance.now() - started), now, usage.input + usage.cacheRead + usage.cacheWrite, usage.output, configured?.profile.priced ? costMicros(usage) : 0],
    );
    if (!workspace) await audit(pool, now, actor, "investigation_failed", id, { error: message.slice(0, 500) });
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
