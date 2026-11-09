import type { Queryable } from "@/lib/db";
import { channelRows, type ChannelRow, type Scope } from "@/lib/metrics/scorecard";

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

export const SIGNAL_RATIO = 1.5;
export const SIGNAL_MIN_CUSTOMERS = 5;

export interface Blocker {
  exceptionId: number;
  kind: string;
  summary: string;
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

  const { rows } = await db.query<{ id: string; kind: string; summary: string }>(
    `select id, kind, summary from exceptions
     where status = 'open' and branch_id = $1 and kind = any($2::text[])
     order by case severity when 'high' then 0 when 'medium' then 1 else 2 end, id`,
    [branchId, DECISION_BLOCKING_KINDS],
  );
  const blockers = rows.map((r) => ({ exceptionId: Number(r.id), kind: r.kind, summary: r.summary }));
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
}

/**
 * Branches whose budget signal is gated right now: every open decision-blocking exception in
 * scope (null = all branches), most severe first. The same rows `budgetSignal` lists as
 * blockers, gathered across branches for the Overview.
 */
export async function decisionHolds(db: Queryable, branchIds: string[] | null, limit = 8): Promise<DecisionHold[]> {
  const { rows } = await db.query<{ id: string; branch_id: string; kind: string; summary: string; amount_cents: string }>(
    `select id, branch_id, kind, summary, amount_cents from exceptions
     where status = 'open' and branch_id is not null and kind = any($1::text[])
       and ($2::text[] is null or branch_id = any($2::text[]))
     order by case severity when 'high' then 0 when 'medium' then 1 else 2 end, amount_cents desc, id
     limit $3`,
    [DECISION_BLOCKING_KINDS, branchIds, limit],
  );
  return rows.map((r) => ({ exceptionId: Number(r.id), branchId: r.branch_id, kind: r.kind, summary: r.summary, amountCents: Number(r.amount_cents) }));
}
