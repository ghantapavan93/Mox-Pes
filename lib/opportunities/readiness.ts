import { STALE_AFTER_MS } from "@/lib/health/feeds";
import type { Viewer } from "@/lib/viewer";

/**
 * Decision readiness for an opportunity: may a person act on it, and if not, what is missing.
 *
 * Four questions, answered in order, each by an explicit rule:
 *   1. Can the data be trusted right now?  freshness and open data-quality blockers (never
 *      overridable: a judgment call cannot make stale or broken data right)
 *   2. Is there enough of it?               the smaller comparison arm has at least minArmUnits
 *   3. Does it matter?                      the value at stake reaches the materiality threshold
 *   4. Is the cause known?                  a pattern alone supports a validation step; acting
 *                                           needs a measured outcome of an intervention
 *
 * Levels, lowest first: blocked → monitor → validate → act. An observational comparison can
 * never reach "act" on its own; only a measured outcome (an experiment or a pilot with a
 * control) can, or a recorded override by someone allowed to accept that risk.
 */
export type ReadinessLevel = "blocked" | "monitor" | "validate" | "act";
export const LEVELS: readonly ReadinessLevel[] = ["blocked", "monitor", "validate", "act"];

export type CheckKey = "freshness" | "data_quality" | "sample" | "materiality" | "pattern" | "outcome";

export interface ReadinessInput {
  /** Annual value at stake in cents. An inference: the journey states the formula next to it. */
  valueAtStakeCents: number;
  /** Units in the smaller arm of the comparison the pattern rests on. */
  smallestArm: number;
  /** Oldest "last delivered" age among the feeds the journey reads; null = a feed never delivered. */
  dataAgeMs: number | null;
  /** Open decision-blocking exceptions in scope. */
  openDataBlockers: number;
  /** The 95% interval excludes zero in the hypothesised direction; null = not computable. */
  patternSupported: boolean | null;
  /** A measured outcome of an intervention exists (not an observational comparison). */
  measuredOutcome: boolean;
}

export const READINESS_POLICY = {
  /** $10,000 of annual contract value. Below it, the opportunity is watched, not worked. */
  materialityCents: 1_000_000,
  minArmUnits: 30,
  maxDataAgeMs: STALE_AFTER_MS,
  override: {
    permission: "approve" as const,
    minReasonLength: 20,
    /** Checks a person may accept as a risk. Freshness and data quality are facts, not risks. */
    overridable: ["sample", "materiality", "pattern", "outcome"] as CheckKey[],
  },
};
export type ReadinessPolicy = typeof READINESS_POLICY;

export interface ReadinessCheck {
  key: CheckKey;
  passed: boolean;
  detail: string;
  overridable: boolean;
}

export interface ReadinessAssessment {
  level: ReadinessLevel;
  checks: ReadinessCheck[];
  /** What would move it up one level. */
  next: string;
}

const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const hoursOf = (ms: number) => `${Math.round(ms / 3_600_000)} h`;

export function assessReadiness(input: ReadinessInput, policy: ReadinessPolicy = READINESS_POLICY): ReadinessAssessment {
  const can = (key: CheckKey) => policy.override.overridable.includes(key);
  const fresh = input.dataAgeMs !== null && input.dataAgeMs <= policy.maxDataAgeMs;
  const checks: ReadinessCheck[] = [
    {
      key: "freshness",
      passed: fresh,
      detail: input.dataAgeMs === null ? "A feed this journey reads has never delivered" : `Oldest feed delivered ${hoursOf(input.dataAgeMs)} ago (limit ${hoursOf(policy.maxDataAgeMs)})`,
      overridable: can("freshness"),
    },
    {
      key: "data_quality",
      passed: input.openDataBlockers === 0,
      detail: input.openDataBlockers === 0 ? "No open decision-blocking exceptions in scope" : `${input.openDataBlockers} open decision-blocking exception(s) in scope`,
      overridable: can("data_quality"),
    },
    {
      key: "sample",
      passed: input.smallestArm >= policy.minArmUnits,
      detail: `Smaller comparison arm: ${input.smallestArm} (minimum ${policy.minArmUnits})`,
      overridable: can("sample"),
    },
    {
      key: "materiality",
      passed: input.valueAtStakeCents >= policy.materialityCents,
      detail: `Value at stake ${dollars(input.valueAtStakeCents)} a year (threshold ${dollars(policy.materialityCents)})`,
      overridable: can("materiality"),
    },
    {
      key: "pattern",
      passed: input.patternSupported === true,
      detail:
        input.patternSupported === null
          ? "The comparison could not be computed"
          : input.patternSupported
            ? "The 95% interval excludes zero in the hypothesised direction"
            : "The data does not support the hypothesised pattern (the 95% interval includes zero or points the other way)",
      overridable: can("pattern"),
    },
    {
      key: "outcome",
      passed: input.measuredOutcome,
      detail: input.measuredOutcome ? "A measured outcome of an intervention exists" : "No intervention has been measured; the comparison is observational",
      overridable: can("outcome"),
    },
  ];
  const failed = (key: CheckKey) => !checks.find((c) => c.key === key)!.passed;

  let level: ReadinessLevel;
  let next: string;
  if (failed("freshness") || failed("data_quality") || failed("sample")) {
    level = "blocked";
    next = failed("freshness") ? "Restore the stale feed" : failed("data_quality") ? "Resolve the open data-quality exceptions" : "Wait for a larger sample";
  } else if (failed("materiality") || failed("pattern")) {
    level = "monitor";
    next = failed("pattern") ? "Nothing to validate yet: the data does not show the pattern" : "Watch it; it is below the materiality threshold";
  } else if (failed("outcome")) {
    level = "validate";
    next = "Run the validation step and measure the outcome against a control";
  } else {
    level = "act";
    next = "Act, and keep measuring";
  }
  return { level, checks, next };
}

export interface OverrideRequest {
  viewer: Viewer;
  reason: string;
  /** Overrides raise by exactly one level. */
  to: ReadinessLevel;
}

export type OverrideVerdict = { ok: true; from: ReadinessLevel; to: ReadinessLevel; acceptedRisks: CheckKey[] } | { ok: false; code: string; message: string };

/**
 * Who may override, and what. The rule is the policy, not the screen: a person with the approve
 * permission may raise the level by one step, giving a reason, and only past checks that are
 * risks (sample, materiality, pattern, outcome). The override is recorded with its subject.
 */
export function checkOverride(assessment: ReadinessAssessment, req: OverrideRequest, policy: ReadinessPolicy = READINESS_POLICY): OverrideVerdict {
  if (!req.viewer.can[policy.override.permission]) {
    return { ok: false, code: "FORBIDDEN", message: `Only a role with the ${policy.override.permission} permission may override readiness` };
  }
  if (req.reason.trim().length < policy.override.minReasonLength) {
    return { ok: false, code: "REASON_REQUIRED", message: `Give a reason of at least ${policy.override.minReasonLength} characters` };
  }
  const from = LEVELS.indexOf(assessment.level);
  const to = LEVELS.indexOf(req.to);
  if (to !== from + 1) {
    return { ok: false, code: "ONE_LEVEL_ONLY", message: `An override raises readiness by one level (${assessment.level} → ${LEVELS[from + 1] ?? "none"})` };
  }
  const hard = assessment.checks.filter((c) => !c.passed && !c.overridable);
  if (hard.length > 0) {
    return { ok: false, code: "NOT_OVERRIDABLE", message: `Cannot be overridden: ${hard.map((c) => c.detail).join("; ")}` };
  }
  return { ok: true, from: assessment.level, to: req.to, acceptedRisks: assessment.checks.filter((c) => !c.passed).map((c) => c.key) };
}
