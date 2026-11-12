/**
 * Typed metric facts: what a tool said a metric IS, for which entity and period, in which unit.
 *
 * A number appearing in a tool output is not a fact about anything in particular. A metric fact
 * is: paid CAC (definition v2) of branch B09 in October = 24129 cents, currency established or
 * not, cited by these evidence ids. Facts are read only from the structured fields of the metric
 * tools (getBranchMetrics, getMetricComparison, getMetricTrace), never from text, names or
 * notes. Claims are proved against them (lib/ai/proof.ts).
 */
import { METRICS } from "@/lib/metrics/definitions";
import type { PeriodKey } from "@/lib/period";
import { CHANNEL_BY_CODE, type ChannelCode } from "@/lib/reference";

export type MetricKey =
  | "paidSpend"
  | "paidAcquired"
  | "acquired"
  | "unknownAcquired"
  | "paidCac"
  | "unknownShare"
  | "collected"
  | "refunds"
  | "grossCollected"
  | "newCollected"
  | "atRisk"
  | "prospects"
  | "campaignSpend"
  | "campaignAcquired"
  | "channelSpend"
  | "channelAcquired"
  | "channelCac";

export type Unit = "usd_cents" | "count" | "ratio";

export const METRIC_UNIT: Record<MetricKey, Unit> = {
  paidSpend: "usd_cents",
  paidAcquired: "count",
  acquired: "count",
  unknownAcquired: "count",
  paidCac: "usd_cents",
  unknownShare: "ratio",
  collected: "usd_cents",
  refunds: "usd_cents",
  grossCollected: "usd_cents",
  newCollected: "usd_cents",
  atRisk: "usd_cents",
  prospects: "count",
  campaignSpend: "usd_cents",
  campaignAcquired: "count",
  channelSpend: "usd_cents",
  channelAcquired: "count",
  channelCac: "usd_cents",
};

/** Human names, used in proofs. */
export const METRIC_NAME: Record<MetricKey, string> = {
  paidSpend: "paid media spend",
  paidAcquired: "new paid customers",
  acquired: "new customers serviced",
  unknownAcquired: "new customers with channel unknown",
  paidCac: "paid-media CAC",
  unknownShare: "unattributed share",
  collected: "collected cash (payments − refunds)",
  refunds: "refunds",
  grossCollected: "gross payments (before refunds)",
  newCollected: "collected to date from the period's new customers",
  atRisk: "revenue in open exceptions",
  prospects: "unique prospects",
  campaignSpend: "campaign media spend",
  campaignAcquired: "paid customers credited to the campaign",
  channelSpend: "channel media spend",
  channelAcquired: "channel new customers",
  channelCac: "channel cost per new customer",
};

export interface MetricFact {
  metric: MetricKey;
  /** A channel's id is "<branch>:<channel code>"; its label ("Google Local Services") is how text names it. */
  entity: { type: "branch" | "campaign" | "channel"; id: string; label?: string };
  period: PeriodKey;
  /** usd_cents: integer cents; count: integer; ratio: a fraction (0.144). Null = not defined (e.g. CAC with no customers). */
  value: number | null;
  unit: Unit;
  /** False when some of the money behind it came from a feed that did not state its currency. */
  currencyResolved: boolean;
  /** Why the figure, though correct as stored, leaves something out (records held at intake), or null. */
  incompleteReason?: string | null;
  definitionVersion: string | null;
  evidenceIds: string[];
  tool: string;
}

const isPeriod = (v: unknown): v is PeriodKey => v === "oct" || v === "sep" || v === "all";
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : typeof v === "string" && /^-?\d+(?:\.\d+)?$/.test(v) ? Number(v) : null);
const version = (key: string) => METRICS[key]?.version ?? null;

/** Facts from one getBranchMetrics-shaped object (also the two sides of getMetricComparison). */
function branchMetricFacts(d: Record<string, unknown>, evidenceIds: string[], tool: string, currencyResolved: boolean): MetricFact[] {
  const branchId = typeof d.branchId === "string" ? d.branchId : null;
  const period = (d.period as { key?: unknown } | undefined)?.key;
  if (!branchId || !isPeriod(period)) return [];
  const out: MetricFact[] = [];
  const add = (metric: MetricKey, value: number | null, defKey: string | null) =>
    out.push({ metric, entity: { type: "branch", id: branchId }, period, value, unit: METRIC_UNIT[metric], currencyResolved: METRIC_UNIT[metric] === "usd_cents" ? currencyResolved : true, definitionVersion: defKey ? version(defKey) : null, evidenceIds, tool });
  const collected = num(d.collectedCents);
  const refunds = num(d.refundsCents);
  add("paidSpend", num(d.paidSpendCents), "paidSpend");
  add("paidAcquired", num(d.paidAcquired), "paidCac");
  add("acquired", num(d.acquired), "acquired");
  add("unknownAcquired", num(d.unknownAcquired), "unknownShare");
  add("paidCac", d.paidCacCents === null ? null : num(d.paidCacCents), "paidCac");
  // Customers whose campaign's spend is held at intake are out of the CAC, and so is their cost:
  // the figures are right as stored but leave that campaign out.
  const heldOut = num(d.paidAcquiredHeldOut) ?? 0;
  // Customers counted whose campaign has SOME days' spend held: the cost is understated, so the
  // CAC reads low (review 2026-11-12, financial finding 4).
  const partlyHeld = num(d.paidAcquiredPartlyHeld) ?? 0;
  const reasons = [
    ...(heldOut > 0 ? [`${heldOut} paid customer(s) credited to campaigns whose spend is held at intake (another or no stated currency) are left out, with their cost`] : []),
    ...(partlyHeld > 0 ? [`${partlyHeld} paid customer(s) are credited to campaigns with some days' spend held at intake, so that cost is missing and the CAC is understated`] : []),
  ];
  if (reasons.length > 0) {
    const reason = reasons.join("; ");
    for (const f of out) if (f.metric === "paidSpend" || f.metric === "paidAcquired" || f.metric === "paidCac") f.incompleteReason = reason;
  }
  add("unknownShare", d.unknownShare === null ? null : num(d.unknownShare), "unknownShare");
  // Collected money comes from the CRM in USD; the currency question applies to ad spend.
  out.push({ metric: "collected", entity: { type: "branch", id: branchId }, period, value: collected, unit: "usd_cents", currencyResolved: true, definitionVersion: version("collected"), evidenceIds, tool });
  out.push({ metric: "refunds", entity: { type: "branch", id: branchId }, period, value: refunds, unit: "usd_cents", currencyResolved: true, definitionVersion: version("collected"), evidenceIds, tool });
  if (collected !== null && refunds !== null) out.push({ metric: "grossCollected", entity: { type: "branch", id: branchId }, period, value: collected + refunds, unit: "usd_cents", currencyResolved: true, definitionVersion: version("collected"), evidenceIds, tool });
  if (d.atRiskCents !== undefined) out.push({ metric: "atRisk", entity: { type: "branch", id: branchId }, period, value: num(d.atRiskCents), unit: "usd_cents", currencyResolved: true, definitionVersion: version("atRisk"), evidenceIds, tool });
  if (d.prospects !== undefined) add("prospects", num(d.prospects), "prospects");
  // Per channel: cited by the channel's own evidence id (or the branch's).
  const channels = Array.isArray(d.channels) ? (d.channels as Array<Record<string, unknown>>) : [];
  for (const c of channels) {
    if (typeof c.channelCode !== "string") continue;
    const entity = { type: "channel" as const, id: `${branchId}:${c.channelCode}`, label: typeof c.label === "string" ? c.label : c.channelCode };
    const ids = [...evidenceIds.filter((id) => id.startsWith("branch_metrics:") || id.endsWith(`:${c.channelCode}`))];
    const ch = (metric: MetricKey, value: number | null, money: boolean) =>
      out.push({ metric, entity, period, value, unit: METRIC_UNIT[metric], currencyResolved: money ? currencyResolved : true, definitionVersion: version("paidCac"), evidenceIds: ids, tool });
    ch("channelSpend", num(c.spendCents), true);
    ch("channelAcquired", num(c.acquired), false);
    ch("channelCac", c.cacCents === null ? null : num(c.cacCents), true);
  }
  return out;
}

/**
 * Status facts: what the tools said about readiness and freshness, which statements such as
 * "Google Search is decision-ready" or "its payment records are complete" are checked against.
 */
export interface StatusFacts {
  readiness: Array<{ branchId: string; period: PeriodKey; channelCode: string; label: string; ready: boolean; status: string; evidenceIds: string[] }>;
  budgetSignal: Array<{ branchId: string; period: PeriodKey; trustworthy: boolean; evidenceIds: string[] }>;
  streams: Array<{ stream: string; source: string; stale: boolean; hoursSinceSuccess: number | null; staleAfterHours: number | null; evidenceIds: string[] }>;
}

export function statusFacts(steps: ReadonlyArray<{ kind: string; status: string; tool: string | null; output: unknown; evidenceIds: string[] }>): StatusFacts {
  const out: StatusFacts = { readiness: [], budgetSignal: [], streams: [] };
  for (const s of steps) {
    if (s.kind !== "tool_call" || s.status !== "ok" || !s.output || typeof s.output !== "object") continue;
    const d = s.output as Record<string, unknown>;
    if (s.tool === "getDecisionReadiness" && typeof d.branchId === "string" && isPeriod(d.period)) {
      const branchId = d.branchId;
      const period = d.period;
      const signal = d.budgetSignal as { trustworthy?: unknown } | undefined;
      if (typeof signal?.trustworthy === "boolean") out.budgetSignal.push({ branchId, period, trustworthy: signal.trustworthy, evidenceIds: s.evidenceIds });
      for (const c of (d.channels as Array<Record<string, unknown>> | undefined) ?? []) {
        const status = (c.readiness as { status?: unknown } | undefined)?.status;
        if (typeof c.channelCode !== "string" || typeof status !== "string") continue;
        out.readiness.push({ branchId, period, channelCode: c.channelCode, label: typeof c.label === "string" ? c.label : c.channelCode, ready: status === "ready", status, evidenceIds: s.evidenceIds.filter((id) => id.endsWith(`:${c.channelCode}`) || id.startsWith("exception:")) });
      }
    }
    for (const st of (d.streams as Array<Record<string, unknown>> | undefined) ?? []) {
      if (typeof st.stream !== "string") continue;
      const hoursSince = num(st.hoursSinceSuccess);
      const limit = num(st.staleAfterHours);
      const stale = st.lastRunStatus === "failed" || hoursSince === null || (limit !== null && hoursSince > limit);
      out.streams.push({ stream: st.stream, source: typeof st.source === "string" ? st.source : st.stream, stale, hoursSinceSuccess: hoursSince, staleAfterHours: limit, evidenceIds: s.evidenceIds });
    }
  }
  return out;
}

/**
 * The ids that cite a trace's FIGURES: its aggregate ids (the branch's or channel's metrics, the
 * metric's definition), not the sample records it lists. A claim citing one sampled payment, raw
 * event or customer is evidence about that record, not about the branch's total, so it must not
 * pick up every figure of the trace (review 2026-11-12, AI-claims finding 16).
 */
const AGGREGATE_ID = /^(?:branch_metrics|channel_metrics|metric_definition):/;
const aggregateIds = (ids: readonly string[]) => ids.filter((id) => AGGREGATE_ID.test(id));

/** The typed metric facts the recorded tool calls of one investigation established. */
export function metricFacts(steps: ReadonlyArray<{ kind: string; status: string; tool: string | null; output: unknown; evidenceIds: string[] }>): MetricFact[] {
  const facts: MetricFact[] = [];
  for (const s of steps) {
    if (s.kind !== "tool_call" || s.status !== "ok" || !s.output || typeof s.output !== "object") continue;
    const d = s.output as Record<string, unknown>;
    if (s.tool === "getBranchMetrics") facts.push(...branchMetricFacts(d, s.evidenceIds, s.tool, d.currencyResolved !== false));
    if (s.tool === "getCashTrace") {
      // Reproduced from payment records; a trace that does not reproduce is a conflict, not a fact.
      const scope = d.scope as { branchId?: string; period?: { key?: unknown } } | undefined;
      const value = d.value as { reproduced?: Record<string, unknown>; matches?: unknown } | undefined;
      const period = scope?.period?.key;
      if (typeof scope?.branchId === "string" && isPeriod(period) && value?.reproduced && value.matches === true) {
        const entity = { type: "branch" as const, id: scope.branchId };
        const ids = aggregateIds(s.evidenceIds);
        const cash = (metric: MetricKey, v: unknown, def: string) => facts.push({ metric, entity, period, value: num(v), unit: "usd_cents", currencyResolved: true, definitionVersion: version(def), evidenceIds: ids, tool: s.tool as string });
        cash("collected", value.reproduced.collectedCents, "collected");
        cash("refunds", value.reproduced.refundsCents, "collected");
        cash("grossCollected", value.reproduced.grossCents, "collected");
        cash("newCollected", value.reproduced.newCollectedCents, "newCollected");
        cash("atRisk", value.reproduced.atRiskCents, "atRisk");
      }
    }
    if (s.tool === "getBrandMetrics") {
      // Each branch of the brand is its own fact, cited by its own id; totals are proved as sums.
      for (const row of (d.branches as Array<Record<string, unknown>> | undefined) ?? []) {
        const id = typeof row.branchId === "string" ? row.branchId : "";
        facts.push(...branchMetricFacts(row, s.evidenceIds.filter((e) => e.startsWith(`branch_metrics:${id}:`)), s.tool, row.currencyResolved !== false));
      }
    }
    if (s.tool === "getMetricComparison") {
      for (const side of [d.before, d.after]) if (side && typeof side === "object") facts.push(...branchMetricFacts(side as Record<string, unknown>, s.evidenceIds, s.tool, (side as Record<string, unknown>).currencyResolved !== false));
    }
    if (s.tool === "getMetricTrace") {
      const scope = d.scope as { branchId?: string; period?: { key?: unknown } } | undefined;
      const period = scope?.period?.key;
      const branchId = scope?.branchId;
      const reproduced = (d.value as { reproduced?: Record<string, unknown> } | undefined)?.reproduced;
      const campaigns = (d.campaigns as Array<Record<string, unknown>> | undefined) ?? [];
      if (!branchId || !isPeriod(period) || !reproduced) continue;
      const resolved = campaigns.every((c) => !num(c.assumedCurrencyCents)) && Number(d.campaignsOmitted ?? 0) === 0;
      const held = ((d.excluded as Array<{ code?: string; count?: number }> | undefined) ?? []).find((e) => e.code === "CAMPAIGN_SPEND_HELD");
      const incompleteReason = held ? `${held.count} paid customer(s) credited to campaigns whose spend is held at intake (another or no stated currency) are left out, with their cost` : null;
      const ownIds = aggregateIds(s.evidenceIds);
      const base = { entity: { type: "branch" as const, id: branchId }, period, evidenceIds: ownIds, tool: s.tool, incompleteReason };
      facts.push({ ...base, metric: "paidSpend", value: num(reproduced.paidSpendCents), unit: "usd_cents", currencyResolved: resolved, definitionVersion: version("paidSpend") });
      // A spend trace does not trace the denominator: only a CAC trace states paid customers and CAC.
      if ((d.metric as { key?: unknown } | undefined)?.key !== "paid_spend") {
        facts.push({ ...base, metric: "paidAcquired", value: num(reproduced.paidAcquired), unit: "count", currencyResolved: true, definitionVersion: version("paidCac") });
        facts.push({ ...base, metric: "paidCac", value: reproduced.paidCacCents === null ? null : num(reproduced.paidCacCents), unit: "usd_cents", currencyResolved: resolved, definitionVersion: version("paidCac") });
      }
      for (const c of campaigns) {
        if (typeof c.externalCampaignId !== "string") continue;
        // A campaign's figures are cited by the trace's aggregate ids or the campaign's own.
        const campaignIds = typeof c.evidenceId === "string" ? [...ownIds, c.evidenceId] : ownIds;
        facts.push({ metric: "campaignSpend", entity: { type: "campaign", id: c.externalCampaignId }, period, value: num(c.spendCents), unit: "usd_cents", currencyResolved: !num(c.assumedCurrencyCents), definitionVersion: version("paidSpend"), evidenceIds: campaignIds, tool: s.tool });
        if (typeof c.paidCustomersCredited === "number") {
          facts.push({ metric: "campaignAcquired", entity: { type: "campaign", id: c.externalCampaignId }, period, value: c.paidCustomersCredited, unit: "count", currencyResolved: true, definitionVersion: version("paidCac"), evidenceIds: campaignIds, tool: s.tool });
        }
      }
      // A channel's spend is the sum of its campaigns, when every campaign is listed.
      if (Number(d.campaignsOmitted ?? 0) === 0) {
        const byChannel = new Map<string, { cents: number; resolved: boolean }>();
        for (const c of campaigns) {
          if (typeof c.channelCode !== "string") continue;
          const prev = byChannel.get(c.channelCode) ?? { cents: 0, resolved: true };
          byChannel.set(c.channelCode, { cents: prev.cents + (num(c.spendCents) ?? 0), resolved: prev.resolved && !num(c.assumedCurrencyCents) });
        }
        for (const [code, v] of byChannel) {
          const label = CHANNEL_BY_CODE.get(code as ChannelCode)?.label ?? code;
          facts.push({ metric: "channelSpend", entity: { type: "channel", id: `${branchId}:${code}`, label }, period, value: v.cents, unit: "usd_cents", currencyResolved: v.resolved, definitionVersion: version("paidSpend"), evidenceIds: ownIds, tool: s.tool });
        }
      }
    }
  }
  return facts;
}
