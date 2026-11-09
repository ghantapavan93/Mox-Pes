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

export const DroppedClaimSchema = z.strictObject({
  where: z.enum(["observation", "suspectedCause", "proposal"]),
  text: z.string(),
  evidenceIds: z.array(z.string()),
  /** Ids the claim cited that no tool returned in this run. */
  unsupported: z.array(z.string()),
  reason: z.string(),
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
});
export type InvestigationResult = z.infer<typeof InvestigationResultSchema>;

export const MODE_LABEL = {
  deterministic: "Deterministic investigator — no model configured",
  model: "Model investigator (Anthropic Messages API)",
} as const;
