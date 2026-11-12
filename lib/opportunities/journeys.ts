import type { Queryable } from "@/lib/db";
import { getNow } from "@/lib/db";
import { proportionDiff, type ProportionDiff } from "@/lib/decision/stats";
import { DECISION_BLOCKING_KINDS } from "@/lib/metrics/decision";
import type { Period } from "@/lib/period";
import { assessReadiness, type ReadinessAssessment, type ReadinessInput } from "./readiness";

/**
 * Two revenue-opportunity journeys: missed follow-up (Scenario B) and retention before the
 * first service (Scenario C). Each answers one question from stored data and says, for every
 * sentence, what kind of statement it is:
 *
 *   observed_fact     counted from stored records, with its definition
 *   inference         arithmetic on facts under a stated assumption (e.g. value at stake)
 *   hypothesis        a possible cause; NOT shown by the data
 *   recommendation    what to do next, usually a validation step
 *   measured_outcome  the result of an intervention against a control. There is none yet,
 *                     and the brief says so instead of leaving the slot empty
 *
 * Observational comparisons here never establish cause. Readiness (./readiness.ts) caps them
 * at "validate" until an outcome is measured.
 */
export type ClaimKind = "observed_fact" | "inference" | "hypothesis" | "recommendation" | "measured_outcome";

export interface Claim {
  kind: ClaimKind;
  statement: string;
  /** The definition or formula behind the statement. */
  basis: string;
}

export interface JourneyComparison extends ProportionDiff {
  question: string;
  labelA: string;
  labelB: string;
  xA: number;
  nA: number;
  xB: number;
  nB: number;
  /** "lower" = the hypothesis predicts rate B below rate A; "higher" = above. */
  hypothesised: "lower" | "higher";
}

export interface JourneyBranchRow {
  branchId: string;
  units: number;
  flagged: number;
  valueAtRiskCents: number;
}

export type JourneyId = "missed_follow_up" | "retention";

export interface JourneyBrief {
  journey: JourneyId;
  title: string;
  question: string;
  periodLabel: string;
  asOf: string;
  scope: string[] | null;
  claims: Claim[];
  comparison: JourneyComparison;
  branches: JourneyBranchRow[];
  readinessInput: ReadinessInput;
  readiness: ReadinessAssessment;
  /** Data this journey would need to move past a hypothesis. */
  dataNeeded: string[];
}

export const JOURNEY_DEFAULTS = { matureDays: 14, repeatWindowDays: 7, waitSplitDays: 3 };

const pct = (x: number | null) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const pp = (x: number | null) => (x === null ? "n/a" : `${x >= 0 ? "+" : "−"}${Math.abs(x * 100).toFixed(1)} pts`);
const dollars = (cents: number) => `$${Math.round(cents / 100).toLocaleString("en-US")}`;
const n = (x: number) => x.toLocaleString("en-US");

function supported(c: ProportionDiff, direction: "lower" | "higher"): boolean | null {
  if (!c.ci95) return null;
  return direction === "lower" ? c.ci95[1] < 0 : c.ci95[0] > 0;
}

/**
 * Age of the stalest source the journey reads, by the business clock; null if a source has
 * never succeeded. The platform's own rule (lib/health/feeds.ts): a source is as fresh as its
 * last SUCCESSFUL ingestion run, so a healthy feed with no changed records is not stale. A
 * push-only source with no runs at all falls back to its last delivery.
 */
async function dataAge(db: Queryable, sources: string[], now: Date): Promise<number | null> {
  const { rows } = await db.query<{ source: string; last: Date | null }>(
    `select s.source,
       coalesce(
         (select max(r.finished_at) from ingestion_runs r where r.source = s.source and r.status = 'succeeded'),
         case when not exists (select 1 from ingestion_runs r where r.source = s.source)
              then (select max(e.last_delivered_at) from raw_events e where e.source = s.source) end
       ) as last
     from unnest($1::text[]) as s(source)`,
    [sources],
  );
  if (rows.some((r) => r.last === null)) return null;
  return Math.max(0, ...rows.map((r) => now.getTime() - new Date(r.last!).getTime()));
}

/**
 * Open exceptions that make THESE journeys' inputs incomplete: missing or quarantined lead and
 * CRM records. Unmapped spend blocks budget decisions, not these journeys, which read no spend.
 */
export const JOURNEY_BLOCKING_KINDS = DECISION_BLOCKING_KINDS.filter((k) => k !== "unmapped_spend");

async function openBlockers(db: Queryable, branchIds: string[] | null): Promise<number> {
  const { rows } = await db.query<{ n: string }>(
    `select count(*) as n from exceptions
     where status = 'open' and kind = any($1::text[]) and ($2::text[] is null or branch_id = any($2) or branch_id is null)`,
    [JOURNEY_BLOCKING_KINDS, branchIds],
  );
  return Number(rows[0].n);
}

/** What the interval says about the hypothesised direction, in words. */
function readPattern(c: ProportionDiff, direction: "lower" | "higher", supportedText: string, subject: string): string {
  if (!c.ci95 || c.difference === null) return "The comparison could not be computed.";
  const inDirection = direction === "lower" ? c.difference < 0 : c.difference > 0;
  if (supported(c, direction)) return supportedText;
  if (inDirection) return `${subject} points the hypothesised way (${pp(c.difference)}), but the 95% interval includes zero: this sample cannot tell it from chance.`;
  return `${subject} points the other way (${pp(c.difference)}), so the data does not support the hypothesis.`;
}

// ── Scenario B: missed follow-up ─────────────────────────────────────────────

/**
 * Unit: a prospect's FIRST call or web lead ever (one unit per phone hash, across all time and
 * all branches), counted in the period and branch where that first contact happened, once its
 * outcome window (matureDays) has closed by the business clock. A phone that was already a
 * customer (first subscription sold before the contact − 2 h) is not a prospect.
 * Repeat contact: the same phone reached us again by call or form within repeatWindowDays.
 * Converted: a first subscription sold to that phone within [lead − 2 h, lead + matureDays].
 */
export async function missedFollowUp(db: Queryable, args: { period: Period; branchIds: string[] | null; now?: Date }): Promise<JourneyBrief> {
  const now = args.now ?? (await getNow(db));
  const { matureDays, repeatWindowDays } = JOURNEY_DEFAULTS;
  const { rows } = await db.query<{ branch_id: string; units: string; repeated: string; repeat_converted: string; repeat_unconverted: string; single: string; single_converted: string }>(
    `with first_contact as (
       select distinct on (phone_hash) id, branch_id, phone_hash, occurred_at from leads
       where source in ('calls', 'web') and phone_hash is not null and excluded_code is null
       order by phone_hash, occurred_at, id
     ),
     unit as (
       select f.* from first_contact f
       where f.occurred_at >= $1 and f.occurred_at < $2 and f.occurred_at <= $3::timestamptz - make_interval(days => $4)
         and ($5::text[] is null or f.branch_id = any($5))
         and not exists (select 1 from v_acquisitions a join crm_customers c using (crm_customer_id)
                         where c.phone_hash = f.phone_hash and a.sold_at < f.occurred_at - interval '2 hours')
     ),
     u as (
       select unit.branch_id,
         exists (select 1 from leads r where r.phone_hash = unit.phone_hash and r.source in ('calls', 'web') and r.excluded_code is null
                   and r.occurred_at > unit.occurred_at and r.occurred_at <= unit.occurred_at + make_interval(days => $6)) as repeated,
         exists (select 1 from v_acquisitions a join crm_customers c using (crm_customer_id)
                   where c.phone_hash = unit.phone_hash and a.sold_at between unit.occurred_at - interval '2 hours' and unit.occurred_at + make_interval(days => $4)) as converted
       from unit
     )
     select branch_id, count(*) as units,
       count(*) filter (where repeated) as repeated,
       count(*) filter (where repeated and converted) as repeat_converted,
       count(*) filter (where repeated and not converted) as repeat_unconverted,
       count(*) filter (where not repeated) as single,
       count(*) filter (where not repeated and converted) as single_converted
     from u group by branch_id order by branch_id`,
    [args.period.from, args.period.to, now, matureDays, args.branchIds, repeatWindowDays],
  );
  const sum = (k: keyof (typeof rows)[number]) => rows.reduce((t, r) => t + Number(r[k]), 0);
  const units = sum("units");
  const repeated = sum("repeated");
  const repeatConverted = sum("repeat_converted");
  const repeatUnconverted = sum("repeat_unconverted");
  const single = sum("single");
  const singleConverted = sum("single_converted");

  const value = await db.query<{ median: string | null }>(
    `select percentile_cont(0.5) within group (order by annual_value_cents) as median from v_acquisitions
     where sold_at >= $1 and sold_at < $2 and ($3::text[] is null or branch_id = any($3))`,
    [args.period.from, args.period.to, args.branchIds],
  );
  const medianValueCents = Math.round(Number(value.rows[0].median ?? 0));
  const singleRate = single > 0 ? singleConverted / single : 0;
  /** The pool at risk for one branch: its unconverted repeat prospects at the single-contact rate. */
  const valueAt = (flagged: number) => Math.round(flagged * singleRate * medianValueCents);

  const cmp = proportionDiff(singleConverted, single, repeatConverted, repeated);
  const comparison: JourneyComparison = {
    ...cmp,
    question: "Do prospects who had to contact us twice convert less often than those who contacted us once?",
    labelA: "Contacted once",
    labelB: `Contacted again within ${repeatWindowDays} days`,
    xA: singleConverted,
    nA: single,
    xB: repeatConverted,
    nB: repeated,
    hypothesised: "lower",
  };
  const patternSupported = supported(cmp, "lower");
  // Value at stake counts only the supported gap: the customers repeat prospects would add if
  // they converted at the single-contact rate. An unsupported or reversed gap is worth nothing,
  // so an override past "pattern" cannot also inherit an unearned materiality pass.
  const excessCustomers = patternSupported && cmp.rateA !== null && cmp.rateB !== null ? Math.max(0, (cmp.rateA - cmp.rateB) * repeated) : 0;
  const valueAtStakeCents = Math.round(excessCustomers * medianValueCents);

  const claims: Claim[] = [
    {
      kind: "observed_fact",
      statement: `${n(units)} prospects first called or sent a form in ${args.period.label} with a closed ${matureDays}-day outcome window. ${n(repeated)} of them contacted us again within ${repeatWindowDays} days; ${n(repeatUnconverted)} of those did not become customers.`,
      basis: `One unit per phone hash: its first call or web lead ever, counted where and when it happened; phones that were already customers are excluded. Repeat = another call or form from the same phone within ${repeatWindowDays} days. Converted = first subscription sold to that phone within [lead − 2 h, lead + ${matureDays} days].`,
    },
    {
      kind: "observed_fact",
      statement: `Conversion: ${pct(cmp.rateA)} after one contact (${n(singleConverted)}/${n(single)}), ${pct(cmp.rateB)} after a repeat contact (${n(repeatConverted)}/${n(repeated)}); difference ${pp(cmp.difference)}, 95% interval ${cmp.ci95 ? `${pp(cmp.ci95[0])} to ${pp(cmp.ci95[1])}` : "n/a"}.`,
      basis: "Two-proportion comparison with a normal-approximation 95% interval. Observational: the groups differ in more than follow-up.",
    },
    {
      kind: "inference",
      statement: readPattern(
        cmp,
        "lower",
        "Repeat contacts convert less often than single contacts. That fits under-served prospects, among other explanations.",
        "The conversion gap between repeat and single contacts",
      ),
      basis: "Reads the interval above in the direction the hypothesis predicts (B below A).",
    },
    {
      kind: "inference",
      statement:
        patternSupported === true
          ? `If repeat-contact prospects converted at the single-contact rate (${pct(singleRate)}), about ${n(Math.round(excessCustomers))} more of them would have become customers: ${dollars(valueAtStakeCents)} of annual contract value at the period's median (${dollars(medianValueCents)}).`
          : `No value is counted at stake: the gap is not supported. For scale only, ${n(repeatUnconverted)} repeat-contact prospects did not convert.`,
      basis: "Value at stake = (single-contact rate − repeat-contact rate) × repeat-contact prospects × median first-subscription value in scope, and zero unless the interval supports the gap. Not a forecast.",
    },
    {
      kind: "hypothesis",
      statement: "Some repeat contacts are prospects nobody called back after the first contact.",
      basis: "Not observable in this data: there is no outbound call or CRM task log. Outbound calls exist in CallRail (direction = outbound) but are not ingested (VENDOR-CONTRACTS.md C-3a).",
    },
    {
      kind: "recommendation",
      statement:
        "Validate before acting: pull the outbound call log and CRM notes for a random sample of 25 unconverted repeat-contact prospects in the branch with the most of them, and count how many had no callback within one business day.",
      basis: "A sample check is cheap and tests the hypothesis directly. If it holds, run a callback-SLA pilot with a randomised holdout.",
    },
    {
      kind: "measured_outcome",
      statement: "None. No follow-up intervention has been run or measured.",
      basis: "Only an intervention against a control produces a measured outcome. The A/A self-check in Decision Lab tests the statistics, not follow-up.",
    },
  ];

  const readinessInput: ReadinessInput = {
    valueAtStakeCents,
    smallestArm: Math.min(single, repeated),
    dataAgeMs: await dataAge(db, ["calls", "web", "crm"], now),
    openDataBlockers: await openBlockers(db, args.branchIds),
    patternSupported,
    measuredOutcome: false,
  };
  return {
    journey: "missed_follow_up",
    title: "Missed follow-up",
    question: "Are inbound prospects being lost because nobody followed up?",
    periodLabel: args.period.label,
    asOf: now.toISOString(),
    scope: args.branchIds,
    claims,
    comparison,
    branches: rows
      .map((r) => ({ branchId: r.branch_id, units: Number(r.units), flagged: Number(r.repeat_unconverted), valueAtRiskCents: valueAt(Number(r.repeat_unconverted)) }))
      .sort((a, b) => b.flagged - a.flagged || a.branchId.localeCompare(b.branchId)),
    readinessInput,
    readiness: assessReadiness(readinessInput),
    dataNeeded: ["Outbound call log (CallRail direction = outbound) or CRM follow-up tasks, joined by phone hash", "Lead qualification (CallRail lead_status, spam) so unqualified calls leave the denominator"],
  };
}

// ── Scenario C: retention before the first service ───────────────────────────

/**
 * Unit: a subscription sold in the period whose first scheduled initial visit is due by the
 * business clock. Lost before service: the subscription is cancelled and no initial visit was
 * completed. Wait: days from sale to the FIRST scheduled initial visit.
 */
export async function retentionBeforeService(db: Queryable, args: { period: Period; branchIds: string[] | null; now?: Date }): Promise<JourneyBrief> {
  const now = args.now ?? (await getNow(db));
  const { waitSplitDays } = JOURNEY_DEFAULTS;
  const { rows } = await db.query<{ branch_id: string; units: string; lost: string; lost_value: string; short_n: string; short_lost: string; long_n: string; long_lost: string }>(
    `with s as (
       select b.id as branch_id, sub.annual_value_cents,
         extract(epoch from first_visit.scheduled_for - sub.sold_at) / 86400.0 as wait_days,
         (sub.status = 'cancelled' and not exists (
            select 1 from crm_appointments done where done.crm_subscription_id = sub.crm_subscription_id and done.kind = 'initial' and done.completed_at is not null)) as lost
       from crm_subscriptions sub
       join branches b on b.crm_office_id = sub.office_id
       join lateral (
         select a.scheduled_for from crm_appointments a
         where a.crm_subscription_id = sub.crm_subscription_id and a.kind = 'initial'
         order by a.scheduled_for, a.crm_appointment_id limit 1
       ) first_visit on true
       where sub.sold_at >= $1 and sub.sold_at < $2 and first_visit.scheduled_for <= $3
         and ($4::text[] is null or b.id = any($4))
     )
     select branch_id, count(*) as units, count(*) filter (where lost) as lost,
       coalesce(sum(annual_value_cents) filter (where lost), 0) as lost_value,
       count(*) filter (where wait_days <= $5) as short_n, count(*) filter (where wait_days <= $5 and lost) as short_lost,
       count(*) filter (where wait_days > $5) as long_n, count(*) filter (where wait_days > $5 and lost) as long_lost
     from s group by branch_id order by branch_id`,
    [args.period.from, args.period.to, now, args.branchIds, waitSplitDays],
  );
  const sum = (k: keyof (typeof rows)[number]) => rows.reduce((t, r) => t + Number(r[k]), 0);
  const units = sum("units");
  const lost = sum("lost");
  const lostValue = sum("lost_value");
  const shortN = sum("short_n");
  const shortLost = sum("short_lost");
  const longN = sum("long_n");
  const longLost = sum("long_lost");

  const cmp = proportionDiff(shortLost, shortN, longLost, longN);
  const comparison: JourneyComparison = {
    ...cmp,
    question: `Are subscriptions whose first visit is more than ${waitSplitDays} days after the sale cancelled before service more often?`,
    labelA: `First visit within ${waitSplitDays} days`,
    labelB: `First visit after more than ${waitSplitDays} days`,
    xA: shortLost,
    nA: shortN,
    xB: longLost,
    nB: longN,
    hypothesised: "higher",
  };
  const patternSupported = supported(cmp, "higher");
  // Value at stake: the cancellations above the short-wait rate among long-wait sales, counted
  // only when the interval supports the pattern (a point estimate inside the noise is not value).
  const excess = patternSupported && cmp.rateA !== null && cmp.rateB !== null ? Math.max(0, (cmp.rateB - cmp.rateA) * longN) : 0;
  const meanLostValue = lost > 0 ? lostValue / lost : 0;
  const valueAtStakeCents = Math.round(excess * meanLostValue);

  const claims: Claim[] = [
    {
      kind: "observed_fact",
      statement: `${n(units)} subscriptions were sold in ${args.period.label} with their first visit due by now. ${n(lost)} were cancelled before any initial service was completed: ${dollars(lostValue)} of annual contract value.`,
      basis: "Lost before service = subscription cancelled and no initial visit completed. Value = the cancelled subscriptions' annual contract value.",
    },
    {
      kind: "observed_fact",
      statement: `Lost before service: ${pct(cmp.rateA)} when the first visit was within ${waitSplitDays} days (${n(shortLost)}/${n(shortN)}), ${pct(cmp.rateB)} when it was later (${n(longLost)}/${n(longN)}); difference ${pp(cmp.difference)}, 95% interval ${cmp.ci95 ? `${pp(cmp.ci95[0])} to ${pp(cmp.ci95[1])}` : "n/a"}.`,
      basis: "Wait = first scheduled initial visit − sale time. Two-proportion comparison with a normal-approximation 95% interval. Observational.",
    },
    {
      kind: "inference",
      statement: readPattern(
        cmp,
        "higher",
        `Longer waits go with more pre-service cancellations: about ${n(Math.round(excess))} more than the short-wait rate would give, ${dollars(valueAtStakeCents)} a year.`,
        "The cancellation gap between long and short waits",
      ),
      basis: "Excess = (rate B − rate A) × long-wait sales, valued at the mean annual value of a lost subscription. Zero when the pattern is not there.",
    },
    {
      kind: "hypothesis",
      statement: "Customers who wait longer for their first visit change their minds before it happens.",
      basis: "Not tested here. Waits are not assigned at random: busy seasons, branches and service types differ, so a pattern would still not be a cause.",
    },
    {
      kind: "recommendation",
      statement:
        patternSupported === true
          ? "Validate: in one branch, offer the next available slot within 72 hours for a random half of new sales for four weeks, and compare pre-service cancellation with the other half."
          : "Do not act on scheduling speed. If pre-service cancellations matter, look at the cancellation reasons in the CRM first: this data has none.",
      basis: "A randomised slot offer is the smallest test that measures the effect of waiting.",
    },
    {
      kind: "measured_outcome",
      statement: "None. No scheduling change has been run or measured.",
      basis: "Only an intervention against a control produces a measured outcome.",
    },
  ];

  const readinessInput: ReadinessInput = {
    valueAtStakeCents,
    smallestArm: Math.min(shortN, longN),
    dataAgeMs: await dataAge(db, ["crm"], now),
    openDataBlockers: await openBlockers(db, args.branchIds),
    patternSupported,
    measuredOutcome: false,
  };
  return {
    journey: "retention",
    title: "Lost before the first service",
    question: "Are customers cancelling before their first visit because they wait too long?",
    periodLabel: args.period.label,
    asOf: now.toISOString(),
    scope: args.branchIds,
    claims,
    comparison,
    branches: rows
      .map((r) => ({ branchId: r.branch_id, units: Number(r.units), flagged: Number(r.lost), valueAtRiskCents: Number(r.lost_value) }))
      .sort((a, b) => b.flagged - a.flagged || a.branchId.localeCompare(b.branchId)),
    readinessInput,
    readiness: assessReadiness(readinessInput),
    dataNeeded: ["Cancellation reason codes from the CRM", "Service-quality signals after the first visit (re-service requests, complaints) for retention beyond the first service"],
  };
}
