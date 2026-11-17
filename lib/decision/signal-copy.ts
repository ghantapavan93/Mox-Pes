import { SIGNAL_RATIO, type BudgetSignal } from "@/lib/metrics/decision";
import type { PeriodKey } from "@/lib/period";

/**
 * What the budget-signal card, the Decision Lab note and the scenario builder may say, kept in one
 * place so no surface drifts from another. Every sentence comes from the gate's three outcomes
 * (`budgetSignal`, lib/metrics/decision.ts): the facts per channel, the comparison and the
 * recommendation. No surface labels them on its own.
 *
 * The budget signal compares ATTRIBUTED cost per new customer (first evidenced touch). That supports:
 *   - an observation: "X costs N× Y per attributed new customer", branch-wide or among the verified
 *     channels only, naming what is left out and why;
 *   - a data-integrity gate: "no blocking incidents" (or the incidents that block it);
 *   - whether the comparison may carry a recommendation at all, or what holds it.
 * It never recommends moving budget, and never says the evidence is "sound": decision readiness
 * (integrity, minimum customers, feed freshness per channel) and business effectiveness (randomized
 * experiments only) are verdicts of the Decision Lab, which the card links to instead of paraphrasing.
 */

export const SIGNAL_GATE_LABEL = {
  /** No open exception that changes what a paid channel here cost or which customers it produced. */
  clear: "Data integrity: no blocking incidents",
  blocked: "Not trustworthy yet",
} as const;

type SignalInput = Pick<BudgetSignal, "signal" | "ratio" | "from" | "to" | "trustworthy" | "comparison" | "excluded" | "recommendation">;

export interface BudgetSignalCopy {
  headline: string;
  gate: { tone: "good" | "bad"; label: string };
  /** While an incident gates the signal: the sentence before its incidents. Null when none does. */
  blocked: string | null;
  /**
   * The raw ratio, named as not valid, when it pairs a channel the comparison leaves out (a blocked
   * ratio): what the incident or the missing cost distorts, said once and never as the comparison.
   * Null when the raw ratio is the comparison, or shows no shift.
   */
  invalid: string | null;
  /**
   * When no incident gates the signal but the records still hold the recommendation (a left-out
   * channel's cost is missing): what holds it, so "no blocking incidents" is never read as "free to
   * act". Null when an incident gates it (the card lists the incidents) or nothing holds it.
   */
  decision: { tone: "warn" | "neutral"; label: string; text: string } | null;
  /** Channels the comparison leaves out, each with its reason in full. */
  excluded: string[];
  /** Always shown: attributed cost says nothing about whether the spend caused the customers. */
  effectiveness: string;
  /** The Decision Lab for the same branch and period, where readiness and effectiveness live. */
  decisionsHref: string;
}

const names = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The comparison, in words, as the gate decided it (outcome 2). */
function headlineOf(s: SignalInput, branchId: string): string {
  const c = s.comparison;
  const left = s.excluded.map((x) => x.label);
  const ratioText = (from: string, ratio: number, to: string) => `${from} costs ${ratio.toFixed(1)}× ${to} per attributed new customer (first evidenced touch)`;
  if (c.basis === "verified") {
    if (c.compared.length < 2) {
      return `Fewer than two paid channels at ${branchId} can be compared on verified figures: ${names(left)} ${left.length === 1 ? "is" : "are"} left out.`;
    }
    const could = s.excluded.some((x) => x.reasons.some((r) => r.couldChange));
    const tail = could
      ? `Not a branch-wide ranking: ${names(left)} ${left.length === 1 ? "is" : "are"} left out.`
      : `${names(left)} ${left.length === 1 ? "is" : "are"} left out, by records that cannot change this comparison.`;
    return c.signal === "shift" && c.from && c.to && c.ratio !== null
      ? `Among verified channels, ${ratioText(c.from.label, c.ratio, c.to.label)}. ${tail}`
      : `Among verified channels, none costs ${SIGNAL_RATIO}× another per attributed new customer (first evidenced touch). ${tail}`;
  }
  // "branch" (every covered channel compared) and "unverified" (behind the gate) read as before.
  return c.signal === "shift" && c.from && c.to && c.ratio !== null
    ? `${ratioText(c.from.label, c.ratio, c.to.label)}. An observation, not a recommendation.`
    : `No paid channel at this branch costs ${SIGNAL_RATIO}× another per attributed new customer (first evidenced touch).`;
}

export function budgetSignalCopy(signal: SignalInput, branchId: string, periodKey: PeriodKey): BudgetSignalCopy {
  const r = signal.recommendation;
  // The channels whose missing cost holds it (their reasons are listed in full under "left out").
  const holding = [...new Set(r.heldBy.filter((h) => h.exceptionId === null).map((h) => signal.excluded.find((x) => x.channelCode === h.channelCode)?.label ?? h.channelCode ?? ""))];
  const one = holding.length === 1;
  // The channels the incidents touch. When the comparison leaves them out ("verified"), the number
  // shown is not theirs: say that the incidents still hold every move, and whose cost they change.
  const touched = signal.excluded.filter((x) => x.reasons.some((r) => r.code === "incident" || r.code === "refused" || r.href?.startsWith("/exceptions/"))).map((x) => x.label);
  // The raw observation pairs a left-out channel: a blocked ratio. Named as such, beside the comparison.
  const pairLeftOut = signal.signal === "shift" && signal.from && signal.to ? signal.excluded.filter((x) => x.channelCode === signal.from!.channelCode || x.channelCode === signal.to!.channelCode) : [];
  const invalid =
    pairLeftOut.length > 0 && signal.from && signal.to && signal.ratio !== null
      ? `Not a valid comparison: ${signal.from.label} costs ${signal.ratio.toFixed(1)}× ${signal.to.label} per attributed new customer (first evidenced touch), but ${names(pairLeftOut.map((x) => x.label))} ${pairLeftOut.length === 1 ? "is" : "are"} left out (${[...new Set(pairLeftOut.flatMap((x) => x.reasons.map((r) => r.short)))].join(", ")}).`
      : null;
  return {
    invalid,
    headline: headlineOf(signal, branchId),
    gate: signal.trustworthy ? { tone: "good", label: SIGNAL_GATE_LABEL.clear } : { tone: "bad", label: SIGNAL_GATE_LABEL.blocked },
    blocked: signal.trustworthy
      ? null
      : signal.comparison.basis === "verified" && touched.length > 0
        ? `Do not move budget at ${branchId} yet. Open incidents hold every move here; they change what ${names(touched)} cost or which customers ${touched.length === 1 ? "it" : "they"} produced:`
        : "Do not act on this number. Open incidents change what these channels cost or which customers they produced:",
    decision:
      signal.trustworthy && r.status === "held"
        ? {
            tone: "warn",
            label: "Branch-wide recommendation held",
            text: `${names(holding)} ${one ? "is" : "are"} left out, and ${one ? "its" : "their"} missing cost could change which channel is cheapest or most expensive. ${
              signal.comparison.compared.length >= 2 ? "A move between the verified channels can still be reviewed in the Decision Lab; " : ""
            }a move involving ${names(holding)} cannot until ${one ? "its" : "their"} cost here is known.`,
          }
        : null,
    excluded: signal.excluded.map((x) => `${x.label} (${x.acquired.toLocaleString("en-US")} customer${x.acquired === 1 ? "" : "s"}): ${x.reasons.map((r) => r.text).join(" ")}`),
    effectiveness:
      "Effectiveness: unknown from this data. Attributed cost is not causal: it says which recorded touch preceded a sale, not whether the sale needed the spend. Only a randomized experiment can say that.",
    decisionsHref: `/decisions?branch=${encodeURIComponent(branchId)}&period=${periodKey}`,
  };
}

/** The Decision Lab's one-line note beside the verdicts, from the same outcomes as the card. */
export function budgetSignalNote(signal: SignalInput): { text: string; badge: string; tone: "good" | "bad" | "warn" } {
  const c = signal.comparison;
  const pair = c.signal === "shift" && c.from && c.to && c.ratio !== null ? `${c.from.label} costs ${c.ratio.toFixed(1)}× ${c.to.label} per customer` : null;
  const text =
    c.basis === "verified"
      ? c.compared.length < 2
        ? `Budget signal: fewer than two channels can be compared (${names(signal.excluded.map((x) => x.label))} left out)`
        : `Budget signal, among verified channels: ${pair ?? "no shift signalled"} (${names(signal.excluded.map((x) => x.label))} left out)`
      : pair
        ? `Budget signal: ${pair}`
        : "Budget signal: no shift signalled";
  if (!signal.trustworthy) return { text, badge: "gated", tone: "bad" };
  if (signal.recommendation.status === "held") return { text, badge: "recommendation held", tone: "warn" };
  return { text, badge: "gate open", tone: "good" };
}

/**
 * The move the scenario builder starts on. The gate's recommended pair only when nothing holds it;
 * with no shift signalled and nothing held, the two largest channels (a neutral start, as before).
 * While anything holds the recommendation nothing is preselected: a default would read as a
 * recommendation of the very move the open incident or the missing cost could change (UX red team
 * 2026-11-12, and the held Local Services case at B03, 2026-11-17).
 */
export function builderDefaults(signal: Pick<BudgetSignal, "comparison" | "recommendation">, bySpend: string[]): { from: string; to: string } {
  const r = signal.recommendation;
  if (r.status === "held") return { from: "", to: "" };
  if (r.status === "shift" && signal.comparison.from && signal.comparison.to) return { from: signal.comparison.from.channelCode, to: signal.comparison.to.channelCode };
  return { from: bySpend[0] ?? "", to: bySpend[1] ?? "" };
}

/** The cell beside a channel's CAC: why it has none, or why it cannot carry a decision. */
export function cacNote(reasons: Array<{ short: string }>): string | null {
  return reasons.length === 0 ? null : [...new Set(reasons.map((r) => r.short))].join(" · ");
}
