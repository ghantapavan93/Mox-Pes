import { readAll, type Queryable } from "@/lib/db";
import { channelEligibility, type ChannelEligibility, type EligibilityReason } from "@/lib/metrics/eligibility";
import { channelRows, type ChannelRow, type Scope } from "@/lib/metrics/scorecard";
import { holdSentence, refusedDatesInPeriod, refusedRevisionsInPeriod, revisionsOf, type RefusedRevision } from "@/lib/reconcile/refused-revisions";

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
  with unmapped as materialized (
    select e.id, e.kind, e.summary, e.severity, e.amount_cents, lc.lead_id
    from exceptions e
    join v_lead_campaigns lc on lc.campaign_id = (e.evidence ->> 'campaignId')::bigint
    where e.status = 'open' and e.kind = 'unmapped_spend' and e.branch_id is null),
  -- Only a customer that shares a lead's phone or email can be credited with it (v_acquisitions'
  -- first touch). Naming those customers first, as an array the planner applies before it credits
  -- anyone, spares crediting every other customer (190 ms on the demo world).
  candidates as materialized (
    select cu.crm_customer_id from unmapped u join leads l on l.id = u.lead_id join crm_customers cu on cu.phone_hash = l.phone_hash
    union
    select cu.crm_customer_id from unmapped u join leads l on l.id = u.lead_id join crm_customers cu on cu.email_hash = l.email_hash)
  select distinct u.id, a.branch_id, a.channel_code, a.initial_completed_at, u.kind, u.summary, u.severity, u.amount_cents
  from unmapped u
  join v_acquisitions a on a.lead_id = u.lead_id and a.initial_status = 'completed'
    and a.crm_customer_id = any(array(select crm_customer_id from candidates))`;

export const SIGNAL_RATIO = 1.5;
export const SIGNAL_MIN_CUSTOMERS = 5;

export interface Blocker {
  exceptionId: number;
  kind: string;
  summary: string;
  /**
   * An incident with no branch of its own (unmapped spend, counted where its customers are). Only
   * company-wide roles may open it, so a branch- or brand-scoped view names it without a link.
   */
  companyLevel: boolean;
  /**
   * For a hold on refused spend revisions: the refused revisions dated inside the period, each
   * beside the amount that still counts (lib/reconcile/refused-revisions.ts). Empty otherwise.
   */
  revisions: RefusedRevision[];
  /**
   * The paid channels the incident changes, read from its own evidence: a refused revision's
   * channel, a coverage gap's channel and the channels its successor records were filed under, an
   * unmapped campaign's channel. Null when the evidence cannot narrow it: held lead records may move
   * customers between any channels, so no comparison at the branch is independent of them.
   */
  touches: string[] | null;
}

type Pair = Pick<ChannelRow, "channelCode" | "label" | "spendCents" | "acquired" | "cacCents">;

/** A channel the rule covers (≥ SIGNAL_MIN_CUSTOMERS customers) that the comparison leaves out, and why. */
export interface ExcludedChannel {
  channelCode: string;
  label: string;
  acquired: number;
  cacCents: number | null;
  reasons: EligibilityReason[];
}

/** What a branch-wide recommendation waits for: an open incident, or a left-out channel's missing evidence. */
export interface HeldBy {
  exceptionId: number | null;
  channelCode: string | null;
  text: string;
}

/**
 * The decision boundary: three separate outcomes, decided here once for every surface (the branch
 * card, the Decision Lab, the Overview, the fix receipt, the investigator):
 *
 *   1. FACTS, always displayable: each channel's spend, customers and CAC, or why it has none
 *      (`eligibility`, lib/metrics/eligibility.ts).
 *   2. A COMPARISON (`comparison`) between the channels the rule covers, over those whose cost is
 *      defensible and that no open incident touches. basis "branch": every covered channel is in it;
 *      "verified": some are left out (`excluded`, each with its reason) and the rest are independent of
 *      what left them out; "unverified": an open incident's reach cannot be narrowed to channels, so
 *      nothing here is verified and the comparison is shown only behind the gate.
 *   3. A RECOMMENDATION (`recommendation`): "shift" only when nothing holds it. Any open incident
 *      holds it (`trustworthy`), and so does a left-out channel whose missing evidence could change
 *      which channel is cheapest or most expensive. A source-recorded $0.00 leaves its channel out
 *      without holding anything.
 *
 * A move between two channels is held by any reason that holds either side (verdicts.ts readiness);
 * an incident at the branch still holds every move there, as before. Nothing here moves spend or
 * customers between branches, and no channel's cost is estimated.
 */
export interface BudgetSignal {
  branchId: string;
  /**
   * The raw observation, unchanged since definition v4 of paid CAC: among every channel with a CAC and
   * ≥ 5 customers, whether the most expensive costs ≥ 1.5× the cheapest, whatever holds them. It is
   * never shown as a comparison or acted on: `comparison` and `recommendation` are.
   */
  signal: "shift" | "none";
  from: Pair | null;
  to: Pair | null;
  ratio: number | null;
  /** No open decision-blocking incident at the branch (the incident gate). */
  trustworthy: boolean;
  blockers: Blocker[];
  channels: ChannelRow[];
  /** Outcome 1, per paid-media channel (in `channels` order). */
  eligibility: ChannelEligibility[];
  /** Outcome 2. */
  comparison: { basis: "branch" | "verified" | "unverified"; signal: "shift" | "none"; from: Pair | null; to: Pair | null; ratio: number | null; compared: string[] };
  excluded: ExcludedChannel[];
  /** Outcome 3. */
  recommendation: { status: "shift" | "none" | "held"; heldBy: HeldBy[] };
}

/** The paid channels a decision-blocking incident changes, from its evidence (see Blocker.touches). */
function touchesOf(kind: string, evidence: Record<string, unknown> | null, revisions: RefusedRevision[], unmappedChannels: string[] | null): string[] | null {
  if (revisions.length > 0) return [...new Set(revisions.map((r) => r.channel))];
  if (kind === "unmapped_spend") return unmappedChannels;
  if (kind === "channel_coverage_gap" && evidence && typeof evidence.channel === "string") {
    const successors = (evidence.successors as Array<{ classifiedAs?: string[] | null }> | null) ?? [];
    return [...new Set([evidence.channel, ...successors.flatMap((s) => s.classifiedAs ?? [])])];
  }
  return null;
}

/**
 * Most and least expensive among channels with a CAC; "shift" when the first costs ≥ 1.5× the second.
 * Exactly the gate's rule before the boundary (ties keep the channel rows' order; one channel compares
 * with itself at 1.0), so the raw observation is unchanged.
 */
function compare(channels: Pair[]): { signal: "shift" | "none"; from: Pair | null; to: Pair | null; ratio: number | null } {
  const sorted = channels.filter((c) => c.cacCents !== null).sort((a, b) => (b.cacCents ?? 0) - (a.cacCents ?? 0));
  const from = sorted[0] ?? null;
  const to = sorted[sorted.length - 1] ?? null;
  const ratio = from && to && to.cacCents ? from.cacCents! / to.cacCents : null;
  const signal = ratio !== null && ratio >= SIGNAL_RATIO && from !== to ? "shift" : "none";
  const pick = (c: Pair | null): Pair | null => c && { channelCode: c.channelCode, label: c.label, spendCents: c.spendCents, acquired: c.acquired, cacCents: c.cacCents };
  return { signal, from: signal === "shift" ? pick(from) : null, to: signal === "shift" ? pick(to) : null, ratio };
}

export async function budgetSignal(db: Queryable, branchId: string, scope: Omit<Scope, "branchIds">): Promise<BudgetSignal> {
  // At once on the pool; one at a time when the caller holds a single transaction client.
  const [allChannels, evidence] = await readAll(db, [
    () => channelRows(db, { ...scope, branchIds: [branchId] }),
    () => channelEligibility(db, { ...scope, branchIds: [branchId] }),
  ]);
  const channels = allChannels.filter((c) => c.costBasis === "media");
  // The raw observation (definition v4): every channel with a CAC and the minimum, whatever holds it.
  const raw = compare(channels.filter((c) => c.acquired >= SIGNAL_MIN_CUSTOMERS));

  // A hold on refused spend revisions names its campaign-days' dates: it holds the decision for a
  // period containing one of them, never another period's (HOLD-TO-DECISION.md §1.4, scenario 2b).
  // Unmapped spend is counted where its customers are, in its campaign's channels (D-1).
  const { rows } = await db.query<{ id: string; kind: string; summary: string; revisions: unknown; company_level: boolean; evidence: Record<string, unknown> | null; unmapped_channels: string[] | null }>(
    `select id, kind, summary, revisions, company_level, evidence, unmapped_channels from (
       select e.id, e.kind, e.summary, e.severity, ${refusedRevisionsInPeriod("$4", "$5")} as revisions, false as company_level,
              e.evidence, null::text[] as unmapped_channels from exceptions e
       where e.status = 'open' and e.branch_id = $1 and e.kind = any($2::text[]) and ${refusedDatesInPeriod("$4", "$5")}
       union all
       select u.id, u.kind, u.summary, u.severity, null::jsonb, true, null::jsonb, array_agg(distinct u.channel_code) from (${UNMAPPED_AT_BRANCH}) u
       where u.branch_id = $1 and u.channel_code = any($3::text[]) and u.initial_completed_at >= $4 and u.initial_completed_at < $5
       group by u.id, u.kind, u.summary, u.severity
     ) b
     order by case severity when 'high' then 0 when 'medium' then 1 else 2 end, id`,
    [branchId, DECISION_BLOCKING_KINDS, channels.map((c) => c.channelCode), scope.from, scope.to],
  );
  const blockers: Blocker[] = rows.map((r) => {
    const revisions = revisionsOf({ revisions: r.revisions });
    return { exceptionId: Number(r.id), kind: r.kind, summary: r.summary, companyLevel: r.company_level, revisions, touches: touchesOf(r.kind, r.evidence, revisions, r.unmapped_channels) };
  });

  // Outcome 1: each channel's own evidence, then what an open incident adds to it.
  const own = new Map(evidence.map((e) => [e.channelCode, e]));
  const eligibility: ChannelEligibility[] = channels.map((c) => {
    const base = own.get(c.channelCode);
    const reasons: EligibilityReason[] = [...(base?.reasons ?? [])];
    for (const b of blockers) {
      const mine = b.revisions.filter((r) => r.channel === c.channelCode);
      if (mine.length > 0) {
        reasons.push({ code: "refused", short: "revision refused", holds: true, couldChange: true, href: `/exceptions/${b.exceptionId}`, text: `#${b.exceptionId}: ${holdSentence(mine)} It holds until a newer revision is accepted.` });
      } else if (b.revisions.length === 0 && b.touches?.includes(c.channelCode)) {
        // An unmapped campaign's own reason already says whose cost is missing: the incident is its link.
        const unmapped = b.kind === "unmapped_spend" ? reasons.find((x) => x.code === "unmapped") : undefined;
        if (unmapped) unmapped.href ??= `/exceptions/${b.exceptionId}`;
        else reasons.push({ code: "incident", short: `incident #${b.exceptionId}`, holds: true, couldChange: true, href: `/exceptions/${b.exceptionId}`, text: `#${b.exceptionId}: ${b.summary.replace(/\.$/, "")}.` });
      }
    }
    return { branchId, channelCode: c.channelCode, label: c.label, spendCents: c.spendCents, acquired: c.acquired, cacCents: c.cacCents, reasons, limitations: base?.limitations ?? [] };
  });

  // Outcome 2: the channels the rule covers, less those left out.
  const covered = eligibility.filter((e) => e.acquired >= SIGNAL_MIN_CUSTOMERS);
  const excluded: ExcludedChannel[] = covered
    .filter((e) => e.reasons.length > 0 || e.cacCents === null)
    .map((e) => ({ channelCode: e.channelCode, label: e.label, acquired: e.acquired, cacCents: e.cacCents, reasons: e.reasons }));
  const unnarrowed = blockers.filter((b) => b.touches === null);
  const basis: BudgetSignal["comparison"]["basis"] = unnarrowed.length > 0 ? "unverified" : excluded.length > 0 ? "verified" : "branch";
  // Behind the gate ("unverified") the incidents are not narrowed, so only the channels' own records
  // leave one out; otherwise every reason does. Either way no channel compares on a cost it cannot carry.
  const compared =
    basis === "unverified"
      ? covered.filter((e) => e.cacCents !== null && e.reasons.every((r) => r.code === "incident" || r.code === "refused"))
      : covered.filter((e) => !excluded.some((x) => x.channelCode === e.channelCode));
  const comparison = { basis, ...compare(compared), compared: compared.map((e) => e.channelCode) };

  // Outcome 3: held by every open incident, and by every left-out channel whose evidence is missing.
  const heldBy: HeldBy[] = [
    ...blockers.map((b) => ({ exceptionId: b.exceptionId, channelCode: null, text: `#${b.exceptionId}: ${b.summary.replace(/\.$/, "")}.` })),
    // A reason linked to an incident is that incident's facet: the incident is already listed.
    ...excluded.flatMap((x) =>
      x.reasons.filter((r) => r.couldChange && !r.href?.startsWith("/exceptions/")).map((r) => ({ exceptionId: null, channelCode: x.channelCode, text: `${x.label}: ${r.text}` })),
    ),
  ];
  const recommendation = { status: heldBy.length > 0 ? ("held" as const) : comparison.signal, heldBy };

  return {
    branchId,
    signal: raw.signal,
    from: raw.from,
    to: raw.to,
    ratio: raw.ratio,
    trustworthy: blockers.length === 0,
    blockers,
    channels,
    eligibility,
    comparison,
    excluded,
    recommendation,
  };
}

/**
 * A branch's recommendation held by its own records, with no incident to say so: a channel the rule
 * covers whose spend is held at intake, has none recorded, or is counted at another branch. The
 * Overview lists these beside the incident holds (`decisionHolds`); a refused revision and an
 * unmapped campaign are incidents already, and a recorded $0.00 holds nothing.
 */
export interface EvidenceHold {
  branchId: string;
  channelCode: string;
  label: string;
  code: EligibilityReason["code"];
  short: string;
  summary: string;
  href: string | null;
}

export async function evidenceHolds(db: Queryable, branchIds: string[] | null, period: { from: Date; to: Date }): Promise<EvidenceHold[]> {
  const all = await channelEligibility(db, { from: period.from, to: period.to, branchIds });
  return all
    .filter((e) => e.acquired >= SIGNAL_MIN_CUSTOMERS)
    .flatMap((e) =>
      e.reasons
        .filter((r) => r.couldChange && (r.code === "held" || r.code === "no_spend" || r.code === "elsewhere"))
        .map((r) => ({ branchId: e.branchId, channelCode: e.channelCode, label: e.label, code: r.code, short: r.short, summary: `${e.label}: ${r.text}`, href: r.href ?? null })),
    );
}

export interface DecisionHold {
  exceptionId: number;
  branchId: string;
  kind: string;
  summary: string;
  amountCents: number;
  /** A hold on refused spend revisions (lib/reconcile/refused-revisions.ts), not held lead records. */
  refusedRevision?: boolean;
  /** The incident has no branch of its own (see Blocker.companyLevel): only company-wide roles may open it. */
  companyLevel: boolean;
}

/**
 * Branches whose budget signal is gated right now: every open decision-blocking exception in
 * scope (null = all branches), most severe first. The same rows `budgetSignal` lists as
 * blockers, gathered across branches for the Overview. Given a period, a hold on refused spend
 * revisions counts only when one of its dates is inside it, by the gate's own rule; without one,
 * every open hold counts.
 */
export async function decisionHolds(db: Queryable, branchIds: string[] | null, limit = 8, period: { from: Date; to: Date } | null = null): Promise<DecisionHold[]> {
  const { rows } = await db.query<{ id: string; branch_id: string; kind: string; summary: string; amount_cents: string; refused_revision: boolean; company_level: boolean }>(
    `select id, branch_id, kind, summary, amount_cents, refused_revision, company_level from (
       select e.id, e.branch_id, e.kind, e.summary, e.amount_cents, e.severity, (e.evidence ? 'spendDates') as refused_revision, false as company_level from exceptions e
       where e.status = 'open' and e.branch_id is not null and e.kind = any($1::text[])
         and ($4::timestamptz is null or ${refusedDatesInPeriod("$4", "$5")})
       union
       select distinct u.id, u.branch_id, u.kind, u.summary, u.amount_cents, u.severity, false, true from (${UNMAPPED_AT_BRANCH}) u
     ) h
     where ($2::text[] is null or branch_id = any($2::text[]))
     order by case severity when 'high' then 0 when 'medium' then 1 else 2 end, amount_cents desc, id
     limit $3`,
    [DECISION_BLOCKING_KINDS, branchIds, limit, period?.from ?? null, period?.to ?? null],
  );
  return rows.map((r) => ({
    exceptionId: Number(r.id),
    branchId: r.branch_id,
    kind: r.kind,
    summary: r.summary,
    amountCents: Number(r.amount_cents),
    refusedRevision: r.refused_revision,
    companyLevel: r.company_level,
  }));
}
