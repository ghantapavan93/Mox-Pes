import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { canonicalJson, sha256 } from "@/lib/primitives";

/**
 * Marketing ChangeGuard: the change model.
 *
 * A configuration change is proposed, preflighted (the production write path, run in a
 * transaction that rolls back), reviewed, approved by a different person against the exact
 * configuration, preflight and base it was checked with, released inside the synthetic
 * environment, then verified and monitored. Nothing here touches an external system.
 *
 *   draft → ready_for_review | preflight_failed
 *   ready_for_review → approved | rejected | draft (re-preflight) | superseded
 *   preflight_failed → draft (re-preflight) | superseded
 *   approved → monitoring (released) | draft (approval invalidated: the base changed)
 *   monitoring → verified | degraded
 *   verified | degraded → recovery_required (post-release monitoring) | verified
 */
export const CHANGE_KINDS = ["campaign_mapping", "source_contract"] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const CHANGE_STATUSES = [
  "draft",
  "preflight_failed",
  "ready_for_review",
  "approved",
  "rejected",
  "monitoring",
  "verified",
  "degraded",
  "recovery_required",
  "superseded",
] as const;
export type ChangeStatus = (typeof CHANGE_STATUSES)[number];

export const CHANGE_TRANSITIONS: Readonly<Record<ChangeStatus, readonly ChangeStatus[]>> = {
  draft: ["ready_for_review", "preflight_failed", "superseded"],
  preflight_failed: ["draft", "superseded"],
  ready_for_review: ["approved", "rejected", "draft", "superseded"],
  approved: ["monitoring", "draft"],
  rejected: [],
  monitoring: ["verified", "degraded"],
  verified: ["recovery_required", "verified"],
  degraded: ["recovery_required", "verified", "degraded"],
  recovery_required: [],
  superseded: [],
};

export function assertChangeTransition(from: ChangeStatus, to: ChangeStatus): void {
  if (!CHANGE_TRANSITIONS[from].includes(to)) throw new ActionError(`A change cannot move from ${from} to ${to}`, 409);
}

const branchId = z.string().regex(/^B\d{2}$/);

export const CampaignMappingPayload = z.strictObject({
  campaignId: z.number().int().positive(),
  branchId,
});
export type CampaignMappingPayload = z.infer<typeof CampaignMappingPayload>;

/** Sample payloads of a changed upstream shape, run through the DEPLOYED mapper. Preflight only. */
export const SourceContractPayload = z.strictObject({
  source: z.enum(["crm", "calls", "web", "d2d", "ads"]),
  entity: z.string().min(1).max(40),
  samples: z.array(z.unknown()).min(1).max(50),
});
export type SourceContractPayload = z.infer<typeof SourceContractPayload>;

export const NewChangeSchema = z.discriminatedUnion("kind", [
  z.strictObject({ kind: z.literal("campaign_mapping"), payload: CampaignMappingPayload, reason: z.string().trim().min(10).max(1000) }),
  z.strictObject({ kind: z.literal("source_contract"), payload: SourceContractPayload, reason: z.string().trim().min(10).max(1000) }),
]);
export type NewChange = z.infer<typeof NewChangeSchema>;

/** The hash an approval binds to: the exact configuration, independent of key order. */
export const configHash = (kind: ChangeKind, payload: unknown) => sha256(canonicalJson({ kind, payload }));

export type CheckStatus = "pass" | "warn" | "fail" | "not_applicable";

/**
 * The fourteen preflight questions. Every preflight answers all of them, so "not checked" is
 * never silent: a question that does not apply to a change kind says why.
 */
export const CHECK_IDS = [
  "schema_compatibility",
  "identifier_presence",
  "mapping_coverage",
  "mapping_collision",
  "identity_stability",
  "time_and_dates",
  "financial_precision",
  "replay_safety",
  "source_authority",
  "reporting_impact",
  "permissions",
  "downstream_completeness",
  "quarantine_behaviour",
  "recovery",
] as const;
export type CheckId = (typeof CHECK_IDS)[number];

export const CHECK_LABEL: Record<CheckId, string> = {
  schema_compatibility: "Source schema compatibility",
  identifier_presence: "Required identifiers present",
  mapping_coverage: "Brand and branch mapping coverage",
  mapping_collision: "Mapping collisions",
  identity_stability: "Identity key stability",
  time_and_dates: "Time zones and dates",
  financial_precision: "Financial precision",
  replay_safety: "Duplicate and replay safety",
  source_authority: "Source authority",
  reporting_impact: "Reporting dependency impact",
  permissions: "Permissions and approval",
  downstream_completeness: "Downstream completeness",
  quarantine_behaviour: "Expected error and quarantine behaviour",
  recovery: "Rollback or forward recovery",
};

export interface PreflightCheck {
  id: CheckId;
  status: CheckStatus;
  /** One plain sentence: what was found. */
  detail: string;
  /** Machine-readable code for failures and warnings (e.g. LEAD_EVIDENCE_DISAGREES). */
  code?: string;
  evidence?: Record<string, unknown>;
}

export interface BranchImpact {
  branchId: string;
  /**
   * previous / proposed: the spend moves between them. lead_evidence: where the campaign's
   * leads land; its paid-customer count (the CAC denominator) depends on the campaign being
   * mapped at all (lib/metrics/scorecard.ts), so it moves too.
   */
  role: "previous" | "proposed" | "lead_evidence";
  before: { paidSpendCents: number; paidAcquired: number; paidCacCents: number | null };
  after: { paidSpendCents: number; paidAcquired: number; paidCacCents: number | null };
}

export interface PreflightResult {
  kind: ChangeKind;
  verdict: "pass" | "warn" | "fail";
  checks: PreflightCheck[];
  /** Campaign mapping only: branches whose numbers move, and how. */
  impact: BranchImpact[];
  exceptionsOpened: Array<{ fingerprint: string; kind: string; summary: string }>;
  exceptionsCleared: Array<{ fingerprint: string; kind: string; summary: string }>;
  /** Branches outside the change whose numbers changed in the preview (must be empty). */
  unrelatedBranchesChanged: string[];
  /** Metrics that read what this change touches. */
  dependentMetrics: string[];
  /** Stated, never hidden: what the preview assumes and cannot know. */
  limitations: string[];
  /** Source contract only: per-sample outcome through the deployed mapper. */
  samples?: Array<{ index: number; outcome: string; addedFields: string[]; removedFields: string[]; stagedOutcome?: string }>;
}

export function verdictOf(checks: PreflightCheck[]): PreflightResult["verdict"] {
  if (checks.some((c) => c.status === "fail")) return "fail";
  if (checks.some((c) => c.status === "warn")) return "warn";
  return "pass";
}

/** What the reviewer saw: an approval must present the same hash. */
export const preflightHashOf = (result: PreflightResult, baseHash: string) => sha256(canonicalJson({ result, baseHash }));

/** Which reporting metrics read each source projection (lib/metrics/definitions.ts). */
export const METRIC_DEPENDENCIES: Record<string, string[]> = {
  "ads": ["paidSpend", "paidCac"],
  "campaign_branch_map": ["paidSpend", "paidCac", "budget signal (Decision Lab)"],
  "calls": ["prospects", "paidCac", "unknownShare", "acquired (attribution)"],
  "web": ["prospects", "paidCac", "unknownShare", "acquired (attribution)"],
  "d2d": ["prospects", "acquired (attribution)"],
  "crm:payment": ["collected", "newCollected", "atRisk"],
  "crm:customer": ["acquired", "paidCac", "unknownShare"],
  "crm:subscription": ["acquired", "paidCac", "newCollected"],
  "crm:appointment": ["acquired", "paidCac"],
  "crm:ticket": ["collected", "atRisk"],
};

export function dependenciesOf(source: string, entity?: string): string[] {
  return METRIC_DEPENDENCIES[entity ? `${source}:${entity}` : source] ?? METRIC_DEPENDENCIES[source] ?? [];
}
