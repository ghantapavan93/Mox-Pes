import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { z } from "zod";
import { getNow, withTransaction, type Queryable } from "@/lib/db";
import { PERIODS, type Period, type PeriodKey } from "@/lib/period";
import { requirePermission, resolveScope, type Viewer } from "@/lib/viewer";
import { proportionDiff, sampleRatioTest, type ProportionDiff, type SampleRatioTest } from "./stats";

/**
 * A/A analysis self-check: exercises the analysis code, not an experimentation pipeline.
 *
 * Synthetic website leads are split into two arms by hashing each lead id AT ANALYSIS TIME, over
 * the same rows that are then analysed. No arm is logged when the lead arrives and no treatment or
 * exposure exists, so the two arms are identical by construction. What this checks: the unit
 * definition, the outcome join and the statistics (SRM test, difference with 95% CI, guardrail)
 * should find the designed 50/50 split and no difference beyond chance. Analysis code that "finds"
 * an effect here would find fake effects in a real test too.
 *
 * What it cannot check: assignment or exposure logging. The SRM test compares a hash split of
 * the analysed rows with itself, so it can only fail by chance or if the hash or the unit
 * definition is broken; a real pipeline check needs arms persisted at lead ingest (roadmap §3,
 * `experiment_assignments`) and analysed against those logged arms.
 *
 * Definitions (stated once, stored with every run):
 *   unit        a prospect's FIRST web lead in the period, in the viewer's branch scope (one unit
 *               per person, so one person cannot sit in both arms)
 *   assignment  arm = A when sha256("<salt>:web:<source lead id>") read as a uint32 / 2³² < 0.5,
 *               else B. Stable: the same salt and lead always land in the same arm.
 *   mature      lead time + N days ≤ the business clock; immature units are excluded (their
 *               outcome window has not closed) and counted separately
 *   outcome     the lead's prospect (same phone hash or email hash) became a NEW customer: a first
 *               subscription (v_acquisitions) sold within [lead − 2 h, lead + N days] whose initial
 *               service was completed by lead + N days. Credited channel is irrelevant.
 *   guardrail   refund rate among converted units: the customer has a successful refund
 *               (negative payment) recorded by the business clock.
 *
 * This analysis is kept apart from scenario forecasts (observational). They are never mixed.
 */

export const AA_DEFAULTS = { windowDays: 14, salt: "aa-web-v1", expectedShareA: 0.5 };

/** Shown with every result, live or stored. */
export const AA_LABEL = "A/A analysis self-check (statistics only)";

/** What this analysis cannot detect, stated with every result so it is never read as more. */
export const AA_LIMITATION =
  "Arms are computed at analysis time from a hash of each lead id; no assignment is logged at lead time and no treatment or exposure exists. " +
  "This checks the unit definition, outcome join and statistics only: it cannot detect assignment or exposure-logging faults.";
/** Sample-ratio mismatch is flagged at p < 0.001, the conventional strict threshold. */
export const SRM_ALPHA = 0.001;
/** Below this many mature units per arm the comparison is not reported as a finding. */
export const MIN_UNITS_PER_ARM = 30;

export const OUTCOME_DEFINITION =
  "Converted = the lead's prospect (same phone or email hash) became a new customer: first subscription sold within [lead − 2 h, lead + N days] with its initial service completed by lead + N days.";

export const AaRequestSchema = z.object({
  period: z.enum(["oct", "sep", "all"]),
  windowDays: z.number().int().min(1).max(60).default(AA_DEFAULTS.windowDays),
  salt: z.string().trim().min(1).max(60).default(AA_DEFAULTS.salt),
});
export type AaRequest = z.infer<typeof AaRequestSchema>;

export type Arm = "A" | "B";

/** Stable hash assignment. Exported so tests and reviewers can recompute any unit's arm. */
export function assignArm(salt: string, unitKey: string, expectedShareA = AA_DEFAULTS.expectedShareA): Arm {
  const h = createHash("sha256").update(`${salt}:${unitKey}`).digest();
  return h.readUInt32BE(0) / 2 ** 32 < expectedShareA ? "A" : "B";
}

export interface AssignedUnit {
  arm: Arm;
  converted: boolean;
  refunded: boolean;
}

export interface ArmSummary {
  units: number;
  converted: number;
  conversionRate: number | null;
  refunded: number;
  /** Among converted units. */
  refundRate: number | null;
}

export type AaConclusionStatus = "no_difference" | "difference_detected" | "invalid_srm" | "insufficient_data";

export interface AaAnalysis {
  arms: Record<Arm, ArmSummary>;
  srm: SampleRatioTest & { alpha: number; flagged: boolean };
  /** B − A in conversion rate. */
  conversion: ProportionDiff;
  /** B − A in refund rate among converted units. */
  guardrail: ProportionDiff & { metric: string; flagged: boolean };
  conclusion: { status: AaConclusionStatus; text: string };
}

/** Percentage points with a typographic sign, as the UI shows them. */
const pp = (v: number) => `${v < 0 ? "−" : v > 0 ? "+" : "±"}${Math.abs(v * 100).toFixed(1)} pp`;
const fmtP = (p: number) => (p < 0.0001 ? p.toExponential(1) : p.toFixed(4));

/** Pure analysis over assigned units: SRM check first, then outcome and guardrail comparisons. */
export function analyzeAa(units: AssignedUnit[], expectedShareA = AA_DEFAULTS.expectedShareA): AaAnalysis {
  const summarize = (arm: Arm): ArmSummary => {
    const xs = units.filter((u) => u.arm === arm);
    const converted = xs.filter((u) => u.converted);
    const refunded = converted.filter((u) => u.refunded).length;
    return {
      units: xs.length,
      converted: converted.length,
      conversionRate: xs.length ? converted.length / xs.length : null,
      refunded,
      refundRate: converted.length ? refunded / converted.length : null,
    };
  };
  const arms = { A: summarize("A"), B: summarize("B") };
  const srmTest = sampleRatioTest(arms.A.units, arms.B.units, expectedShareA);
  const srm = { ...srmTest, alpha: SRM_ALPHA, flagged: arms.A.units + arms.B.units > 0 && srmTest.pValue < SRM_ALPHA };
  const conversion = proportionDiff(arms.A.converted, arms.A.units, arms.B.converted, arms.B.units);
  const guardrailDiff = proportionDiff(arms.A.refunded, arms.A.converted, arms.B.refunded, arms.B.converted);
  const guardrail = {
    ...guardrailDiff,
    metric: "Refund rate among converted units",
    flagged: guardrailDiff.ci95 !== null && (guardrailDiff.ci95[0] > 0 || guardrailDiff.ci95[1] < 0),
  };

  let conclusion: AaAnalysis["conclusion"];
  if (srm.flagged) {
    conclusion = {
      status: "invalid_srm",
      text:
        `Sample ratio mismatch: ${arms.A.units} vs ${arms.B.units} units (χ² = ${srm.chiSquare.toFixed(2)}, p = ${fmtP(srm.pValue)} < ${SRM_ALPHA}). ` +
        `The split is not the designed ${Math.round(expectedShareA * 100)}/${Math.round((1 - expectedShareA) * 100)}: the hash split or the unit definition is broken, so no outcome comparison is valid.`,
    };
  } else if (arms.A.units < MIN_UNITS_PER_ARM || arms.B.units < MIN_UNITS_PER_ARM || conversion.ci95 === null) {
    conclusion = {
      status: "insufficient_data",
      text: `Too few mature units to compare (${arms.A.units} vs ${arms.B.units}; at least ${MIN_UNITS_PER_ARM} per arm). No conclusion.`,
    };
  } else {
    const [lo, hi] = conversion.ci95;
    const includesZero = lo <= 0 && hi >= 0;
    const guard = guardrail.flagged ? ` The guardrail (${guardrail.metric.toLowerCase()}) also differs; investigate it.` : " The guardrail shows no detectable difference either.";
    conclusion = includesZero
      ? {
          status: "no_difference",
          text:
            `No detectable difference — expected for an A/A test. Conversion B − A = ${pp(conversion.difference!)} (95% CI ${pp(lo)} to ${pp(hi)}) includes 0; ` +
            `the smallest difference this sample could reliably detect is about ${pp(conversion.minimumDetectableEffect!)}.${guard}`,
        }
      : {
          status: "difference_detected",
          text:
            `A difference was detected in an A/A test: B − A = ${pp(conversion.difference!)} (95% CI ${pp(lo)} to ${pp(hi)}) excludes 0. ` +
            `With no true effect this happens about 1 time in 20 by chance; if it repeats with a new salt, the outcome join or the statistics are biased. Do not trust experiment analyses until it is explained.${guard}`,
        };
  }
  return { arms, srm, conversion, guardrail, conclusion };
}

export interface AaExperimentResult {
  kind: "aa";
  /** Always shown with the result: a check of the analysis code, not of assignment or logging. */
  label: typeof AA_LABEL;
  /** Always shown with the result: what this self-check cannot detect. */
  limitation: typeof AA_LIMITATION;
  period: { key: PeriodKey; label: string; from: string; to: string };
  /** null = every branch. */
  branchIds: string[] | null;
  asOf: string;
  config: { windowDays: number; salt: string; expectedShareA: number; unit: string; assignment: string; outcome: string; guardrail: string };
  /** Units dropped because lead + N days is after the business clock. */
  excludedImmature: number;
  assignmentFingerprint: string;
  analysis: AaAnalysis;
}

interface UnitRow {
  source_lead_id: string;
  converted: boolean;
  refunded: boolean;
}

/** Mature units with outcomes, plus how many were too recent to observe. */
async function aaUnits(db: Queryable, args: { period: Period; branchIds: string[] | null; windowDays: number; now: Date }) {
  const params = [args.period.from, args.period.to, args.branchIds, args.windowDays, args.now];
  const { rows } = await db.query<UnitRow & { mature: boolean }>(
    `with units as (
       select distinct on (l.prospect_key) l.id, l.source_lead_id, l.phone_hash, l.email_hash, l.occurred_at,
              l.occurred_at + make_interval(days => $4) as window_end
       from v_leads l
       where l.source = 'web' and l.occurred_at >= $1 and l.occurred_at < $2
         and ($3::text[] is null or l.effective_branch_id = any($3::text[]))
       order by l.prospect_key, l.occurred_at, l.id)
     select u.source_lead_id, u.window_end <= $5 as mature,
            o.crm_customer_id is not null as converted,
            coalesce(o.refunded, false) as refunded
     from units u
     left join lateral (
       select a.crm_customer_id,
              exists (select 1 from crm_payments p where p.crm_customer_id = a.crm_customer_id and p.status = 'successful'
                        and p.amount_cents < 0 and p.paid_at <= $5) as refunded
       from crm_customers c
       join v_acquisitions a on a.crm_customer_id = c.crm_customer_id
       where (c.phone_hash = u.phone_hash or c.email_hash = u.email_hash)
         and a.sold_at >= u.occurred_at - interval '2 hours' and a.sold_at <= u.window_end
         and a.initial_status = 'completed' and a.initial_completed_at <= u.window_end
       order by a.sold_at, a.crm_customer_id
       limit 1) o on u.window_end <= $5
     order by u.source_lead_id`,
    params,
  );
  return { mature: rows.filter((r) => r.mature), excludedImmature: rows.filter((r) => !r.mature).length };
}

/**
 * Runs the A/A analysis for the viewer's branch scope (or one branch) without storing anything.
 * Read-only, so any viewer may see it for the branches they can see.
 */
export async function runAaExperiment(db: Queryable, viewer: Viewer, request: AaRequest & { branchId?: string | null }): Promise<AaExperimentResult> {
  const branchIds = resolveScope(viewer, request.branchId ?? null);
  const period = PERIODS[request.period];
  const now = await getNow(db);
  const { mature, excludedImmature } = await aaUnits(db, { period, branchIds, windowDays: request.windowDays, now });
  const assigned = mature.map((u) => ({ key: `web:${u.source_lead_id}`, converted: u.converted, refunded: u.refunded }));
  const units = assigned.map((u) => ({ arm: assignArm(request.salt, u.key), converted: u.converted, refunded: u.refunded }));
  const fingerprint = createHash("sha256")
    .update(assigned.map((u, i) => `${u.key}:${units[i].arm}`).join("\n"))
    .digest("hex")
    .slice(0, 16);

  return {
    kind: "aa",
    label: AA_LABEL,
    limitation: AA_LIMITATION,
    period: { key: period.key, label: period.label, from: period.from.toISOString(), to: period.to.toISOString() },
    branchIds,
    asOf: now.toISOString(),
    config: {
      windowDays: request.windowDays,
      salt: request.salt,
      expectedShareA: AA_DEFAULTS.expectedShareA,
      unit: "A prospect's first web lead in the period (one unit per person)",
      assignment: `Arm A if sha256("${request.salt}:web:<source lead id>") as uint32 / 2³² < ${AA_DEFAULTS.expectedShareA}, else B; computed at analysis time over the analysed leads (never logged at lead time)`,
      outcome: OUTCOME_DEFINITION.replace(/N days/g, `${request.windowDays} days`),
      guardrail: "Refund rate among converted units (successful refund recorded by the as-of date)",
    },
    excludedImmature,
    assignmentFingerprint: fingerprint,
    analysis: analyzeAa(units),
  };
}

export interface StoredExperiment {
  id: number;
  kind: "aa" | "holdout";
  name: string;
  status: "completed" | "invalid";
  conclusion: string;
  branchIds: string[] | null;
  channelCode: string | null;
  periodFrom: string;
  periodTo: string;
  actor: string;
  createdAt: string;
  result: unknown;
}

/** Runs and stores an A/A analysis (config + result + actor) with an audit row. */
export async function recordAaExperiment(pool: Pool, viewer: Viewer, request: AaRequest & { branchId?: string | null }): Promise<StoredExperiment> {
  requirePermission(viewer, "investigate", "record experiment analyses");
  return withTransaction(pool, async (tx) => {
    const result = await runAaExperiment(tx, viewer, request);
    const status = result.analysis.conclusion.status === "invalid_srm" ? "invalid" : "completed";
    const now = await getNow(tx);
    const name = `A/A self-check · web leads · ${result.period.label} · ${request.windowDays}-day outcome`;
    const { rows } = await tx.query<{ id: string }>(
      `insert into experiments (kind, name, branch_ids, channel_code, period_from, period_to, config, result, status, conclusion, actor, created_at)
       values ('aa', $1, $2, null, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [name, result.branchIds, result.period.from, result.period.to, result.config, result, status, result.analysis.conclusion.text, viewer.role, now],
    );
    const id = Number(rows[0].id);
    await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'record_experiment', $3, $4)", [
      now,
      viewer.role,
      `experiment:${id}`,
      {
        kind: "aa",
        period: request.period,
        branchIds: result.branchIds,
        assignmentFingerprint: result.assignmentFingerprint,
        conclusion: result.analysis.conclusion.status,
      },
    ]);
    return toStored({ id, kind: "aa", name, status, conclusion: result.analysis.conclusion.text, branch_ids: result.branchIds, channel_code: null, period_from: result.period.from, period_to: result.period.to, actor: viewer.role, created_at: now, result });
  });
}

/**
 * Stored experiments the viewer may see: an experiment over every branch is visible only to a
 * viewer who sees every branch; a scoped one only if all its branches are in the viewer's scope.
 */
export async function listExperiments(db: Queryable, viewer: Viewer, limit = 20): Promise<StoredExperiment[]> {
  const { rows } = await db.query(
    `select * from experiments
     where $1::text[] is null or (branch_ids is not null and branch_ids <@ $1::text[])
     order by created_at desc, id desc limit $2`,
    [viewer.branchIds, limit],
  );
  return rows.map(toStored);
}

function toStored(r: Record<string, unknown>): StoredExperiment {
  const iso = (v: unknown) => (v instanceof Date ? v.toISOString() : String(v));
  return {
    id: Number(r.id),
    kind: r.kind as StoredExperiment["kind"],
    name: String(r.name),
    status: r.status as StoredExperiment["status"],
    conclusion: String(r.conclusion),
    branchIds: (r.branch_ids as string[] | null) ?? null,
    channelCode: (r.channel_code as string | null) ?? null,
    periodFrom: iso(r.period_from),
    periodTo: iso(r.period_to),
    actor: String(r.actor),
    createdAt: iso(r.created_at),
    result: r.result,
  };
}
