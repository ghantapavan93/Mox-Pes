import type { Pool } from "pg";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { getNow, withTransaction, type Queryable } from "@/lib/db";
import { SIGNAL_MIN_CUSTOMERS } from "@/lib/metrics/decision";
import { PERIODS, type Period, type PeriodKey } from "@/lib/period";
import { ForbiddenError, resolveScope, type Viewer } from "@/lib/viewer";
import { gamma, quantile, rng, seedFrom } from "./stats";
import { decisionVerdicts, type Reason } from "./verdicts";

/**
 * Budget scenarios: "move $X a month from channel A to channel B at this branch — what happens
 * to new serviced customers and paid-media CAC?"
 *
 * This is a FORECAST FROM OBSERVATIONAL DATA, NOT A CAUSAL ESTIMATE. The baseline is each
 * channel's attributed customers and spend in the period (the same numbers the scorecard and
 * the budget signal use). Every assumption that turns those into a projection is explicit,
 * editable, and returned with the result:
 *
 *   customers_c(S) = customers_c(S₀) · (S / S₀)^β        (diminishing returns, 0 < β ≤ 1)
 *
 *   β = 1 means every extra dollar buys customers at today's average cost; smaller β means the
 *   next dollar buys fewer (the cheapest demand is already being bought). β is not estimated
 *   from this data — one period per branch cannot identify it — so it is shown at three values.
 *
 *   The close rate of the leads the new spend buys is assumed equal to the channel's history
 *   (`closeRateFactor` = 1). Lost spend loses customers at the channel's own historical rate.
 *
 * Uncertainty: each channel's observed customer count is treated as Poisson; its rate gets a
 * Jeffreys posterior Gamma(n + ½, 1). 2,000 seeded Monte Carlo draws give a 90% interval. That
 * interval covers count noise only — not a wrong β, not attribution error, not seasonality.
 */

export const SCENARIO_LABEL = "Forecast from observational data, not causal";
export const MONTH_DAYS = 30;
const DRAWS = 2000;
const INTERVAL = [0.05, 0.95] as const;
/** Beyond this multiple of observed spend, the power law is extrapolating. */
const EXTRAPOLATION_RATIO = 1.5;
/** Readiness checks that belong to one channel (the rest describe the whole branch). */
const CHANNEL_SPECIFIC = new Set(["integrity", "min_customers"]);

export const DEFAULT_ASSUMPTIONS = {
  elasticity: 0.5,
  sensitivityElasticities: [0.3, 0.5, 0.8] as [number, number, number],
  closeRateFactor: 1,
};

const elasticity = z.number().gt(0).lte(1);

export const ScenarioChangeSchema = z
  .object({
    fromChannel: z.string().min(1),
    toChannel: z.string().min(1),
    /** Dollars per 30 days, in integer cents. */
    amountCents: z.number().int().positive().max(100_000_000),
  })
  .refine((c) => c.fromChannel !== c.toChannel, { message: "fromChannel and toChannel must differ" });

export const ScenarioAssumptionsSchema = z.object({
  elasticity: elasticity.default(DEFAULT_ASSUMPTIONS.elasticity),
  sensitivityElasticities: z.tuple([elasticity, elasticity, elasticity]).default(DEFAULT_ASSUMPTIONS.sensitivityElasticities),
  closeRateFactor: z.number().min(0.5).max(1.5).default(DEFAULT_ASSUMPTIONS.closeRateFactor),
});

export const ScenarioRequestSchema = z.object({
  branchId: z.string().regex(/^B\d{2}$/),
  period: z.enum(["oct", "sep", "all"]),
  changes: z.array(ScenarioChangeSchema).min(1).max(4),
  assumptions: ScenarioAssumptionsSchema.default(DEFAULT_ASSUMPTIONS),
});

export type ScenarioChange = z.infer<typeof ScenarioChangeSchema>;
export type ScenarioAssumptions = z.infer<typeof ScenarioAssumptionsSchema>;
export type ScenarioRequest = z.infer<typeof ScenarioRequestSchema>;

/** One channel's observed baseline, already scaled to a 30-day month. */
export interface BaselineChannel {
  channelCode: string;
  label: string;
  spendCents: number;
  /** Attributed serviced new customers per 30 days (scaled from the period's count). */
  customers: number;
  /** The raw count in the period: what the Poisson interval is built on. */
  observedCustomers: number;
}

export interface Range {
  point: number;
  low: number;
  high: number;
}

export interface ProjectedChannel {
  channelCode: string;
  label: string;
  baselineSpendCents: number;
  spendCents: number;
  baselineCustomers: number;
  customers: Range;
  baselineCostPerCustomerCents: number | null;
}

export interface Projection {
  elasticity: number;
  channels: ProjectedChannel[];
  paidCustomers: Range;
  deltaCustomers: Range;
  paidCacCents: { point: number | null; low: number | null; high: number | null };
}

export interface ScenarioResult {
  label: typeof SCENARIO_LABEL;
  branchId: string;
  period: { key: PeriodKey; label: string; days: number };
  computedAt: string;
  decisionReady: boolean;
  /** Readiness failures for the channels this scenario moves money between. */
  blockers: Reason[];
  changes: ScenarioChange[];
  assumptions: ScenarioAssumptions;
  baseline: { monthDays: number; paidSpendCents: number; paidCustomers: number; paidCacCents: number | null; channels: BaselineChannel[] };
  projection: Projection;
  sensitivity: Projection[];
  coverage: { weeksWithSpend: number; spendDays: number; expectedSpendDays: number; reconciledShare: number | null; observedCustomers: number };
  warnings: string[];
  method: string;
}

/**
 * Pure projection. Separated from the database so its arithmetic can be checked by hand.
 * `seed` makes the interval reproducible; the point estimate does not depend on it.
 */
export function projectScenario(
  baseline: BaselineChannel[],
  changes: ScenarioChange[],
  assumptions: Pick<ScenarioAssumptions, "elasticity" | "closeRateFactor">,
  seed: number,
  periodScale: number,
): Projection {
  const byCode = new Map(baseline.map((b) => [b.channelCode, b]));
  const delta = new Map<string, number>();
  for (const ch of changes) {
    if (!byCode.has(ch.fromChannel)) throw new ActionError(`${ch.fromChannel} is not a paid-media channel at this branch`, 400);
    if (!byCode.has(ch.toChannel)) throw new ActionError(`${ch.toChannel} is not a paid-media channel at this branch`, 400);
    delta.set(ch.fromChannel, (delta.get(ch.fromChannel) ?? 0) - ch.amountCents);
    delta.set(ch.toChannel, (delta.get(ch.toChannel) ?? 0) + ch.amountCents);
  }
  const beta = assumptions.elasticity;
  const m = assumptions.closeRateFactor;

  for (const b of baseline) {
    const next = b.spendCents + (delta.get(b.channelCode) ?? 0);
    if (next < 0) {
      throw new ActionError(`Cannot move more than the $${(b.spendCents / 100).toFixed(0)} a month that ${b.label} spends at this branch`, 400);
    }
    if (b.spendCents === 0 && next > 0) {
      throw new ActionError(`${b.label} has no spend at this branch in the period: there is no cost per customer to extrapolate from`, 409);
    }
  }

  /** Customers per month for one channel at a given baseline customer rate. */
  const respond = (b: BaselineChannel, base: number): number => {
    if (b.spendCents === 0) return base;
    const ratio = (b.spendCents + (delta.get(b.channelCode) ?? 0)) / b.spendCents;
    const scaled = base * Math.pow(ratio, beta);
    // New spend buys new leads; their close rate is the explicit assumption. Lost spend loses
    // customers at the channel's historical rate.
    return ratio > 1 ? base + (scaled - base) * m : scaled;
  };

  const paidSpend = baseline.reduce((s, b) => s + b.spendCents, 0);
  const baseCustomers = baseline.reduce((s, b) => s + b.customers, 0);
  const pointByChannel = baseline.map((b) => respond(b, b.customers));
  const pointTotal = pointByChannel.reduce((s, v) => s + v, 0);

  // Monte Carlo over each channel's customer rate: Gamma(n + ½) on the PERIOD count, scaled to
  // the month exactly like the point estimate.
  const next = rng(seed);
  const drawsByChannel = baseline.map(() => [] as number[]);
  const totals: number[] = [];
  const deltas: number[] = [];
  const cacs: number[] = [];
  for (let i = 0; i < DRAWS; i++) {
    let base = 0;
    let projected = 0;
    baseline.forEach((b, k) => {
      // A channel with no spend and no customers has nothing to estimate: it contributes 0, not
      // a Jeffreys draw that would add phantom customers to every total.
      const rate = b.spendCents === 0 && b.observedCustomers === 0 ? 0 : gamma(next, b.observedCustomers + 0.5) * periodScale;
      const p = respond(b, rate);
      drawsByChannel[k].push(p);
      base += rate;
      projected += p;
    });
    totals.push(projected);
    deltas.push(projected - base);
    if (projected > 0) cacs.push(paidSpend / projected);
  }
  // An equal-tailed posterior interval can exclude the observed count when that count is 0 (the
  // Jeffreys posterior puts no mass at exactly 0). The range is widened to include the point
  // estimate instead of showing a range that excludes the number it is a range for.
  const range = (point: number, draws: number[]): Range => {
    const sorted = [...draws].sort((a, b) => a - b);
    return { point, low: Math.min(point, quantile(sorted, INTERVAL[0])), high: Math.max(point, quantile(sorted, INTERVAL[1])) };
  };
  const sortedCac = cacs.sort((a, b) => a - b);
  const cacPoint = pointTotal > 0 ? Math.round(paidSpend / pointTotal) : null;
  const cacBound = (q: number, pick: (a: number, b: number) => number) =>
    sortedCac.length === 0 ? null : Math.round(cacPoint === null ? quantile(sortedCac, q) : pick(cacPoint, quantile(sortedCac, q)));

  return {
    elasticity: beta,
    channels: baseline.map((b, k) => ({
      channelCode: b.channelCode,
      label: b.label,
      baselineSpendCents: b.spendCents,
      spendCents: b.spendCents + (delta.get(b.channelCode) ?? 0),
      baselineCustomers: b.customers,
      customers: range(pointByChannel[k], drawsByChannel[k]),
      baselineCostPerCustomerCents: b.customers > 0 ? Math.round(b.spendCents / b.customers) : null,
    })),
    paidCustomers: range(pointTotal, totals),
    deltaCustomers: range(pointTotal - baseCustomers, deltas),
    // Fewer customers → higher CAC, so the CAC interval is read off the same draws.
    paidCacCents: { point: cacPoint, low: cacBound(INTERVAL[0], Math.min), high: cacBound(INTERVAL[1], Math.max) },
  };
}

/**
 * Computes a scenario for one branch from SQL. Readiness is checked, never enforced: a scenario
 * that is not decision-ready still computes, and says so with the blockers attached.
 */
export async function scenario(db: Queryable, viewer: Viewer, request: ScenarioRequest): Promise<ScenarioResult> {
  if (!viewer.can.investigate && !viewer.can.propose) throw new ForbiddenError(`${viewer.label} cannot model budget scenarios`);
  resolveScope(viewer, request.branchId);
  const period: Period = PERIODS[request.period];
  const assumptions = ScenarioAssumptionsSchema.parse(request.assumptions);
  const verdicts = await decisionVerdicts(db, viewer, { branchId: request.branchId, period });

  const days = Math.round((period.to.getTime() - period.from.getTime()) / 86_400_000);
  const periodScale = MONTH_DAYS / days;
  const baseline: BaselineChannel[] = verdicts.channels.map((c) => ({
    channelCode: c.channelCode,
    label: c.label,
    spendCents: Math.round(c.spendCents * periodScale),
    customers: c.acquired * periodScale,
    observedCustomers: c.acquired,
  }));

  // One seed for the main projection and every sensitivity row (common random numbers): rows
  // then differ only by β, not by Monte Carlo noise, so they can be compared with each other.
  const seed = seedFrom(JSON.stringify([request.branchId, request.period, request.changes, assumptions, baseline]));
  const projection = projectScenario(baseline, request.changes, assumptions, seed, periodScale);
  const sensitivity = [...assumptions.sensitivityElasticities]
    .sort((a, b) => a - b)
    .map((beta) => projectScenario(baseline, request.changes, { ...assumptions, elasticity: beta }, seed, periodScale));

  const involved = new Set(request.changes.flatMap((c) => [c.fromChannel, c.toChannel]));
  const involvedVerdicts = verdicts.channels.filter((c) => involved.has(c.channelCode));
  const seen = new Set<string>();
  const blockers: Reason[] = [];
  for (const c of involvedVerdicts) {
    for (const b of c.readiness.blockers) {
      // Channel-specific blockers are kept per channel; branch-wide ones (a gating incident, a
      // stale feed) appear once, not once per channel.
      const key = CHANNEL_SPECIFIC.has(b.code) ? `${c.channelCode}|${b.code}` : `${b.code}|${b.href ?? b.text}`;
      if (seen.has(key)) continue;
      seen.add(key);
      blockers.push(b);
    }
  }

  const warnings: string[] = [];
  for (const ch of projection.channels) {
    const ratio = ch.baselineSpendCents > 0 ? ch.spendCents / ch.baselineSpendCents : 1;
    if (ratio > EXTRAPOLATION_RATIO) {
      warnings.push(`${ch.label} spend would be ${ratio.toFixed(1)}× its observed level: the response curve is extrapolated well beyond anything in the data.`);
    }
  }
  for (const c of involvedVerdicts) {
    if (c.acquired < SIGNAL_MIN_CUSTOMERS) {
      warnings.push(`${c.label} has ${c.acquired} observed customer${c.acquired === 1 ? "" : "s"} in the period: its cost per customer is mostly noise and the interval is wide.`);
    }
  }

  const coverageRows = involvedVerdicts.map((c) => c.integrity.coverage);
  const paidSpendCents = baseline.reduce((s, b) => s + b.spendCents, 0);
  const paidCustomers = baseline.reduce((s, b) => s + b.customers, 0);

  return {
    label: SCENARIO_LABEL,
    branchId: request.branchId,
    period: { key: period.key, label: period.label, days },
    computedAt: (await getNow(db)).toISOString(),
    decisionReady: blockers.length === 0,
    blockers,
    changes: request.changes,
    assumptions,
    baseline: {
      monthDays: MONTH_DAYS,
      paidSpendCents,
      paidCustomers,
      paidCacCents: paidCustomers > 0 ? Math.round(paidSpendCents / paidCustomers) : null,
      channels: baseline,
    },
    projection,
    sensitivity,
    coverage: {
      weeksWithSpend: Math.min(...coverageRows.map((c) => c.weeksWithSpend)),
      spendDays: Math.min(...coverageRows.map((c) => c.spendDays)),
      expectedSpendDays: coverageRows[0]?.expectedSpendDays ?? 0,
      reconciledShare: coverageRows[0]?.reconciledShare ?? null,
      observedCustomers: involvedVerdicts.reduce((s, c) => s + c.acquired, 0),
    },
    warnings,
    method:
      `customers_c(S) = customers_c(S₀)·(S/S₀)^β per paid channel; baseline = attributed serviced new customers and spend in ${period.label}, ` +
      `scaled to ${MONTH_DAYS} days. 90% interval: ${DRAWS.toLocaleString("en-US")} seeded draws (seed ${seed}) of each channel's customer rate from Gamma(n + ½, 1). ` +
      "Count noise only: β, close rates and attribution are assumptions, not estimates.",
  };
}

export interface SavedScenario {
  id: number;
  branchId: string;
  periodKey: PeriodKey;
  decisionReady: boolean;
  actor: string;
  createdAt: string;
  result: ScenarioResult;
}

/**
 * Computes and stores a scenario with its parameters, full result and the actor, plus an audit
 * row, in one transaction. The stored result is what the person saw; it is never recomputed.
 */
export async function saveScenario(pool: Pool, viewer: Viewer, request: ScenarioRequest): Promise<SavedScenario> {
  return withTransaction(pool, async (tx) => {
    const result = await scenario(tx, viewer, request);
    const now = await getNow(tx);
    const { rows } = await tx.query<{ id: string }>(
      `insert into decision_scenarios (branch_id, period_key, params, result, decision_ready, actor, created_at)
       values ($1, $2, $3, $4, $5, $6, $7) returning id`,
      [request.branchId, request.period, { changes: request.changes, assumptions: result.assumptions }, result, result.decisionReady, viewer.role, now],
    );
    const id = Number(rows[0].id);
    await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'save_scenario', $3, $4)", [
      now,
      viewer.role,
      `decision_scenario:${id}`,
      {
        branchId: request.branchId,
        period: request.period,
        changes: request.changes,
        decisionReady: result.decisionReady,
        deltaCustomers: result.projection.deltaCustomers,
        label: SCENARIO_LABEL,
      },
    ]);
    return { id, branchId: request.branchId, periodKey: request.period, decisionReady: result.decisionReady, actor: viewer.role, createdAt: now.toISOString(), result };
  });
}

/** Saved scenarios in the viewer's scope, newest first. Asking for another branch is refused. */
export async function listScenarios(db: Queryable, viewer: Viewer, args: { branchId?: string | null; limit?: number } = {}): Promise<SavedScenario[]> {
  const branchIds = resolveScope(viewer, args.branchId ?? null);
  const { rows } = await db.query(
    `select id, branch_id, period_key, decision_ready, actor, created_at, result from decision_scenarios
     where $1::text[] is null or branch_id = any($1::text[])
     order by created_at desc, id desc limit $2`,
    [branchIds, args.limit ?? 20],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    branchId: r.branch_id,
    periodKey: r.period_key,
    decisionReady: r.decision_ready,
    actor: r.actor,
    createdAt: (r.created_at as Date).toISOString(),
    result: r.result as ScenarioResult,
  }));
}
