import { SIGNAL_RATIO, type BudgetSignal } from "@/lib/metrics/decision";
import type { PeriodKey } from "@/lib/period";

/**
 * What the budget-signal card may say, kept in one place so the branch page cannot drift from
 * the Decision Lab.
 *
 * The budget signal compares ATTRIBUTED cost per new customer (first evidenced touch) and is
 * gated only on open decision-blocking incidents. That supports two statements and no more:
 *   - an observation: "X costs N× Y per attributed new customer";
 *   - a data-integrity gate: "no blocking incidents" (or the incidents that block it).
 * It never supports a recommendation to move budget, and never says the evidence is "sound":
 * decision readiness (integrity, minimum customers, feed freshness per channel) and business
 * effectiveness (randomized experiments only) are verdicts of the Decision Lab, which the card
 * links to instead of paraphrasing.
 */

export const SIGNAL_GATE_LABEL = {
  /** No open exception that changes what a paid channel here cost or which customers it produced. */
  clear: "Data integrity: no blocking incidents",
  blocked: "Not trustworthy yet",
} as const;

export interface BudgetSignalCopy {
  headline: string;
  gate: { tone: "good" | "bad"; label: string };
  /** Always shown: attributed cost says nothing about whether the spend caused the customers. */
  effectiveness: string;
  /** The Decision Lab for the same branch and period, where readiness and effectiveness live. */
  decisionsHref: string;
}

export function budgetSignalCopy(
  signal: Pick<BudgetSignal, "signal" | "ratio" | "from" | "to" | "trustworthy">,
  branchId: string,
  periodKey: PeriodKey,
): BudgetSignalCopy {
  const headline =
    signal.signal === "shift" && signal.from && signal.to && signal.ratio !== null
      ? `${signal.from.label} costs ${signal.ratio.toFixed(1)}× ${signal.to.label} per attributed new customer (first evidenced touch). An observation, not a recommendation.`
      : `No paid channel at this branch costs ${SIGNAL_RATIO}× another per attributed new customer (first evidenced touch).`;
  return {
    headline,
    gate: signal.trustworthy ? { tone: "good", label: SIGNAL_GATE_LABEL.clear } : { tone: "bad", label: SIGNAL_GATE_LABEL.blocked },
    effectiveness:
      "Effectiveness: unknown from this data. Attributed cost is not causal: it says which recorded touch preceded a sale, not whether the sale needed the spend. Only a randomized experiment can say that.",
    decisionsHref: `/decisions?branch=${encodeURIComponent(branchId)}&period=${periodKey}`,
  };
}
