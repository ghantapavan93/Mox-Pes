import { z } from "zod";
import { PROPOSAL_KINDS } from "@/lib/workflow/kinds";
import { EvidenceIdSchema } from "./evidence";

/**
 * The investigation output contract. Both investigators (model and deterministic) produce a
 * DRAFT; the analyst grounds and classifies it (lib/ai/analyst.ts) and the planner turns its
 * suggested fixes into Action Center proposals (lib/ai/planner.ts). What is stored and shown is
 * the RESULT, validated with InvestigationResultSchema before it is written.
 *
 * Status vocabulary:
 *   verified   — a fact read from stored records, cited by evidence ids from this run;
 *   hypothesis — an explanation the evidence supports but does not prove (strong or weak).
 * Missing information is listed separately and carries no evidence by definition.
 */

export const ObservationSchema = z.strictObject({
  text: z.string().trim().min(1).max(600),
  evidenceIds: z.array(EvidenceIdSchema).max(25),
  status: z.enum(["verified", "hypothesis"]),
  /** Hypotheses only: how well the evidence supports it. */
  strength: z.enum(["strong", "weak"]).optional(),
});
export type Observation = z.infer<typeof ObservationSchema>;

export const CauseSchema = z.strictObject({
  text: z.string().trim().min(1).max(600),
  evidenceIds: z.array(EvidenceIdSchema).max(25),
});

export const ConfidenceSchema = z.strictObject({
  level: z.enum(["high", "medium", "low"]),
  why: z.string().trim().min(1).max(600),
});

/** A fix the investigator suggests. The planner decides whether it becomes a proposal. */
export const ProposalSuggestionSchema = z.strictObject({
  exceptionId: z.number().int().positive(),
  kind: z.enum(PROPOSAL_KINDS),
  params: z.record(z.string(), z.unknown()),
  rationale: z.string().trim().min(10).max(800),
});
export type ProposalSuggestion = z.infer<typeof ProposalSuggestionSchema>;

/** What an investigator hands to the analyst. The model submits exactly this shape. */
export const DraftFindingsSchema = z.strictObject({
  summary: z.string().trim().min(1).max(1200),
  observations: z.array(ObservationSchema).max(20),
  suspectedCause: CauseSchema.nullable(),
  confidence: ConfidenceSchema,
  recommendedNextAction: z.string().trim().min(1).max(600),
  expectedEffect: z.string().trim().min(1).max(600),
  risks: z.array(z.string().trim().min(1).max(400)).max(10),
  missingInformation: z.array(z.string().trim().min(1).max(400)).max(10),
  proposals: z.array(ProposalSuggestionSchema).max(5),
});
export type DraftFindings = z.infer<typeof DraftFindingsSchema>;

/**
 * What the planner did with each suggestion:
 *   created          — a new Action Center proposal (source 'ai', pending dry run + approval);
 *   existing         — the case already had a live proposal; linked, not replaced;
 *   not_permitted    — the viewer's role cannot propose; shown as a suggestion only;
 *   rejected_by_policy — kind not allowed for the AI path, exception not in this run's evidence,
 *                      or the user asked for an action the AI path may not take;
 *   failed           — the Action Center refused it (kind does not apply, scope, state).
 */
export const PLANNED_STATUSES = ["created", "existing", "not_permitted", "rejected_by_policy", "failed"] as const;

export const PlannedProposalSchema = z.strictObject({
  exceptionId: z.number().int().positive(),
  kind: z.enum(PROPOSAL_KINDS),
  params: z.record(z.string(), z.unknown()),
  rationale: z.string(),
  status: z.enum(PLANNED_STATUSES),
  reason: z.string(),
  proposalId: z.number().int().positive().nullable(),
  caseId: z.number().int().positive().nullable(),
});
export type PlannedProposal = z.infer<typeof PlannedProposalSchema>;

/**
 * A proof of one proposition of a claim (lib/ai/proof.ts): what it is about, the calculation, the
 * facts it used (with their definition versions, currency status and evidence ids), and whether
 * the stated figure follows. Stored with the claim so a reader can see why it was accepted.
 */
const PERIOD_KEY = z.enum(["oct", "sep", "all"]);
const UNIT = z.enum(["usd_cents", "count", "ratio"]);
export const ProofSchema = z.strictObject({
  piece: z.string(),
  figure: z.string(),
  subject: z.strictObject({ metric: z.string().nullable(), entity: z.string().nullable(), period: PERIOD_KEY.nullable() }),
  against: z.strictObject({ entity: z.string(), period: PERIOD_KEY }).nullable(),
  relation: z.enum(["level", "change", "relative_change", "points_change", "direction", "ratio", "sum", "share", "arithmetic", "membership", "status", "unknown"]),
  formula: z.string(),
  inputs: z.array(
    z.strictObject({
      metric: z.string(),
      entity: z.string(),
      period: PERIOD_KEY,
      value: z.number().nullable(),
      unit: UNIT,
      definitionVersion: z.string().nullable(),
      currencyResolved: z.boolean(),
      evidenceIds: z.array(z.string()),
      tool: z.string(),
    }),
  ),
  unit: UNIT.nullable(),
  computed: z.number().nullable(),
  claimed: z.number().nullable(),
  qualifier: z.enum(["exact", "approximately", "more_than", "at_least", "less_than", "at_most"]),
  direction: z.enum(["increase", "decrease", "unchanged"]).nullable(),
  claimedDirection: z.enum(["increase", "decrease"]).nullable(),
  precision: z.number(),
  rounding: z.string(),
  verdict: z.enum(["VERIFIED", "CONTRADICTED", "UNRESOLVED"]),
  gap: z
    .enum([
      "metric_unknown", "metric_unsupported", "fact_missing", "period_missing", "period_ambiguous", "comparison_missing", "currency_unresolved",
      "undefined_value", "operand_missing", "conflicting_facts", "evaluative", "evidence_stale", "ambiguous", "hypothetical",
    ])
    .nullable(),
  reason: z.string(),
});
export type ProofRecord = z.infer<typeof ProofSchema>;

export const DroppedClaimSchema = z.strictObject({
  /** summary / recommendedNextAction / expectedEffect / risk: free text withheld by the analyst. */
  where: z.enum(["observation", "suspectedCause", "proposal", "summary", "recommendedNextAction", "expectedEffect", "risk"]),
  /** What the investigator called it before it was dropped (observations only). */
  claimStatus: z.enum(["verified", "hypothesis"]).optional(),
  text: z.string(),
  evidenceIds: z.array(z.string()),
  /** Ids the claim cited that no tool returned in this run. */
  unsupported: z.array(z.string()),
  reason: z.string(),
  /** The proofs that rejected it, when it was rejected for not following from its facts. */
  proofs: z.array(ProofSchema).optional(),
});
export type DroppedClaim = z.infer<typeof DroppedClaimSchema>;

export const GroundingReportSchema = z.strictObject({
  /** Distinct evidence ids returned by tools in this run. */
  returnedEvidence: z.number().int().nonnegative(),
  claimsIn: z.number().int().nonnegative(),
  claimsKept: z.number().int().nonnegative(),
  /** Unsupported claims dropped (counted in the evaluation). */
  claimsDropped: z.number().int().nonnegative(),
  /** Verified claims downgraded to hypotheses (cited only definitions, not records). */
  downgraded: z.number().int().nonnegative(),
  /** Claims dropped because a figure they state appears in no cited tool output (subset of claimsDropped). */
  numericDropped: z.number().int().nonnegative().optional(),
  /** Free-text fields (summary, next step, expected effect, risks) withheld for an unsupported figure or cause. */
  textWithheld: z.number().int().nonnegative().optional(),
  /** Claims dropped because a proposition does not follow from the facts they cite (lib/ai/proof.ts; subset of claimsDropped). */
  proofDropped: z.number().int().nonnegative().optional(),
  /** Verified claims shown as hypotheses because a figure could not be proved (subset of downgraded). */
  proofDowngraded: z.number().int().nonnegative().optional(),
  /** Claims dropped because they cite a source record that a newer revision superseded (subset of claimsDropped). */
  staleDropped: z.number().int().nonnegative().optional(),
  dropped: z.array(DroppedClaimSchema),
});
export type GroundingReport = z.infer<typeof GroundingReportSchema>;

export const InjectionWarningSchema = z.strictObject({
  tool: z.string(),
  path: z.string(),
  excerpt: z.string(),
  pattern: z.string(),
});
export type InjectionWarning = z.infer<typeof InjectionWarningSchema>;

/**
 * The claim check (lib/ai/analyst.ts): every statement the investigation makes, typed, with its
 * support decided OUTSIDE the model.
 *
 *   type     OBSERVATION  a fact read from a record;
 *            DERIVATION   a figure computed by a deterministic tool (a CAC, a share, a sum it returned);
 *            HYPOTHESIS   an explanation the evidence is consistent with, not proof;
 *            RECOMMENDATION a suggested next step;
 *            CAUSAL       a claim that something caused a business outcome.
 *   status   SUPPORTED          cites ids a tool returned in this run, and every figure it states
 *                               appears in those tools' output;
 *            PARTIALLY_SUPPORTED evidence is real but does not prove it (hypotheses, recommendations);
 *            CONFLICTED         its evidence disagrees with itself (e.g. a trace that does not reproduce);
 *            UNSUPPORTED        dropped: invented evidence, a figure no tool returned, or an unmeasured cause;
 *            NOT_DETERMINABLE   what the investigation says it could not establish.
 */
export const CLAIM_TYPES = ["OBSERVATION", "DERIVATION", "HYPOTHESIS", "RECOMMENDATION", "CAUSAL"] as const;
export const SUPPORT_STATUSES = ["SUPPORTED", "PARTIALLY_SUPPORTED", "CONFLICTED", "UNSUPPORTED", "NOT_DETERMINABLE"] as const;

export const ClaimSchema = z.strictObject({
  id: z.string(),
  type: z.enum(CLAIM_TYPES),
  text: z.string(),
  evidenceIds: z.array(z.string()),
  numbers: z.array(z.strictObject({ text: z.string(), kind: z.enum(["money", "percent", "count"]), supported: z.boolean() })),
  status: z.enum(SUPPORT_STATUSES),
  reason: z.string(),
  /** Who wrote the sentence: a template filled from structured results, or the model. */
  origin: z.enum(["template", "model"]).optional(),
  /** One proof per proposition (figure or direction). Absent on claims stored before proofs existed. */
  proofs: z.array(ProofSchema).optional(),
});
export type Claim = z.infer<typeof ClaimSchema>;

export const InvestigationResultSchema = z.strictObject({
  mode: z.enum(["deterministic", "model"]),
  /** Human-readable label for the mode, shown wherever the result is. */
  modeLabel: z.string(),
  intent: z.string(),
  summary: z.string().min(1),
  observations: z.array(ObservationSchema),
  suspectedCause: CauseSchema.nullable(),
  confidence: ConfidenceSchema,
  recommendedNextAction: z.string().min(1),
  expectedEffect: z.string().min(1),
  risks: z.array(z.string()),
  missingInformation: z.array(z.string()),
  /** True whenever anything this investigation recommends changes data: a person must approve. */
  approvalRequired: z.boolean(),
  proposals: z.array(PlannedProposalSchema),
  /** Set when the question asked the AI path to take an action it may not take. */
  refusal: z.strictObject({ reason: z.string() }).nullable(),
  grounding: GroundingReportSchema,
  warnings: z.array(InjectionWarningSchema),
  /** Absent on investigations stored before the claim check existed. */
  claims: z.array(ClaimSchema).optional(),
});
export type InvestigationResult = z.infer<typeof InvestigationResultSchema>;

export const MODE_LABEL = {
  deterministic: "Deterministic investigator — no model configured",
  model: "Model investigator (Anthropic Messages API)",
} as const;

/** The deterministic investigator answered because a configured model's run failed: not "no model". */
export function fallbackModeLabel(reason: string): string {
  return `Deterministic fallback — the model run failed (${reason.slice(0, 120)})`;
}
