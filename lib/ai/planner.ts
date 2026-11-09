import type { Pool } from "pg";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { ForbiddenError, type Viewer } from "@/lib/viewer";
import { LIVE_PROPOSAL_STATUSES } from "@/lib/workflow/cases";
import { createProposal } from "@/lib/workflow/proposals";
import type { PlannedProposal, ProposalSuggestion } from "./contract";
import type { StepRecorder } from "./steps";

/**
 * The planner stage: suggested fixes → Action Center proposals.
 *
 * The AI path can only ever CREATE a proposal, with source 'ai', through the Action Center's
 * own createProposal (permission, scope, kind/params validation, audit). It never dry-runs,
 * approves or executes: those are separate calls the Action Center gates by role, and approval
 * must come from a role other than the one that proposed (lib/workflow/proposals.ts). This
 * module imports nothing that could do otherwise.
 *
 * Whatever an investigator (or a prompt-injected record) suggests, a suggestion becomes a
 * proposal only if:
 *   * its kind is one the AI path may propose (AI_ALLOWED_KINDS — fixes whose correctness the
 *     dry run verifies mechanically; judgement calls like acknowledging a conflict or mapping a
 *     campaign to a branch stay with people);
 *   * the exception it fixes was returned by a tool in this run (so it is in the viewer's scope
 *     and the claim is grounded);
 *   * the question did not ask the AI to take an action itself (refusal);
 *   * the viewer's role may propose;
 *   * the case has no live proposal — an existing one (human or AI) is linked, never replaced.
 */

export const AI_ALLOWED_KINDS = ["remap_channel", "replay_quarantine", "override_lead_branch"] as const;

export interface PlanInput {
  suggestions: ProposalSuggestion[];
  viewer: Viewer;
  /** Evidence ids returned by tools in this run. */
  returned: ReadonlySet<string>;
  /** The question asked the AI path to act (approve, execute, delete…): create nothing. */
  refusal: boolean;
  investigationId: number;
  now: Date;
}

export async function planProposals(pool: Pool, recorder: StepRecorder, input: PlanInput): Promise<PlannedProposal[]> {
  const planned: PlannedProposal[] = [];
  for (const s of input.suggestions) {
    const started = performance.now();
    const result = await planOne(pool, input, s);
    planned.push(result);
    await recorder.record({
      stage: "planner",
      kind: "proposal",
      tool: null,
      input: { exceptionId: s.exceptionId, kind: s.kind, params: s.params },
      outputSummary: `${s.kind} for exception ${s.exceptionId}: ${result.status}${result.proposalId ? ` (proposal ${result.proposalId})` : ""} — ${result.reason}`,
      output: result,
      evidenceIds: [`exception:${s.exceptionId}`, ...(result.caseId ? [`case:${result.caseId}`] : []), ...(result.proposalId ? [`proposal:${result.proposalId}`] : [])],
      status: result.status === "created" || result.status === "existing" ? "ok" : result.status === "failed" ? "error" : "skipped",
      error: result.status === "failed" ? result.reason : null,
      ms: performance.now() - started,
    });
  }
  return planned;
}

async function planOne(pool: Pool, input: PlanInput, s: ProposalSuggestion): Promise<PlannedProposal> {
  const base = { exceptionId: s.exceptionId, kind: s.kind, params: s.params, rationale: s.rationale, proposalId: null, caseId: null };
  if (input.refusal) {
    return { ...base, status: "rejected_by_policy", reason: "The question asked the AI path to take an action itself; it only investigates. Nothing was proposed." };
  }
  if (!(AI_ALLOWED_KINDS as readonly string[]).includes(s.kind)) {
    return { ...base, status: "rejected_by_policy", reason: `The AI path may propose ${AI_ALLOWED_KINDS.join(", ")} only; ${s.kind} needs a person's judgement` };
  }
  if (!input.returned.has(`exception:${s.exceptionId}`)) {
    return { ...base, status: "rejected_by_policy", reason: "The exception was not returned by a tool in this run" };
  }
  const existing = await pool.query<{ id: string; case_id: string; status: string; source: string }>(
    `select p.id, p.case_id, p.status, p.source from action_proposals p
     where p.exception_id = $1 and p.status = any($2::text[]) order by p.id desc limit 1`,
    [s.exceptionId, LIVE_PROPOSAL_STATUSES],
  );
  if (existing.rows[0]) {
    const e = existing.rows[0];
    return {
      ...base,
      status: "existing",
      reason: `The case already has a live ${e.source} proposal (${e.status}); linked, not replaced`,
      proposalId: Number(e.id),
      caseId: Number(e.case_id),
    };
  }
  if (!input.viewer.can.propose) {
    return { ...base, status: "not_permitted", reason: `${input.viewer.label} cannot create proposals; shown as a suggestion only` };
  }
  try {
    const proposal = await createProposal(pool, {
      exceptionId: s.exceptionId,
      kind: s.kind,
      params: s.params,
      rationale: `AI investigation #${input.investigationId}: ${s.rationale}`.slice(0, 2000),
      source: "ai",
      actor: input.viewer,
      now: input.now,
    });
    return {
      ...base,
      params: proposal.params,
      status: "created",
      reason: "Created as a draft proposal: it needs a dry run and approval by a different role before anything changes",
      proposalId: proposal.id,
      caseId: proposal.caseId,
    };
  } catch (error) {
    if (error instanceof ActionError || error instanceof ForbiddenError) return { ...base, status: "failed", reason: error.message };
    if (error instanceof z.ZodError) return { ...base, status: "failed", reason: `Invalid params: ${error.issues.map((i) => i.message).join("; ")}` };
    throw error;
  }
}
