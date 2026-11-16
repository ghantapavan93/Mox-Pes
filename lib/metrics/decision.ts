import type { Queryable } from "@/lib/db";
import { channelRows, type ChannelRow, type Scope } from "@/lib/metrics/scorecard";
import { refusedDatesInPeriod, refusedRevisionsInPeriod, revisionsOf, type RefusedRevision } from "@/lib/reconcile/refused-revisions";

/**
 * Decision gate. A budget signal is only as good as the measurement under it, so every
 * signal is returned together with the open exceptions that make it untrustworthy.
 *
 * The signal itself is deliberately naive and labelled so: "the most expensive paid channel at
 * this branch costs at least 1.5× the cheapest, per new customer serviced". It stands in for
 * whatever rule or person would act on channel cost per customer. The point is the gate, not
 * the rule.
 */

/** Exception kinds that change what a paid channel cost or which customers it produced. */
export const DECISION_BLOCKING_KINDS = ["channel_coverage_gap", "quarantined_source_records", "unmapped_spend"] as const;

/**
 * Unmapped spend is company-level (no branch owns the campaign), so its exception has no branch.
 * It still changes what a channel cost AT a branch when the campaign produced that branch's
 * customers: their cost is missing from the channel's spend there. So an open unmapped-spend
 * exception blocks each branch whose acquired customers are credited to its campaign, in that
 * campaign's channel (audit 2026-11-09, D-1: before this, the kind was listed as blocking but its
 * null branch meant it never matched any branch). "Credited to its campaign" means the lead's own
 * record names that campaign's platform (v_lead_campaigns, R-46): a customer of another
 * platform's campaign with the same id is not this campaign's.
 */
const UNMAPPED_AT_BRANCH = `
  select distinct e.id, a.branch_id, a.channel_code, a.initial_completed_at, e.kind, e.summary, e.severity, e.amount_cents
  from exceptions e
  join v_lead_campaigns lc on lc.campaign_id = (e.evidence ->> 'campaignId')::bigint
  join v_acquisitions a on a.lead_id = lc.lead_id and a.initial_status = 'completed'
  where e.status = 'open' and e.kind = 'unmapped_spend' and e.branch_id is null`;

export const SIGNAL_RATIO = 1.5;
export const SIGNAL_MIN_CUSTOMERS = 5;

export interface Blocker {
  exceptionId: number;
  kind: string;
  summary: string;
  /**
   * For a hold on refused spend revisions: the refused revisions dated inside the period, each
   * beside the amount that still counts (lib/reconcile/refused-revisions.ts). Empty otherwise.
   */
  revisions: RefusedRevision[];
}

export interface BudgetSignal {
  branchId: string;
  /** "shift" = a channel looks ≥ 1.5× as expensive as another; "none" = no such gap. */
  signal: "shift" | "none";
  from: Pick<ChannelRow, "channelCode" | "label" | "spendCents" | "acquired" | "cacCents"> | null;
  to: Pick<ChannelRow, "channelCode" | "label" | "spendCents" | "acquired" | "cacCents"> | null;
  ratio: number | null;
  trustworthy: boolean;
  blockers: Blocker[];
  channels: ChannelRow[];
}

export async function budgetSignal(db: Queryable, branchId: string, scope: Omit<Scope, "branchIds">): Promise<BudgetSignal> {
  const channels = (await channelRows(db, { ...scope, branchIds: [branchId] })).filter((c) => c.costBasis === "media");
  const comparable = channels.filter((c) => c.cacCents !== null && c.acquired >= SIGNAL_MIN_CUSTOMERS);
  const sorted = [...comparable].sort((a, b) => (b.cacCents ?? 0) - (a.cacCents ?? 0));
  const from = sorted[0] ?? null;
  const to = sorted[sorted.length - 1] ?? null;
  const ratio = from && to && to.cacCents ? from.cacCents! / to.cacCents : null;
  const signal = ratio !== null && ratio >= SIGNAL_RATIO && from !== to ? "shift" : "none";

  // A hold on refused spend revisions names its campaign-days' dates: it holds the decision for a
  // period containing one of them, never another period's (HOLD-TO-DECISION.md §1.4, scenario 2b).
  const { rows } = await db.query<{ id: string; kind: string; summary: string; revisions: unknown }>(
    `select id, kind, summary, revisions from (
       select e.id, e.kind, e.summary, e.severity, ${refusedRevisionsInPeriod("$4", "$5")} as revisions from exceptions e
       where e.status = 'open' and e.branch_id = $1 and e.kind = any($2::text[]) and ${refusedDatesInPeriod("$4", "$5")}
       union
       select u.id, u.kind, u.summary, u.severity, null::jsonb from (${UNMAPPED_AT_BRANCH}) u
       where u.branch_id = $1 and u.channel_code = any($3::text[]) and u.initial_completed_at >= $4 and u.initial_completed_at < $5
     ) b
     order by case severity when 'high' then 0 when 'medium' then 1 else 2 end, id`,
    [branchId, DECISION_BLOCKING_KINDS, channels.map((c) => c.channelCode), scope.from, scope.to],
  );
  const blockers = rows.map((r) => ({ exceptionId: Number(r.id), kind: r.kind, summary: r.summary, revisions: revisionsOf({ revisions: r.revisions }) }));
  const pick = (c: ChannelRow | null) =>
    c && { channelCode: c.channelCode, label: c.label, spendCents: c.spendCents, acquired: c.acquired, cacCents: c.cacCents };
  return {
    branchId,
    signal,
    from: signal === "shift" ? pick(from) : null,
    to: signal === "shift" ? pick(to) : null,
    ratio,
    trustworthy: blockers.length === 0,
    blockers,
    channels,
  };
}

export interface DecisionHold {
  exceptionId: number;
  branchId: string;
  kind: string;
  summary: string;
  amountCents: number;
  /** A hold on refused spend revisions (lib/reconcile/refused-revisions.ts), not held lead records. */
  refusedRevision?: boolean;
}

/**
 * Branches whose budget signal is gated right now: every open decision-blocking exception in
 * scope (null = all branches), most severe first. The same rows `budgetSignal` lists as
 * blockers, gathered across branches for the Overview. Given a period, a hold on refused spend
 * revisions counts only when one of its dates is inside it, by the gate's own rule; without one,
 * every open hold counts.
 */
export async function decisionHolds(db: Queryable, branchIds: string[] | null, limit = 8, period: { from: Date; to: Date } | null = null): Promise<DecisionHold[]> {
  const { rows } = await db.query<{ id: string; branch_id: string; kind: string; summary: string; amount_cents: string; refused_revision: boolean }>(
    `select id, branch_id, kind, summary, amount_cents, refused_revision from (
       select e.id, e.branch_id, e.kind, e.summary, e.amount_cents, e.severity, (e.evidence ? 'spendDates') as refused_revision from exceptions e
       where e.status = 'open' and e.branch_id is not null and e.kind = any($1::text[])
         and ($4::timestamptz is null or ${refusedDatesInPeriod("$4", "$5")})
       union
       select distinct u.id, u.branch_id, u.kind, u.summary, u.amount_cents, u.severity, false from (${UNMAPPED_AT_BRANCH}) u
     ) h
     where ($2::text[] is null or branch_id = any($2::text[]))
     order by case severity when 'high' then 0 when 'medium' then 1 else 2 end, amount_cents desc, id
     limit $3`,
    [DECISION_BLOCKING_KINDS, branchIds, limit, period?.from ?? null, period?.to ?? null],
  );
  return rows.map((r) => ({ exceptionId: Number(r.id), branchId: r.branch_id, kind: r.kind, summary: r.summary, amountCents: Number(r.amount_cents), refusedRevision: r.refused_revision }));
}
