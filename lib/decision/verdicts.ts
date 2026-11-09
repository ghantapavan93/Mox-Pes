import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { getNow, type Queryable } from "@/lib/db";
import { budgetSignal, SIGNAL_MIN_CUSTOMERS, type BudgetSignal } from "@/lib/metrics/decision";
import type { ChannelRow } from "@/lib/metrics/scorecard";
import type { Period } from "@/lib/period";
import { BRANCH_BY_ID, SCENARIO } from "@/lib/reference";
import { resolveScope, type Viewer } from "@/lib/viewer";

/**
 * Three verdicts per branch × paid channel × period, deliberately never merged into one score:
 *
 *   1. DATA INTEGRITY — are this channel's records classified and reconciled? (open exceptions
 *      that touch the branch/channel, lead-record reconciliation, spend coverage, unmapped spend)
 *   2. DECISION READINESS — is there enough reliable evidence to move budget? Composes the
 *      existing budget-signal gate (`budgetSignal`, unchanged) with integrity, a minimum number of
 *      serviced customers and feed freshness.
 *   3. BUSINESS EFFECTIVENESS — did the spend cause customers? Only a randomized experiment can
 *      answer that. Attribution (first evidenced touch) never counts, however clean the data.
 *
 * The separation is the point: fixing a mapping can turn integrity and readiness green, and the
 * honest answer to "does Local Services work?" is still "unknown".
 */

export type ReasonStatus = "pass" | "warn" | "fail" | "info";

export interface Reason {
  /** Stable identifier of the check, e.g. "coverage_gap" or "min_customers". */
  code: string;
  status: ReasonStatus;
  text: string;
  /** Where the evidence lives: an exception, a filtered list, a definition. */
  href?: string;
}

export interface IntegrityVerdict {
  status: "pass" | "warn" | "fail";
  reasons: Reason[];
  coverage: {
    /** Lead records projected for the branch in the period. */
    leadRecords: number;
    /** Lead-source records held in quarantine that name this branch, in the period. */
    quarantinedRecords: number;
    /** projected ÷ (projected + quarantined); null when there are no records at all. */
    reconciledShare: number | null;
    /** Days in the period with a spend record for this channel at this branch. */
    spendDays: number;
    /** Days in the period up to the spend feed's latest date. */
    expectedSpendDays: number;
    /** Distinct Monday-start weeks with spend for this channel in the period. */
    weeksWithSpend: number;
  };
}

export interface ReadinessVerdict {
  status: "ready" | "not_ready";
  reasons: Reason[];
  /** The failing reasons only: what has to change before acting. */
  blockers: Reason[];
}

export interface EffectivenessVerdict {
  status: "unknown" | "measured";
  reasons: Reason[];
  /** Present only when a completed randomized holdout covers this branch × channel × period. */
  estimate: HoldoutEstimate | null;
}

export interface ChannelVerdicts {
  channelCode: string;
  label: string;
  /** Observational context from the scorecard. Attributed, never causal. */
  spendCents: number;
  acquired: number;
  cacCents: number | null;
  integrity: IntegrityVerdict;
  readiness: ReadinessVerdict;
  effectiveness: EffectivenessVerdict;
}

export interface DecisionVerdicts {
  branchId: string;
  branchName: string;
  period: { key: string; label: string; from: string; to: string };
  asOf: string;
  budgetSignal: Pick<BudgetSignal, "signal" | "ratio" | "trustworthy" | "from" | "to">;
  channels: ChannelVerdicts[];
}

/** The branch the Decision Lab opens on: the ChangeGuard scenario branch, or the viewer's own. */
export function defaultDecisionBranch(viewer: Viewer): string {
  return viewer.branchIds?.[0] ?? SCENARIO.lsaMigrationBranch;
}

/** A feed whose last delivery is older than this, relative to the business clock, is stale. */
export const FRESHNESS_MAX_AGE_HOURS = 36;

/** Feeds a paid-channel decision always depends on: spend (cost) and the CRM (customers). */
const REQUIRED_SOURCES = ["ads", "crm"] as const;
/** Lead feeds: checked when they have ever delivered, since credit flows through them. */
const LEAD_SOURCES = ["calls", "web", "d2d"] as const;

const HoldoutEstimateSchema = z.object({
  metric: z.string(),
  unit: z.string(),
  estimate: z.number(),
  ci95: z.tuple([z.number(), z.number()]),
});
export type HoldoutEstimate = z.infer<typeof HoldoutEstimateSchema> & { experimentId: number; name: string };

interface OpenException {
  id: number;
  kind: string;
  summary: string;
  evidence: Record<string, unknown>;
  amountCents: number;
  /** For unmapped spend: the channel of the unmapped campaign. */
  campaignChannel: string | null;
}

const exceptionHref = (id: number) => `/exceptions/${id}`;
const pctText = (v: number) => `${(v * 100).toFixed(1)}%`;
const DAY_MS = 86_400_000;

/** Does a coverage-gap exception change what this channel cost or produced? */
function gapTouches(e: OpenException, channel: string): boolean {
  if (e.evidence.channel === channel) return true;
  const successors = (e.evidence.successors as Array<{ classifiedAs?: string[] | null }> | null) ?? [];
  return successors.some((s) => (s.classifiedAs ?? []).includes(channel));
}

/**
 * Verdicts for every paid-media channel at one branch. The viewer's branch scope is enforced
 * here as well as at the API boundary: asking for another branch throws ForbiddenError.
 */
export async function decisionVerdicts(db: Queryable, viewer: Viewer, args: { branchId: string; period: Period }): Promise<DecisionVerdicts> {
  resolveScope(viewer, args.branchId);
  const branch = BRANCH_BY_ID.get(args.branchId);
  if (!branch) throw new ActionError(`Unknown branch ${args.branchId}`, 404);
  const { period, branchId } = args;

  const [now, signal, exceptions, records, spendCoverage, feeds, holdouts, latestAa] = await Promise.all([
    getNow(db),
    budgetSignal(db, branchId, { from: period.from, to: period.to }),
    openExceptions(db, branchId),
    recordReconciliation(db, branchId, period),
    spendDaysByChannel(db, branchId, period),
    feedFreshness(db),
    holdoutExperiments(db, branchId, period),
    latestAaExperiment(db, branchId, viewer.branchIds),
  ]);

  const channels = signal.channels.map((c) => {
    const integrity = integrityVerdict(c, exceptions, records, spendCoverage, branchId, period);
    const readiness = readinessVerdict(c, integrity, signal, feeds, now);
    const effectiveness = effectivenessVerdict(c, branchId, period, holdouts, latestAa);
    return {
      channelCode: c.channelCode,
      label: c.label,
      spendCents: c.spendCents,
      acquired: c.acquired,
      cacCents: c.cacCents,
      integrity,
      readiness,
      effectiveness,
    };
  });

  return {
    branchId,
    branchName: branch.name,
    period: { key: period.key, label: period.label, from: period.from.toISOString(), to: period.to.toISOString() },
    asOf: now.toISOString(),
    budgetSignal: { signal: signal.signal, ratio: signal.ratio, trustworthy: signal.trustworthy, from: signal.from, to: signal.to },
    channels,
  };
}

// ── integrity ────────────────────────────────────────────────────────────────

interface RecordCounts {
  leadRecords: number;
  quarantinedRecords: number;
  quarantineExceptionIds: number[];
}

interface SpendCoverage {
  byChannel: Map<string, { days: number; weeks: number }>;
  /** Days of the period up to (and including) the spend feed's latest date. */
  expectedDays: number;
}

function integrityVerdict(
  c: ChannelRow,
  exceptions: OpenException[],
  records: RecordCounts,
  spend: SpendCoverage,
  branchId: string,
  period: Period,
): IntegrityVerdict {
  const reasons: Reason[] = [];
  const label = c.label;

  const gaps = exceptions.filter((e) => e.kind === "channel_coverage_gap" && gapTouches(e, c.channelCode));
  if (gaps.length === 0) {
    reasons.push({ code: "coverage_gap", status: "pass", text: `No open coverage gap moves spend into or out of ${label} at ${branchId}.` });
  }
  for (const g of gaps) {
    reasons.push({
      code: "coverage_gap",
      status: "fail",
      text: `#${g.id}: ${g.summary}. Spend is filed under the wrong channel, so the cost per customer of ${label} is wrong until the records are re-mapped.`,
      href: exceptionHref(g.id),
    });
  }

  const held = exceptions.filter((e) => e.kind === "quarantined_source_records");
  for (const q of held) {
    reasons.push({
      code: "quarantine",
      status: "fail",
      text: `#${q.id}: ${q.summary}. Customers whose lead record is held show as Unknown, so any channel here may be under-credited.`,
      href: exceptionHref(q.id),
    });
  }

  const reconciledShare =
    records.leadRecords + records.quarantinedRecords > 0 ? records.leadRecords / (records.leadRecords + records.quarantinedRecords) : null;
  reasons.push({
    code: "reconciled_records",
    status: records.quarantinedRecords > 0 && held.length === 0 ? "warn" : "info",
    text:
      reconciledShare === null
        ? `No lead records for ${branchId} in ${period.label}.`
        : `${pctText(reconciledShare)} of lead records for ${branchId} in the period are projected (${records.leadRecords.toLocaleString("en-US")} projected, ${records.quarantinedRecords.toLocaleString("en-US")} held).`,
    href: records.quarantineExceptionIds[0] ? exceptionHref(records.quarantineExceptionIds[0]) : undefined,
  });

  const unmapped = exceptions.filter((e) => e.kind === "unmapped_spend" && e.campaignChannel === c.channelCode);
  for (const u of unmapped) {
    reasons.push({
      code: "unmapped_spend",
      status: "warn",
      text: `#${u.id}: ${u.summary}. ${label} spend not mapped to any branch is excluded from every branch's numbers until someone maps it.`,
      href: exceptionHref(u.id),
    });
  }

  const mismatches = exceptions.filter((e) => e.kind === "branch_mismatch" && e.evidence.channel === c.channelCode);
  if (mismatches.length > 0) {
    reasons.push({
      code: "branch_mismatch",
      status: "warn",
      text: `${mismatches.length} ${label} customer${mismatches.length === 1 ? " was" : "s were"} captured for one branch and serviced by another.`,
      href: `/exceptions?branch=${branchId}&kind=branch_mismatch&status=open`,
    });
  }

  const conflicts = exceptions.filter((e) => e.kind === "channel_conflict" && e.evidence.creditedChannel === c.channelCode);
  if (conflicts.length > 0) {
    reasons.push({
      code: "channel_conflict",
      status: "warn",
      text: `${conflicts.length} customer${conflicts.length === 1 ? "" : "s"} credited to ${label} (first touch) ${conflicts.length === 1 ? "was" : "were"} signed by a door-to-door rep: commission and media both claim ${conflicts.length === 1 ? "it" : "them"}.`,
      href: `/exceptions?branch=${branchId}&kind=channel_conflict&status=open`,
    });
  }

  const cov = spend.byChannel.get(c.channelCode) ?? { days: 0, weeks: 0 };
  reasons.push({
    code: "spend_coverage",
    status: "info",
    text:
      c.spendCents > 0 || cov.days > 0
        ? `${label} has spend records on ${cov.days} of ${spend.expectedDays} days in the period (to the spend feed's latest date), across ${cov.weeks} week${cov.weeks === 1 ? "" : "s"}.`
        : `No ${label} spend at ${branchId} in the period.`,
  });

  const status = reasons.some((r) => r.status === "fail") ? "fail" : reasons.some((r) => r.status === "warn") ? "warn" : "pass";
  return {
    status,
    reasons,
    coverage: {
      leadRecords: records.leadRecords,
      quarantinedRecords: records.quarantinedRecords,
      reconciledShare,
      spendDays: cov.days,
      expectedSpendDays: spend.expectedDays,
      weeksWithSpend: cov.weeks,
    },
  };
}

// ── readiness ────────────────────────────────────────────────────────────────

interface FeedState {
  source: string;
  lastReceivedAt: Date | null;
}

function readinessVerdict(c: ChannelRow, integrity: IntegrityVerdict, signal: BudgetSignal, feeds: FeedState[], now: Date): ReadinessVerdict {
  const reasons: Reason[] = [];

  // Linked to the first failing integrity check's evidence, so "not ready" always leads somewhere.
  const firstFailure = integrity.reasons.find((r) => r.status === "fail");
  reasons.push(
    firstFailure
      ? {
          code: "integrity",
          status: "fail",
          text: `Data integrity fails for ${c.label}: the records this decision would rest on are known to be wrong.`,
          href: firstFailure.href,
        }
      : { code: "integrity", status: "pass", text: `Data integrity ${integrity.status === "warn" ? "passes with caveats" : "passes"} for ${c.label}.` },
  );

  // The existing gate, composed and not re-implemented: its blockers are the branch's open
  // exceptions that change what ANY paid channel here cost or produced, so a budget comparison
  // between this channel and any other is unsafe while one is open.
  if (signal.blockers.length === 0) {
    reasons.push({ code: "budget_gate", status: "pass", text: `No open incident gates the budget signal at ${signal.branchId}.` });
  }
  for (const b of signal.blockers) {
    reasons.push({
      code: "budget_gate",
      status: "fail",
      text: `Blocking incident #${b.exceptionId}: ${b.summary}.`,
      href: exceptionHref(b.exceptionId),
    });
  }

  reasons.push(
    c.acquired >= SIGNAL_MIN_CUSTOMERS
      ? { code: "min_customers", status: "pass", text: `${c.acquired} serviced new customers credited to ${c.label} (minimum ${SIGNAL_MIN_CUSTOMERS}).` }
      : {
          code: "min_customers",
          status: "fail",
          text: `Only ${c.acquired} serviced new customer${c.acquired === 1 ? "" : "s"} credited to ${c.label}; at least ${SIGNAL_MIN_CUSTOMERS} are needed before its cost per customer means anything.`,
        },
  );

  const stale = feeds.filter((f) => {
    if (!f.lastReceivedAt) return (REQUIRED_SOURCES as readonly string[]).includes(f.source);
    return now.getTime() - f.lastReceivedAt.getTime() > FRESHNESS_MAX_AGE_HOURS * 3_600_000;
  });
  if (stale.length === 0) {
    reasons.push({ code: "freshness", status: "pass", text: `Every feed delivered within ${FRESHNESS_MAX_AGE_HOURS} h of the business clock.` });
  }
  for (const f of stale) {
    reasons.push({
      code: "freshness",
      status: "fail",
      text: f.lastReceivedAt
        ? `The ${f.source} feed last delivered ${Math.round((now.getTime() - f.lastReceivedAt.getTime()) / 3_600_000)} h ago (limit ${FRESHNESS_MAX_AGE_HOURS} h).`
        : `The ${f.source} feed has never delivered a record.`,
      href: "/audit",
    });
  }

  const blockers = reasons.filter((r) => r.status === "fail");
  return { status: blockers.length === 0 ? "ready" : "not_ready", reasons, blockers };
}

// ── effectiveness ────────────────────────────────────────────────────────────

interface HoldoutRow {
  id: number;
  name: string;
  channelCode: string;
  result: unknown;
  from: Date;
  to: Date;
}

interface AaRow {
  id: number;
  status: string;
  conclusion: string;
  createdAt: Date;
}

function effectivenessVerdict(c: ChannelRow, branchId: string, period: Period, holdouts: HoldoutRow[], latestAa: AaRow | null): EffectivenessVerdict {
  const reasons: Reason[] = [];
  let estimate: HoldoutEstimate | null = null;

  for (const h of holdouts.filter((x) => x.channelCode === c.channelCode)) {
    const parsed = HoldoutEstimateSchema.safeParse(h.result);
    if (!parsed.success) {
      reasons.push({ code: "holdout_unreadable", status: "warn", text: `Experiment #${h.id} covers ${c.label} but its stored result is not in the expected shape; it is ignored.`, href: "/decisions#experiments" });
      continue;
    }
    estimate ??= { ...parsed.data, experimentId: h.id, name: h.name };
    const [lo, hi] = parsed.data.ci95;
    reasons.push({
      code: "holdout",
      status: "pass",
      text: `Randomized holdout #${h.id} (${h.name}): ${parsed.data.metric} ${parsed.data.estimate.toFixed(2)} ${parsed.data.unit}, 95% CI ${lo.toFixed(2)} to ${hi.toFixed(2)}.`,
      href: "/decisions#experiments",
    });
  }

  if (!estimate) {
    reasons.push({
      code: "no_experiment",
      status: "info",
      text: `Unknown — no randomized experiment covers ${c.label} at ${branchId} in ${period.label}.`,
    });
  }
  reasons.push({
    code: "attribution_not_causal",
    status: "info",
    text: `The ${c.cacCents === null ? "" : "attributed "}cost per customer is observational: first evidenced touch says which recorded touch preceded a sale, not whether the sale needed the ad. It never counts as evidence of effect.`,
    href: "/definitions",
  });
  // The A/A run hashes arms at analysis time, so it checks the analysis code only; it is never
  // presented as validating assignment, exposure logging or an experimentation pipeline.
  reasons.push(
    latestAa
      ? {
          code: "aa_self_check",
          status: latestAa.status === "completed" ? "info" : "warn",
          text: `A/A statistics self-check (analysis code only; assignment is not logged): latest run #${latestAa.id} — ${latestAa.conclusion}`,
          href: "/decisions#experiments",
        }
      : {
          code: "aa_self_check",
          status: "info",
          text: "A/A statistics self-check: no run has been recorded for this branch yet.",
          href: "/decisions#experiments",
        },
  );

  return { status: estimate ? "measured" : "unknown", reasons, estimate };
}

// ── queries ──────────────────────────────────────────────────────────────────

async function openExceptions(db: Queryable, branchId: string): Promise<OpenException[]> {
  const { rows } = await db.query(
    `select e.id, e.kind, e.summary, e.evidence, e.amount_cents, c.channel_code as campaign_channel
     from exceptions e
     left join ad_campaigns c on e.kind = 'unmapped_spend' and c.id::text = e.evidence ->> 'campaignId'
     where e.status = 'open'
       and ((e.branch_id = $1 and e.kind in ('channel_coverage_gap', 'quarantined_source_records', 'branch_mismatch', 'channel_conflict', 'unmapped_spend'))
            -- unmapped spend has no branch by definition: it could belong to any branch
            or (e.branch_id is null and e.kind = 'unmapped_spend'))
     order by case e.severity when 'high' then 0 when 'medium' then 1 else 2 end, e.id`,
    [branchId],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    summary: r.summary,
    evidence: r.evidence ?? {},
    amountCents: Number(r.amount_cents),
    campaignChannel: r.campaign_channel ?? null,
  }));
}

async function recordReconciliation(db: Queryable, branchId: string, period: Period): Promise<RecordCounts> {
  const { rows } = await db.query(
    `select
       (select count(*) from v_leads l where l.effective_branch_id = $1 and l.occurred_at >= $2 and l.occurred_at < $3) as leads,
       (select count(*) from raw_events re
         where re.status = 'quarantined' and re.source in ('calls', 'web', 'd2d')
           and re.occurred_at >= $2 and re.occurred_at < $3 and payload_branch(re.payload) = $1) as held,
       (select coalesce(array_agg(id order by id), '{}') from exceptions
         where status = 'open' and kind = 'quarantined_source_records' and branch_id = $1) as exception_ids`,
    [branchId, period.from, period.to],
  );
  return {
    leadRecords: Number(rows[0].leads),
    quarantinedRecords: Number(rows[0].held),
    quarantineExceptionIds: (rows[0].exception_ids as Array<string | number>).map(Number),
  };
}

async function spendDaysByChannel(db: Queryable, branchId: string, period: Period): Promise<SpendCoverage> {
  const { rows } = await db.query(
    `select s.channel_code, count(distinct s.spend_date) as days, count(distinct date_trunc('week', s.spend_date)) as weeks
     from ad_spend_daily s join campaign_branch_map m on m.campaign_id = s.campaign_id
     where m.branch_id = $1
       and s.spend_date >= ($2::timestamptz at time zone 'UTC')::date and s.spend_date < ($3::timestamptz at time zone 'UTC')::date
     group by 1`,
    [branchId, period.from, period.to],
  );
  // The spend feed's own latest date bounds what can be expected, so a period that is still
  // being delivered is not reported as missing days (the coverage-gap rule does the same).
  const latest = await db.query<{ d: string | null }>("select max(spend_date)::text as d from ad_spend_daily");
  const periodDays = Math.round((period.to.getTime() - period.from.getTime()) / DAY_MS);
  const latestDate = latest.rows[0]?.d ? new Date(`${latest.rows[0].d}T00:00:00Z`) : null;
  const expectedDays = latestDate
    ? Math.max(0, Math.min(periodDays, Math.floor((latestDate.getTime() - period.from.getTime()) / DAY_MS) + 1))
    : 0;
  return {
    byChannel: new Map(rows.map((r) => [r.channel_code as string, { days: Number(r.days), weeks: Number(r.weeks) }])),
    expectedDays,
  };
}

async function feedFreshness(db: Queryable): Promise<FeedState[]> {
  // One indexed max() per source (raw_events_received_idx), not a scan of the event log.
  const { rows } = await db.query<{ source: string; last: Date | null }>(
    `select s as source, (select max(received_at) from raw_events where source = s) as last
     from unnest($1::text[]) as s`,
    [[...REQUIRED_SOURCES, ...LEAD_SOURCES]],
  );
  return rows
    .filter((r) => r.last !== null || (REQUIRED_SOURCES as readonly string[]).includes(r.source))
    .map((r) => ({ source: r.source, lastReceivedAt: r.last }));
}

async function holdoutExperiments(db: Queryable, branchId: string, period: Period): Promise<HoldoutRow[]> {
  const { rows } = await db.query(
    `select id, name, channel_code, result, period_from, period_to from experiments
     where kind = 'holdout' and status = 'completed'
       and (branch_ids is null or $1 = any(branch_ids))
       and period_from < $3 and period_to > $2
     order by created_at desc, id desc`,
    [branchId, period.from, period.to],
  );
  return rows.map((r) => ({ id: Number(r.id), name: r.name, channelCode: r.channel_code, result: r.result, from: r.period_from, to: r.period_to }));
}

/**
 * The latest A/A run that covers this branch AND that the viewer may see: a company-wide run's
 * conclusion describes other branches' leads, so a branch-scoped viewer only sees scoped runs.
 */
async function latestAaExperiment(db: Queryable, branchId: string, viewerBranchIds: string[] | null): Promise<AaRow | null> {
  const { rows } = await db.query(
    `select id, status, conclusion, created_at from experiments
     where kind = 'aa' and (branch_ids is null or $1 = any(branch_ids))
       and ($2::text[] is null or (branch_ids is not null and branch_ids <@ $2::text[]))
     order by created_at desc, id desc limit 1`,
    [branchId, viewerBranchIds],
  );
  const r = rows[0];
  return r ? { id: Number(r.id), status: r.status, conclusion: r.conclusion, createdAt: r.created_at } : null;
}
