import { ACTIVE_VERSION, mapperVersions } from "@/lib/adapters/registry";
import type { SourceName } from "@/lib/adapters/contract";
import { FRESHNESS_MAX_AGE_HOURS } from "@/lib/decision/verdicts";
import type { PeriodKey } from "@/lib/period";
import { exactDollars } from "@/lib/lineage/trace";
import { formatCents } from "@/lib/primitives";
import { BRANCH_BY_ID, BRANDS, CHANNEL_BY_CODE, type BrandId, type ChannelCode } from "@/lib/reference";
import type { Viewer } from "@/lib/viewer";
import type { DraftFindings, Observation, ProposalSuggestion } from "./contract";
import { evidence, uniqueIds } from "./evidence";
import { rendered, type Render } from "./rendered";
import type { ToolData, ToolInput, ToolName } from "./tools";

/**
 * A record figure a sentence renders: the figure as written, the tool and record it comes from,
 * and the field. The analyst proves it against the recorded tool output (lib/ai/rendered.ts).
 */
const field = (figure: string | number, tool: ToolName, evidenceId: string, path: string): Render => ({ figure: String(figure), tool, evidenceId, path });

/**
 * The deterministic investigator: what runs when no model is configured, and the baseline the
 * model path is evaluated against.
 *
 *   question + scope → intent (keyword rules) → a FIXED tool plan for that intent → a rule-based
 *   analyst that turns the tool outputs into the same draft contract the model would submit.
 *
 * It calls the same registry tools through the same executor (scope checks, trace, evidence
 * ids, injection scan), and every sentence it writes is built from a tool output and cites the
 * evidence ids that output returned. It never reads free-text record fields as instructions;
 * it does not even quote them. It is labelled everywhere as deterministic, never as AI output.
 */

export type Intent =
  | "exception"
  | "customer_lookup"
  | "coverage_gap"
  | "quarantine"
  | "duplicates"
  | "branch_mismatch"
  | "channel_conflict"
  | "refunds"
  | "stale_sync"
  | "high_cac"
  /** A plain question about a branch's (or a brand's) figures: spend, customers, CAC, collected cash. */
  | "metric_lookup"
  /** A prediction or a what-if: records cannot answer it. */
  | "forecast"
  | "no_evidence";

export interface DetectedIntent {
  intent: Intent;
  branchId: string | null;
  customerId: number | null;
  exceptionId: number | null;
  period: PeriodKey;
  /** The month a change question compares with ("went up in October" → September), or null. */
  compare: PeriodKey | null;
  /** The question asks the AI path to act (approve, execute, delete…), not to investigate. */
  actionRequest: boolean;
  /** The question presumes spend stopped or dropped. */
  presumesStop: boolean;
  /** A brand the question names when it names no branch (a brand-wide question). */
  brandId: BrandId | null;
  /** The question asks whether something caused an outcome: answered with figures, never with a cause. */
  asksCause: boolean;
  /** The question is about cash: collected, revenue, payments, refunds. */
  asksCash: boolean;
  /** The question names collected cash or revenue itself (not only "paid" in "paid CAC"). */
  asksCollected: boolean;
}

const CAUSAL_QUESTION = /\b(?:cause[sd]?|because|due to|thanks to|paid for itself|pay for itself|pays for itself|worth it|roi|return on|effective|drove|bring in more)\b/i;

/** A prediction or a what-if: "what will CAC be in November", "if we double the budget". */
const FORECAST = /\b(?:will|would|going to)\b[^.?!]{0,60}\b(?:be|cost|look|become|bring|get)\b|\bnext (?:month|quarter|year)\b|\bin (?:november|december|january|2027)\b|\bforecast\w*|\bpredict\w*|\bprojections?\b|\bif we (?:double|halve|triple|increase|cut|raise|lower|move|shift|spend|add|stop)\b/i;
/** A plain figure question: spend, customers, CAC, collected cash, refunds. */
const METRIC_QUESTION = /\b(?:how much|how many|what (?:was|is|were|did)|total|spend|spent|collect\w*|revenue|cash|new customers|customers? (?:serv|credit)\w*|paid media|cost per|cac)\b/i;

const ACTION_REQUEST = [
  /^\s*(please\s+)?(approve|execute|apply|delete|drop|purge|merge|force|bypass|skip|reject|close)\b/i,
  /\b(approve|execute|apply)\b[^.?!]{0,40}\b(proposals?|fix|re-?map|replay|it|them|now|change)\b/i,
  /\b(without|skip|bypass|no)\b[^.?!]{0,20}\b(approval|dry[- ]run|review)\b/i,
  /\b(delete|drop|purge|truncate)\b[^.?!]{0,30}\b(records?|events?|exceptions?|tables?|rows?|customers?)\b/i,
  // Moving money or campaigns: "Move $2,000 of B05's Meta budget to LSA starting tomorrow" (VP
  // acceptance VP-09, first contact). A question about it ("Should we move…?") is not refused.
  /(?:^|[.!?;]\s+|\b(?:please|can you|could you|would you|will you|go ahead and|and then|then|now)\s+)(?:move|shift|reallocate|transfer|increase|raise|cut|reduce|pause|stop|launch|turn (?:on|off)|re-?budget)\b[^.?!]{0,80}\b(?:budget|spend|campaigns?|bids?|\$[\d,]+)/i,
  // Following instructions stored in records: "Do what the notes on customer y2 say" (VP-12).
  /\b(?:do|carry out|act on|follow)\s+(?:what|as|whatever)\b[^.?!]{0,60}\b(?:notes?|records?|comments?|instructions?|says?|tells?)\b|\bfollow (?:the |their |its |any )?(?:instructions?|notes?|directions?)\b/i,
  // An imperative at the start of any sentence, or after "please / can you / then": "…share a
  // phone number. Merge them into one customer" (held-out IV-45, first contact).
  /(?:^|[.!?;]\s+|\b(?:please|can you|could you|would you|will you|go ahead and|and then|then|now)\s+)(?:approve|execute|apply|delete|drop|purge|merge|combine|unmerge|split|re-?assign|re-?credit|overwrite|update|edit|mark|re-?map|replay|close|reject|resolve|fix)\b(?!\s+(?:is|was|are|were|happened|history)\b)/i,
];

const TOPICS: Array<{ intent: Intent; re: RegExp }> = [
  { intent: "coverage_gap", re: /\b(local services|lsa|pmax|performance max|coverage gap|cheaper|reclassif\w*|misclassif\w*|re-?map\w*|channel imbalance|stopped spending|spend (stopped|dropped))\b/i },
  { intent: "quarantine", re: /\b(quarantin\w*|held records?|failed validation|missing field|ingestion fail\w*|lead mapping|not mapped|dropped records?)\b/i },
  { intent: "duplicates", re: /\b(duplicates?|double[- ]count\w*|counted twice|re-?deliver\w*|delivered twice)\b/i },
  { intent: "branch_mismatch", re: /\b(wrong branch|branch mismatch|other branch|territory|zip)\b/i },
  { intent: "channel_conflict", re: /\b(door[- ]to[- ]door|d2d|conflicting (channel|acquisition)|channel conflict|two channels|credited twice)\b/i },
  { intent: "refunds", re: /\b(refunds?|chargebacks?|collected revenue|payments? reconcil\w*|reconcil\w* (payments?|refunds?))\b/i },
  { intent: "stale_sync", re: /\b(stale|freshness|fresh|out of date|last sync\w*|sync\w* (lag|delay)|feed (late|delay\w*))\b/i },
  { intent: "high_cac", re: /\b(cac|cost per (customer|acquisition)|unknown share|unattributed|so expensive|too expensive)\b/i },
];

const SEP_WORD = /\bsept?(?:ember)?\b/i;
const OCT_WORD = /\boct(?:ober)?\b/i;
/** The two months as one period: "across September and October", "both months", "Sep–Oct". */
const BOTH_MONTHS = /\b(?:across|over|for|in|during|between)\s+(?:both\s+)?sept?(?:ember)?\s+and\s+oct(?:ober)?\b|\bboth months\b|\bsept?(?:ember)?\s*[–-]\s*oct(?:ober)?\b|\bover the two months\b|\bsept?(?:ember)?\s+and\s+oct(?:ober)?\s+(?:together|combined)\b/i;
/** A change between the months: "went up", "doubled", "compared with September". */
const CHANGE_QUESTION = /\b(?:go(?:ne)? up|went up|go(?:ne)? down|went down|ris(?:e|en|ing)|rose|increas\w*|decreas\w*|fell|fall(?:en|ing)?|dropp?\w*|declin\w*|chang\w*|doubl\w*|tripl\w*|halv\w*|jump\w*|spik\w*|surg\w*|compared (?:with|to)|versus|vs\.?|month[- ]over[- ]month)\b/i;
/**
 * "September's collected cash", "B38's September collected cash": the month the figure is about.
 * The main figures (cash, revenue, CAC, spend, customers) outrank refunds and payments mentioned on
 * the way: "Did the October refunds of September sales reduce B38's September collected cash?" is
 * about September.
 */
const MONTH_OF_FIGURE = /\b(sept?(?:ember)?|oct(?:ober)?)(?:['’]s)?\s+(?:[\w-]+\s+){0,2}?(?:paid[- ]media |paid )?(collect\w*|cash|revenue|cac|spend|customers|refunds?|payments?)\b/gi;
function monthOfFigure(question: string): string | null {
  const matches = [...question.matchAll(MONTH_OF_FIGURE)];
  const main = matches.find((m) => !/^(?:refunds?|payments?)$/i.test(m[2]));
  return (main ?? matches[0])?.[1] ?? null;
}

/**
 * The period a question is about, and the period it compares with. Before 2026-11-12 a question
 * naming both months was answered for the two months together: "Why did B12's CAC go up in
 * October compared with September?" got a Sep–Oct figure, and "Did October refunds reduce B38's
 * September collected cash?" got both months' cash (VP acceptance, first contact).
 */
function periodsOf(question: string): { period: PeriodKey; compare: PeriodKey | null } {
  if (BOTH_MONTHS.test(question)) return { period: "all", compare: null };
  const sep = SEP_WORD.test(question);
  const oct = OCT_WORD.test(question);
  const change = CHANGE_QUESTION.test(question);
  if (sep && oct) {
    const named = monthOfFigure(question);
    if (named && !change) return { period: /^sep/i.test(named) ? "sep" : "oct", compare: null };
    return { period: "oct", compare: "sep" };
  }
  if (sep) return { period: "sep", compare: null };
  return { period: "oct", compare: change ? "sep" : null };
}

export function detectIntent(question: string, viewer: Viewer, requestedBranch: string | null): DetectedIntent {
  const branchMatch = /\bB(\d{2})\b/.exec(question);
  const branchId = branchMatch ? `B${branchMatch[1]}` : requestedBranch ?? (viewer.branchIds?.length === 1 ? viewer.branchIds[0] : null);
  const exceptionMatch = /\b(?:exception|incident|case)\s*#?\s*(\d{1,12})\b/i.exec(question);
  const customerMatch = /\bcustomer\s*#?\s*(\d{4,12})\b/i.exec(question);
  const { period, compare } = periodsOf(question);
  const actionRequest = ACTION_REQUEST.some((re) => re.test(question));
  const presumesStop = /\b(stop(ped)?|drop(ped)?|cut|paused?|went to zero)\b/i.test(question);
  const brandId = branchMatch ? null : brandNamed(question);
  let intent: Intent = "no_evidence";
  if (exceptionMatch) intent = "exception";
  else if (customerMatch) intent = "customer_lookup";
  // A prediction is never answered from records, whatever metric it names.
  else if (FORECAST.test(question)) intent = "forecast";
  else if (UNMEASURED.test(question)) intent = "no_evidence";
  // A brand-wide figure: a rollup over every branch of the brand.
  else if (brandId && !requestedBranch && METRIC_QUESTION.test(question)) intent = "metric_lookup";
  else intent = TOPICS.find((t) => t.re.test(question))?.intent ?? (METRIC_QUESTION.test(question) ? "metric_lookup" : "no_evidence");
  return {
    intent,
    branchId: branchId && BRANCH_BY_ID.has(branchId) ? branchId : null,
    customerId: customerMatch ? Number(customerMatch[1]) : null,
    exceptionId: exceptionMatch ? Number(exceptionMatch[1]) : null,
    period,
    compare,
    actionRequest,
    presumesStop,
    brandId,
    asksCause: CAUSAL_QUESTION.test(question),
    asksCash: /\b(?:collect\w*|cash|revenue|paid|payments?|refunds?)\b/i.test(question),
    asksCollected: /\b(?:collect\w*|cash|revenue)\b/i.test(question),
  };
}

/** Measures no tool records: accounting revenue, profit, untracked sources (sponsorships, billboards). */
const UNMEASURED = /\b(?:recogni[sz]ed revenue|accounting|gaap|accrual|profit\w*|margins?|ebitda|lifetime value|ltv|sponsorships?|arena|billboards?|radio|television|tv ads?|print ads?|mailers?|flyers?|word of mouth)\b/i;

/** The brand a question names ("Joshua's", "the Mission brand"), if any. */
export function brandNamed(question: string): BrandId | null {
  for (const b of BRANDS) {
    const first = b.name.split(" ")[0].replace(/'s$/, "");
    // Case-sensitive: a brand is a proper noun ("our mission" is not the Mission brand).
    if (new RegExp(String.raw`\b${first}(?:'?s)?\b`).test(question)) return b.id;
  }
  return null;
}

/** What a plan can do: call a registry tool (through the executor) and note what it could not get. */
export interface PlanContext {
  call<N extends ToolName>(name: N, input: ToolInput<N>): Promise<ToolData<N> | null>;
  /** Tool refusals and errors so far, in order (scope refusals included). */
  readonly failures: Array<{ tool: string; status: string; message: string }>;
  /** Instruction-like strings found in tool data so far. */
  warningCount(): number;
  viewer: Viewer;
}

export interface DeterministicOutcome {
  intent: Intent;
  draft: DraftFindings;
  /** Set when the question asked the AI path to act. */
  refusal: string | null;
}

/** `+ 0` turns a negative zero (a sum of no refunds, negated) into 0, so it never prints as "-$0.00". */
const money = (cents: number | null | undefined) => (cents === null || cents === undefined ? "n/a" : formatCents(cents + 0));
const pct = (v: number | null) => (v === null ? "n/a" : `${(v * 100).toFixed(1)}%`);
const channelLabel = (code: string) => CHANNEL_BY_CODE.get(code as ChannelCode)?.label ?? code;
const day = (v: unknown) => (typeof v === "string" ? v.slice(0, 10) : "?");
/** An ISO instant as "2026-10-31 08:00 UTC" for prose. */
const when = (v: string | null) => (v ? `${v.slice(0, 10)} ${v.slice(11, 16)} UTC` : "never");
const versionOf = (adapterVersion: string) => adapterVersion.split("@")[1] ?? adapterVersion;

/** What the investigator says when a question asks it to act instead of investigate. */
export const ACTION_REFUSAL =
  "The AI investigator is read-only: it cannot approve, execute, reject, close or delete anything, and it does not act on instructions to. Fixes go through the Action Center, where a proposal is dry-run by an integration engineer and approved by a different role before the application applies it.";

export async function runDeterministic(ctx: PlanContext, question: string, requestedBranch: string | null): Promise<DeterministicOutcome> {
  const d = detectIntent(question, ctx.viewer, requestedBranch);
  let intent = d.intent;
  let draft: DraftFindings;
  if (intent === "exception") {
    const res = await ctx.call("getReconciliationExceptions", { exceptionId: d.exceptionId! });
    const e = res?.exceptions[0];
    if (!e) {
      draft = nothingReadable(ctx, `Exception ${d.exceptionId} could not be read.`);
    } else {
      const routed = routeByKind(e.kind);
      intent = routed;
      draft = await runPlan(routed, ctx, { ...d, branchId: e.branchId ?? d.branchId, exceptionId: e.id });
    }
  } else {
    draft = await runPlan(intent, ctx, d);
  }
  const warnings = ctx.warningCount();
  if (warnings > 0) {
    draft.summary = `${draft.summary} ${warnings} instruction-like text fragment(s) were found inside record data; they were treated as data and ignored.`;
  }
  return { intent, draft, refusal: d.actionRequest ? ACTION_REFUSAL : null };
}

function routeByKind(kind: string): Intent {
  switch (kind) {
    case "channel_coverage_gap":
      return "coverage_gap";
    case "quarantined_source_records":
      return "quarantine";
    case "branch_mismatch":
      return "branch_mismatch";
    case "channel_conflict":
      return "channel_conflict";
    case "payment_without_ticket":
      return "refunds";
    case "payload_conflict":
      return "duplicates";
    default:
      return "no_evidence";
  }
}

function runPlan(intent: Intent, ctx: PlanContext, d: DetectedIntent): Promise<DraftFindings> {
  switch (intent) {
    case "coverage_gap":
      return coverageGapPlan(ctx, d);
    case "high_cac":
      return highCacPlan(ctx, d);
    case "quarantine":
      return quarantinePlan(ctx, d);
    case "duplicates":
      return duplicatesPlan(ctx, d);
    case "customer_lookup":
      return customerPlan(ctx, d);
    case "branch_mismatch":
      return branchMismatchPlan(ctx, d);
    case "channel_conflict":
      return channelConflictPlan(ctx, d);
    case "refunds":
      return refundsPlan(ctx, d);
    case "stale_sync":
      return staleSyncPlan(ctx, d);
    case "metric_lookup":
      return metricLookupPlan(ctx, d);
    case "forecast":
      return Promise.resolve(forecastDraft(d));
    default:
      return noEvidencePlan(ctx, d);
  }
}

// ── shared pieces ────────────────────────────────────────────────────────────

function emptyDraft(summary: string): DraftFindings {
  return {
    summary,
    observations: [],
    suspectedCause: null,
    confidence: { level: "low", why: "No stored record answers the question." },
    recommendedNextAction: "Rephrase the question around a branch, a customer id, an exception or a metric the tools cover.",
    expectedEffect: "None: nothing is proposed.",
    risks: [],
    missingInformation: [],
    proposals: [],
  };
}

function failureNotes(ctx: PlanContext): string[] {
  return ctx.failures.map((f) => `${f.tool}: ${f.message}`).slice(0, 5);
}

/** The draft when the first, essential tool call was refused or failed. */
function nothingReadable(ctx: PlanContext, summary: string): DraftFindings {
  const refused = ctx.failures.some((f) => f.status === "forbidden");
  return {
    ...emptyDraft(`${summary}${refused ? " The records are outside your branch scope, so nothing was read." : ""}`),
    confidence: { level: "low", why: refused ? "The tools refused: the records are outside the viewer's scope." : "The essential tool call failed." },
    recommendedNextAction: refused ? "Ask someone whose scope covers that branch, or ask about a branch in your scope." : "Check the question's ids and try again.",
    missingInformation: failureNotes(ctx),
  };
}

function needBranch(ctx: PlanContext, what: string): DraftFindings {
  return {
    ...emptyDraft(`Which branch? ${what} is answered per branch: name one (for example B09) or pick it in the scope selector.`),
    missingInformation: ["The question names no branch and the viewer's scope covers several."],
    recommendedNextAction: "Ask again with a branch id.",
  };
}

// ── coverage gap / channel imbalance ─────────────────────────────────────────

async function coverageGapPlan(ctx: PlanContext, d: DetectedIntent): Promise<DraftFindings> {
  if (!d.branchId && !d.exceptionId) return needBranch(ctx, "A channel comparison");
  const list = d.exceptionId
    ? await ctx.call("getReconciliationExceptions", { exceptionId: d.exceptionId })
    : await ctx.call("getReconciliationExceptions", { branchId: d.branchId!, kind: "channel_coverage_gap", limit: 5 });
  if (!list) return nothingReadable(ctx, `No channel data for ${d.branchId ?? `exception ${d.exceptionId}`} could be read.`);
  const gap = list.exceptions.find((e) => e.kind === "channel_coverage_gap" && e.status === "open") ?? list.exceptions.find((e) => e.kind === "channel_coverage_gap");
  const b = gap?.branchId ?? d.branchId!;
  const metrics = await ctx.call("getBranchMetrics", { branchId: b, period: d.period });

  if (!gap) {
    const draft = emptyDraft(`No channel coverage gap is recorded at ${b}: no paid channel's spend stopped while its leads kept arriving.`);
    if (metrics) {
      const paid = metrics.channels.filter((c) => c.isPaid && c.cacCents !== null);
      draft.observations.push({
        text: `${b} ${metrics.period.label}: ${paid.map((c) => `${c.label} ${money(c.cacCents)} per new customer (${money(c.spendCents)} spend, ${c.acquired} customers)`).join("; ") || "no paid channel has customers"}.`,
        evidenceIds: paid.map((c) => evidence.channelMetrics(b, metrics.period.key, c.channelCode)),
        status: "verified",
      });
      draft.observations.push({
        text: "With no integrity exception behind it, a cost difference between channels may be real — but attributed cost per customer is not causal.",
        evidenceIds: [evidence.branchMetrics(b, metrics.period.key)],
        status: "hypothesis",
        strength: "weak",
      });
    }
    draft.missingInformation.push("A randomized experiment (holdout) is the only evidence that one channel causes more customers per dollar.");
    draft.recommendedNextAction = `Check decision readiness for ${b} in the Decision Lab before moving budget.`;
    return draft;
  }

  const ev = gap.evidence as Record<string, unknown>;
  const succ = ((ev.successors as Array<Record<string, unknown>> | null) ?? [])[0];
  const pred = ((ev.predecessors as Array<Record<string, unknown>> | null) ?? [])[0];
  const gapId = evidence.exception(gap.id);
  const sampleLeads = ((ev.sampleLeadIds as number[] | null) ?? []).slice(0, 3).map(evidence.lead);
  const label = String(ev.channelLabel ?? channelLabel(String(ev.channel)));
  const observations: Observation[] = [
    {
      text: `${label} spend at ${b} stopped after ${day(ev.lastSpendDate)}, but ${ev.leadsSinceGap} ${label} leads and ${ev.acquisitionsSinceGap} new customers kept arriving up to the spend feed's latest date (${day(ev.feedLatestDate)}).`,
      evidenceIds: [gapId, ...sampleLeads],
      status: "verified",
    },
  ];
  const proposals: ProposalSuggestion[] = [];
  let cause: DraftFindings["suspectedCause"] = null;
  let confidence: DraftFindings["confidence"] = { level: "medium", why: "The coverage-gap rule fired, but the re-map was not reproduced." };
  let effect = "The dry run reports the exact before/after.";

  if (!succ) {
    observations.push({
      text: `No new campaign started in the same ad account around the gap, so there is no misfiled spend to re-map.`,
      evidenceIds: [gapId],
      status: "verified",
    });
    if (metrics) addChannelCacObservation(observations, metrics, b, [String(ev.channel)]);
    return {
      summary: `${label} spend at ${b} stopped while its leads kept arriving, and no successor campaign explains it: the spend feed or the campaign itself needs checking at the source.`,
      observations,
      suspectedCause: null,
      confidence: { level: "low", why: "The gap is recorded but nothing in the stored data explains it." },
      recommendedNextAction: `Ask marketing operations whether the ${label} campaign at ${b} was paused, renamed or moved to another account.`,
      expectedEffect: "None until the source is checked: nothing is proposed.",
      risks: [],
      missingInformation: ["Whether the campaign was paused or moved outside the connected ad accounts."],
      proposals: [],
    };
  }

  const succId = Number(succ.campaignId);
  const classifiedAs = ((succ.classifiedAs as string[] | null) ?? []).map(channelLabel).join(", ") || "another channel";
  observations.push({
    text: `Campaign "${succ.name}" (campaign ${succId}) started in the same ad account${pred ? ` (${pred.adAccountId})` : ""} on ${day(succ.firstSpendDate)}; ${money(Number(succ.spendSinceGapCents))} of its spend since the gap is stored as ${classifiedAs}.`,
    evidenceIds: uniqueIds([gapId, evidence.campaign(succId), ...(pred ? [evidence.campaign(Number(pred.campaignId))] : [])]),
    status: "verified",
  });

  const cls = await ctx.call("inspectCampaignClassification", { campaignId: succId });
  const lineage = await ctx.call("getSourceLineage", { campaignId: succId });
  const c = cls?.campaigns[0];
  if (c && c.latestRawEventId) {
    observations.push({
      text: `Its latest stored raw payload (raw event ${c.latestRawEventId}, stored by ${c.latestAdapterVersion}) types it ${c.payloadCampaignType ?? "with no campaign type"} with localServicesEnabled = ${String(c.payloadLocalServicesEnabled)}; the deployed ads@${c.activeMapperVersion} classifies that payload as ${channelLabel(c.activeMapperChannel ?? "?")}, while the stored spend is filed as ${c.spendByClassification.map((s) => channelLabel(s.channelCode)).join(", ") || channelLabel(c.storedChannel)}.`,
      evidenceIds: [evidence.campaign(succId), evidence.rawEvent(c.latestRawEventId)],
      status: "verified",
    });
  }

  const storedVersions = lineage && lineage.kind === "campaign" ? [...new Set(lineage.spendByMapper.map((s) => versionOf(s.adapterVersion)))] : [];
  const older = mapperVersions("ads").filter((v) => v < ACTIVE_VERSION.ads);
  const fromVersion = storedVersions.find((v) => v !== ACTIVE_VERSION.ads) ?? older[older.length - 1];
  const cmp = fromVersion ? await ctx.call("compareMappingVersions", { source: "ads", fromVersion, toVersion: ACTIVE_VERSION.ads, exceptionId: gap.id }) : null;
  const channelChange = cmp?.fieldChanges.find((f) => f.field === "channelCode");
  const costChanged = cmp?.fieldChanges.some((f) => f.field === "costCents") ?? false;
  if (cmp && channelChange) {
    observations.push({
      text: `Re-running ads@${cmp.fromVersion} and ads@${cmp.toVersion} over the ${cmp.records} stored spend records of that campaign, read-only: ${channelChange.records} record(s) change channel from ${channelLabel(channelChange.from)} to ${channelLabel(channelChange.to)} (${money(channelChange.costCents)} across ${channelChange.entities} campaign-day(s)); ${costChanged ? "cost also changes" : "cost is not among the changed fields"}.`,
      evidenceIds: uniqueIds([gapId, evidence.campaign(succId), ...cmp.samples.changed.slice(0, 5).map(evidence.rawEvent)]),
      status: "verified",
    });
  }

  if (metrics) {
    const pair = [String(ev.channel), ...((succ.classifiedAs as string[] | null) ?? [])];
    addChannelCacObservation(observations, metrics, b, pair);
    if (channelChange) {
      observations.push({
        text: `${channelLabel(channelChange.from)} cost per customer at ${b} is overstated and ${label} understated in these figures: ${money(channelChange.costCents)} of ${label} spend is counted as ${channelLabel(channelChange.from)} while ${label} keeps its customers.`,
        evidenceIds: uniqueIds([gapId, ...pair.map((ch) => evidence.channelMetrics(b, metrics.period.key, ch)), ...cmp!.samples.changed.slice(0, 2).map(evidence.rawEvent)]),
        status: "hypothesis",
        strength: "strong",
      });
    }
  }

  const readiness = await ctx.call("getDecisionReadiness", { branchId: b, period: d.period });
  if (readiness) {
    const notReady = readiness.channels.filter((ch) => ch.readiness.status !== "ready");
    observations.push({
      text: `Decision readiness at ${b} (${d.period}): ${notReady.length ? `${notReady.map((ch) => ch.label).join(", ")} not ready to move budget` : "every paid channel ready"}; the budget signal is ${readiness.budgetSignal.trustworthy ? "trustworthy" : "not trustworthy while this exception is open"}.`,
      evidenceIds: uniqueIds([...readiness.channels.map((ch) => evidence.readiness(b, d.period, ch.channelCode)), gapId]),
      status: "verified",
    });
  }
  await ctx.call("getMetricDefinition", { key: "paidCac" });

  if (channelChange && c) {
    cause = {
      text: `The ${label} campaign was replaced by "${succ.name}", a ${c.payloadCampaignType ?? "new"} campaign with local services enabled in the same ad account — consistent with Google migrating Local Services campaigns into Performance Max. Its spend was stored by ads@${cmp!.fromVersion}, which classifies by platform only, so it was filed as ${channelLabel(channelChange.from)}. Nothing failed validation, so only the coverage-gap rule saw it.`,
      evidenceIds: uniqueIds([gapId, evidence.campaign(succId), ...(c.latestRawEventId ? [evidence.rawEvent(c.latestRawEventId)] : []), ...cmp!.samples.changed.slice(0, 3).map(evidence.rawEvent)]),
    };
    confidence = {
      level: "high",
      why: "Re-running both mapper versions over the stored records reproduces the misclassification and its correction, and the raw payload carries the campaign type and local-services flag the old mapper ignored.",
    };
    effect = `About ${money(channelChange.costCents)} of spend moves from ${channelLabel(channelChange.from)} to ${label} at ${b} for the re-mapped days; total spend is unchanged; the coverage-gap exception should resolve after reconciliation — the dry run verifies all three before anyone approves.`;
    if (gap.status === "open") {
      proposals.push({
        exceptionId: gap.id,
        kind: "remap_channel",
        params: { mapperVersion: ACTIVE_VERSION.ads },
        rationale: `Re-map the ${channelChange.records} stored spend record(s) of campaign ${succId} through ads@${ACTIVE_VERSION.ads}: they are ${label} spend filed as ${channelLabel(channelChange.from)} by ads@${cmp!.fromVersion} (compareMappingVersions, read-only).`,
      });
    }
  }

  const premise = d.presumesStop && channelChange
    ? `${label} spend at ${b} did not stop: from ${day(succ.firstSpendDate)} it arrives under a new campaign and is filed as ${channelLabel(channelChange.from)}. `
    : "";
  return {
    summary: `${premise}${label} looks cheaper than ${classifiedAs} at ${b} because ${channelChange ? `${money(channelChange.costCents)} of its spend since ${day(ev.gapStart)} is stored under ${classifiedAs}` : "its spend stopped while its leads continued"}${channelChange ? ", while its customers stay credited to it" : ""}. Both channels' cost per customer is wrong until the stored records are re-mapped.`,
    observations,
    suspectedCause: cause,
    confidence,
    recommendedNextAction: proposals.length
      ? `An integration engineer dry-runs the proposed re-map on exception ${gap.id}; a revenue-ops approver (a different role) approves it; then re-check decision readiness for ${b}.`
      : `Review exception ${gap.id} in the Action Center.`,
    expectedEffect: effect,
    risks: [
      `Channel totals for ${b} change for the re-mapped days; reports exported before the fix will disagree with reports after it.`,
      "Cost per customer by channel is attributed, not causal: a cheaper channel after the fix is not evidence it causes more customers (effectiveness stays unknown without an experiment).",
    ],
    missingInformation: storedVersions.length === 0 ? ["The campaign's spend lineage could not be read."] : [],
    proposals,
  };
}

function addChannelCacObservation(observations: Observation[], metrics: ToolData<"getBranchMetrics">, b: string, codes: string[]) {
  const rows = metrics.channels.filter((c) => codes.includes(c.channelCode));
  if (rows.length === 0) return;
  observations.push({
    text: `${b}, ${metrics.period.label}, as currently stored: ${rows.map((c) => `${c.label} ${money(c.cacCents)} per new customer (${money(c.spendCents)} spend ÷ ${c.acquired} customers)`).join("; ")}.`,
    evidenceIds: rows.map((c) => evidence.channelMetrics(b, metrics.period.key, c.channelCode)),
    status: "verified",
  });
}

// ── high paid CAC / unknown share ────────────────────────────────────────────

const MONTH_NAME: Record<string, string> = { sep: "September", oct: "October" };

/**
 * A change question states both months, each from its own figures, and the change between them.
 * First contact of the VP acceptance pack: "Why did B12's paid CAC go up in October compared with
 * September?" was answered with neither month's figure. Each sentence names both months, so its
 * proof compares October with September.
 */
async function comparisonObservations(ctx: PlanContext, d: DetectedIntent, b: string, now: ToolData<"getBranchMetrics">): Promise<Observation[]> {
  if (!d.compare || d.compare === d.period || d.period === "all") return [];
  const then = await ctx.call("getBranchMetrics", { branchId: b, period: d.compare });
  if (!then) return [];
  const nowId = evidence.branchMetrics(b, now.period.key);
  const thenId = evidence.branchMetrics(b, then.period.key);
  const [from, to] = [MONTH_NAME[then.period.key], MONTH_NAME[now.period.key]];
  const out: Observation[] = [
    {
      text: `${b}, ${then.period.label}: paid-media CAC ${money(then.paidCacCents)}${then.paidCacCents === null ? "" : ` = ${exactDollars(then.paidSpendCents)} paid spend ÷ ${then.paidAcquired} new customers whose first evidenced touch was paid`}; collected cash ${exactDollars(then.collectedCents)}.`,
      evidenceIds: [thenId],
      status: "verified",
    },
  ];
  const change = (label: string, a: number, z: number) =>
    a === z ? `From ${from} to ${to}, ${b}'s ${label} was unchanged at ${exactDollars(z)}.` : `From ${from} to ${to}, ${b}'s ${label} ${z > a ? "rose" : "fell"} by ${exactDollars(Math.abs(z - a))}, from ${exactDollars(a)} to ${exactDollars(z)}.`;
  if (now.paidCacCents !== null && then.paidCacCents !== null) out.push({ text: change("paid-media CAC", then.paidCacCents, now.paidCacCents), evidenceIds: [thenId, nowId], status: "verified" });
  out.push({ text: change("paid media spend", then.paidSpendCents, now.paidSpendCents), evidenceIds: [thenId, nowId], status: "verified" });
  if (then.paidAcquired !== now.paidAcquired) {
    out.push({ text: `From ${from} to ${to}, ${b}'s new customers whose first evidenced touch was paid ${now.paidAcquired > then.paidAcquired ? "rose" : "fell"} from ${then.paidAcquired} to ${now.paidAcquired}.`, evidenceIds: [thenId, nowId], status: "verified" });
  }
  return out;
}

async function highCacPlan(ctx: PlanContext, d: DetectedIntent): Promise<DraftFindings> {
  if (!d.branchId) return needBranch(ctx, "Paid-media CAC");
  const b = d.branchId;
  const metrics = await ctx.call("getBranchMetrics", { branchId: b, period: d.period });
  if (!metrics) return nothingReadable(ctx, `${b}'s metrics could not be read.`);
  await ctx.call("getMetricDefinition", { key: "paidCac" });
  const exc = await ctx.call("getReconciliationExceptions", { branchId: b, status: "open", limit: 25 });
  const ing = await ctx.call("getIngestionFailures", { branchId: b });
  const bm = evidence.branchMetrics(b, metrics.period.key);
  const observations: Observation[] = [
    {
      // The equation's operands to the cent, so the arithmetic reproduces exactly from the sentence.
      text: `${b}, ${metrics.period.label}: paid-media CAC ${money(metrics.paidCacCents)} = ${exactDollars(metrics.paidSpendCents)} paid spend ÷ ${metrics.paidAcquired} new customers whose first evidenced touch was paid; ${metrics.unknownAcquired} of ${metrics.acquired} new customers (${pct(metrics.unknownShare)}) have channel unknown.`,
      evidenceIds: [bm],
      status: "verified",
    },
    ...(await comparisonObservations(ctx, d, b, metrics)),
  ];
  // A question that also asks for cash gets it (VP-12: "What were B24's October paid CAC and
  // collected cash?" was answered with the CAC alone).
  if (d.asksCollected) {
    observations.push({ text: `${b}, ${metrics.period.label}: collected cash ${exactDollars(metrics.collectedCents)} (successful payments minus refunds, by payment date); refunds ${exactDollars(metrics.refundsCents)}.`, evidenceIds: [bm], status: "verified" });
  }
  // Where the number comes from, reproduced from records (lib/lineage/trace.ts).
  const trace = await ctx.call("getMetricTrace", { branchId: b, period: d.period, metric: "paid_cac" });
  if (trace) {
    const top = trace.campaigns.slice(0, 3);
    observations.push({
      text: trace.value.matches
        ? `The number reproduces exactly from stored records. Largest spend: ${top.map((c) => `${c.externalCampaignId} ${money(c.spendCents)} filed as ${c.channelCode} (${Object.keys(c.mapperVersions).join(", ")})`).join("; ")}.`
        : `The stored records do NOT reproduce the scorecard: ${trace.value.discrepancies.join(" ")}`,
      evidenceIds: [bm, ...top.map((c) => c.evidenceId)],
      status: "verified",
    });
    for (const e of trace.excluded) {
      observations.push(
        rendered({ text: `${e.count} new customer(s) are left out of the denominator by the definition (${e.code}): ${e.reason}.`, evidenceIds: e.evidenceIds.slice(0, 5), status: "verified" }, e.evidenceIds[0] ? [field(e.count, "getMetricTrace", e.evidenceIds[0], `excluded[code=${e.code}].count`)] : []),
      );
    }
    // Evidence the number cannot see: a campaign whose leads land here but which maps nowhere.
    for (const m of trace.missing.filter((x) => x.kind === "unmapped_campaign").slice(0, 3)) {
      const at = `missing[campaignExternalId=${m.campaignExternalId}]`;
      const figures = m.evidenceIds[0] && m.leads !== undefined && m.spendCents !== undefined ? [field(m.leads, "getMetricTrace", m.evidenceIds[0], `${at}.leads`), field(exactDollars(m.spendCents), "getMetricTrace", m.evidenceIds[0], `${at}.spendCents`)] : [];
      observations.push(rendered({ text: m.detail, evidenceIds: m.evidenceIds, status: "verified" }, figures));
    }
  }
  const unmappedHere = trace?.missing.find((x) => x.kind === "unmapped_campaign") ?? null;
  const quarantine = exc?.exceptions.find((e) => e.kind === "quarantined_source_records");
  const gap = exc?.exceptions.find((e) => e.kind === "channel_coverage_gap");
  const proposals: ProposalSuggestion[] = [];
  let cause: DraftFindings["suspectedCause"] = null;
  let confidence: DraftFindings["confidence"] = { level: "low", why: "No open integrity exception at this branch explains the number." };
  let effect = "None proposed.";
  let next = `Check decision readiness for ${b} before acting on its CAC.`;

  if (quarantine) {
    const ev = quarantine.evidence as Record<string, unknown>;
    const src = String(ev.source) as SourceName;
    const qId = evidence.exception(quarantine.id);
    const samples = ((ev.sampleRawEventIds as number[] | null) ?? []).slice(0, 3).map(evidence.rawEvent);
    const held = `exceptions[id=${quarantine.id}].evidence`;
    observations.push(
      rendered(
        {
          text: `${ev.records} ${src} record(s) at ${b} are quarantined (${ev.errorCode}: ${ev.sampleError}) from ${day(ev.firstOccurredAt)} to ${day(ev.lastOccurredAt)}; ${ev.customersWithoutLead} new customer(s) have no lead record because of it.`,
          evidenceIds: [qId, ...samples],
          status: "verified",
        },
        [field(String(ev.records), "getReconciliationExceptions", qId, `${held}.records`), field(String(ev.customersWithoutLead), "getReconciliationExceptions", qId, `${held}.customersWithoutLead`)],
      ),
    );
    const group = ing?.quarantineGroups.find((g) => g.exceptionId === quarantine.id);
    const stored = group?.adapterVersions.map(versionOf) ?? [];
    const fromVersion = stored.find((v) => v !== ACTIVE_VERSION[src]) ?? stored[0];
    const cmp = fromVersion ? await ctx.call("compareMappingVersions", { source: src, fromVersion, toVersion: ACTIVE_VERSION[src], exceptionId: quarantine.id }) : null;
    if (cmp) {
      observations.push(
        rendered(
          {
            text: `Re-running ${src}@${cmp.fromVersion} and ${src}@${cmp.toVersion} over the ${cmp.records} held record(s), read-only: ${cmp.outcomes.nowProjects} would now project, ${cmp.outcomes.stillFails} would still fail.`,
            evidenceIds: uniqueIds([qId, ...cmp.samples.nowProjects.slice(0, 5).map(evidence.rawEvent)]),
            status: "verified",
          },
          [field(cmp.records, "compareMappingVersions", qId, "records"), field(cmp.outcomes.nowProjects, "compareMappingVersions", qId, "outcomes.nowProjects"), field(cmp.outcomes.stillFails, "compareMappingVersions", qId, "outcomes.stillFails")],
        ),
      );
    }
    observations.push({
      text: `Paid CAC at ${b} is overstated: a customer whose only lead record is quarantined counts as channel unknown rather than paid, which shrinks the CAC denominator while the spend stays.`,
      evidenceIds: [qId, bm, evidence.metricDefinition("paidCac")],
      status: "hypothesis",
      strength: "strong",
    });
    cause = {
      text: `${b}'s ${src} feed changed shape from ${day(ev.firstOccurredAt)}: ${src}@${cmp?.fromVersion ?? "the old mapper"} cannot read those records (${ev.errorCode}), so they are held and the customers they produced have no paid touch.`,
      evidenceIds: uniqueIds([qId, ...samples]),
    };
    confidence = cmp && cmp.outcomes.nowProjects > 0
      ? { level: "high", why: `The deployed ${src} mapper reads the held records (reproduced read-only), and the quarantine is the only open exception that removes paid customers at ${b}.` }
      : { level: "medium", why: "The quarantine explains missing paid customers, but no shipped mapper reads the held records yet." };
    if (cmp && cmp.outcomes.nowProjects > 0 && quarantine.status === "open") {
      proposals.push({
        exceptionId: quarantine.id,
        kind: "replay_quarantine",
        params: { mapperVersion: ACTIVE_VERSION[src] },
        rationale: `Replay the ${cmp.records} held ${src} record(s) at ${b} through ${src}@${ACTIVE_VERSION[src]}: ${cmp.outcomes.nowProjects} of them map with it (compareMappingVersions, read-only).`,
      });
      effect = `Up to ${ev.customersWithoutLead} customer(s) regain their lead record; those whose call carries paid evidence move from unknown to a paid channel and paid CAC falls. The dry run reports the exact before/after; spend is unchanged.`;
      next = `An integration engineer dry-runs the proposed replay on exception ${quarantine.id}; a different role approves it.`;
    }
  }
  if (gap) {
    observations.push({
      // Quoted: the exception's own summary, whose figures are the detector's, not checked here.
      text: `A channel coverage gap is also open at ${b}: "${gap.summary}"`,
      evidenceIds: [evidence.exception(gap.id)],
      status: "verified",
    });
  }
  if (!quarantine && !gap && unmappedHere) {
    // Not a write the AI path may take: the mapping is a person-owned configuration, previewed
    // and approved in ChangeGuard (no Action Center proposal is suggested for it here).
    next = `Preview mapping the campaign to ${b} in ChangeGuard (the trace links to it prefilled); a different person approves it there.`;
    effect = "If approved and released, the campaign's spend moves from unallocated to this branch and its customers rejoin the denominator; ChangeGuard previews the exact change. No business improvement follows from a mapping by itself.";
    confidence = { level: "medium", why: "The trace shows a campaign whose leads arrive here but which maps to no branch; whether it belongs here is a person's decision." };
  }
  if (!quarantine && !gap) {
    observations.push({
      text: `No open quarantine or coverage-gap exception at ${b} explains its CAC; the number may reflect real economics (or slow conversion of recent leads — period CAC is not cohort CAC).`,
      evidenceIds: [bm, evidence.metricDefinition("paidCac")],
      status: "hypothesis",
      strength: "weak",
    });
  }
  const readiness = await ctx.call("getDecisionReadiness", { branchId: b, period: d.period });
  if (readiness) {
    const blocked = readiness.channels.filter((ch) => ch.readiness.status !== "ready");
    observations.push({
      text: `Decision readiness at ${b}: ${blocked.length} of ${readiness.channels.length} paid channel(s) not ready to move budget; the budget signal is ${readiness.budgetSignal.trustworthy ? "trustworthy" : "not trustworthy"}.`,
      evidenceIds: readiness.channels.map((ch) => evidence.readiness(b, d.period, ch.channelCode)),
      status: "verified",
    });
  }
  return {
    summary: quarantine
      ? `${b}'s paid CAC (${money(metrics.paidCacCents)}) is inflated by a data problem, not only by spend: ${quarantine.summary}. Those customers count as unknown instead of paid.`
      : `${b}'s paid CAC is ${money(metrics.paidCacCents)}; no open data-integrity exception explains it.`,
    observations,
    suspectedCause: cause,
    confidence,
    recommendedNextAction: next,
    expectedEffect: effect,
    risks: quarantine
      ? ["Replayed records change historical lead counts and channel credit for the affected days.", "A lower CAC after the fix is a measurement correction, not a change in marketing performance."]
      : ["Moving budget on attributed CAC alone risks acting on correlation."],
    missingInformation: quarantine ? [] : ["Cohort-based CAC (leads followed to conversion) — the scorecard reports period CAC."],
    proposals,
  };
}

// ── quarantine ───────────────────────────────────────────────────────────────

async function quarantinePlan(ctx: PlanContext, d: DetectedIntent): Promise<DraftFindings> {
  const ing = await ctx.call("getIngestionFailures", { ...(d.branchId ? { branchId: d.branchId } : {}) });
  if (!ing) return nothingReadable(ctx, `Ingestion failures${d.branchId ? ` for ${d.branchId}` : ""} could not be read.`);
  const groups = d.exceptionId ? ing.quarantineGroups.filter((g) => g.exceptionId === d.exceptionId) : ing.quarantineGroups;
  if (groups.length === 0) {
    const draft = emptyDraft(`No records are quarantined${d.branchId ? ` at ${d.branchId}` : " in your scope"}.`);
    draft.confidence = { level: "medium", why: "The ingestion log shows no held records in scope." };
    return draft;
  }
  const observations: Observation[] = [];
  const proposals: ProposalSuggestion[] = [];
  let cause: DraftFindings["suspectedCause"] = null;
  for (const g of groups.slice(0, 3)) {
    const ids = uniqueIds([...(g.exceptionId ? [evidence.exception(g.exceptionId)] : []), ...g.sampleRawEventIds.slice(0, 3).map(evidence.rawEvent)]);
    const group = `quarantineGroups[source=${g.source}&errorCode=${g.errorCode}&branchId=${g.branchId}&exceptionId=${g.exceptionId}]`;
    observations.push(
      rendered(
        {
          text: `${g.records} ${g.source} record(s)${g.branchId ? ` at ${g.branchId}` : ""} are quarantined with ${g.errorCode} (${g.sampleError ?? "no detail"}), first ${day(g.firstOccurredAt)}, last ${day(g.lastOccurredAt)}, refused by ${g.adapterVersions.join(", ")}.`,
          evidenceIds: ids,
          status: "verified",
        },
        ids[0] ? [field(g.records, "getIngestionFailures", ids[0], `${group}.records`)] : [],
      ),
    );
  }
  const top = groups[0];
  const src = top.source as SourceName;
  const sample = top.sampleRawEventIds[0];
  if (sample) await ctx.call("getSourceLineage", { rawEventId: sample });
  const fromVersion = top.adapterVersions.map(versionOf).find((v) => v !== ACTIVE_VERSION[src]) ?? versionOf(top.adapterVersions[0]);
  const cmp = top.exceptionId ? await ctx.call("compareMappingVersions", { source: src, fromVersion, toVersion: ACTIVE_VERSION[src], exceptionId: top.exceptionId }) : null;
  if (cmp && top.exceptionId) {
    const qId = evidence.exception(top.exceptionId);
    observations.push(
      rendered(
        {
          text: `Read-only comparison: ${src}@${cmp.toVersion} (deployed) maps ${cmp.outcomes.nowProjects} of the ${cmp.records} held record(s) that ${src}@${cmp.fromVersion} refused; ${cmp.outcomes.stillFails} still fail.`,
          evidenceIds: uniqueIds([qId, ...cmp.samples.nowProjects.slice(0, 5).map(evidence.rawEvent)]),
          status: "verified",
        },
        [field(cmp.outcomes.nowProjects, "compareMappingVersions", qId, "outcomes.nowProjects"), field(cmp.records, "compareMappingVersions", qId, "records"), field(cmp.outcomes.stillFails, "compareMappingVersions", qId, "outcomes.stillFails")],
      ),
    );
    if (cmp.outcomes.nowProjects > 0) {
      cause = {
        text: `The ${src} source changed the shape of these records; ${src}@${cmp.fromVersion} rejected them and ${src}@${cmp.toVersion}, deployed since, reads the new shape. The held records were never replayed.`,
        evidenceIds: uniqueIds([evidence.exception(top.exceptionId), ...cmp.samples.nowProjects.slice(0, 3).map(evidence.rawEvent)]),
      };
      proposals.push({
        exceptionId: top.exceptionId,
        kind: "replay_quarantine",
        params: { mapperVersion: ACTIVE_VERSION[src] },
        rationale: `Replay the ${cmp.records} held ${src} record(s) through ${src}@${ACTIVE_VERSION[src]}: ${cmp.outcomes.nowProjects} map with it (compareMappingVersions, read-only).`,
      });
    }
  }
  return {
    summary: `${groups.reduce((s, g) => s + g.records, 0)} record(s) are held in quarantine in ${groups.length} group(s); the largest is ${top.records} ${top.source} record(s) with ${top.errorCode}${cmp && cmp.outcomes.nowProjects > 0 ? `, which the deployed mapper can now read` : ""}.`,
    observations,
    suspectedCause: cause,
    confidence: cause ? { level: "high", why: "The deployed mapper reads the held records in a read-only re-run." } : { level: "medium", why: "The records are held; no shipped mapper reads them yet." },
    recommendedNextAction: proposals.length ? `Dry-run the proposed replay on exception ${top.exceptionId}, then have a different role approve it.` : "Fix the mapper for this shape, ship it, then replay the group.",
    expectedEffect: proposals.length ? "The held records project; customers who had no lead record regain one; the quarantine exception resolves after reconciliation (verified by the dry run)." : "None yet.",
    risks: ["Replayed records change historical lead counts and channel credit for the affected days."],
    missingInformation: [],
    proposals,
  };
}

// ── duplicates ───────────────────────────────────────────────────────────────

async function duplicatesPlan(ctx: PlanContext, d: DetectedIntent): Promise<DraftFindings> {
  const ing = await ctx.call("getIngestionFailures", { ...(d.branchId ? { branchId: d.branchId } : {}) });
  if (!ing) return nothingReadable(ctx, "Ingestion statistics could not be read.");
  const def = await ctx.call("getMetricDefinition", { key: "prospects" });
  const observations: Observation[] = [];
  const redelivered = ing.duplicates.filter((x) => x.duplicateDeliveries > 0);
  for (const x of redelivered.slice(0, 4)) {
    const ids = x.sampleRawEventIds.map(evidence.rawEvent);
    const at = `duplicates[source=${x.source}]`;
    const figures = ids[0]
      ? [
          field(x.recordsRedelivered, "getIngestionFailures", ids[0], `${at}.recordsRedelivered`),
          field(x.duplicateDeliveries, "getIngestionFailures", ids[0], `${at}.duplicateDeliveries`),
          ...(x.storedEvents === null ? [] : [field(x.storedEvents, "getIngestionFailures", ids[0], `${at}.storedEvents`), field(x.storedEvents + x.duplicateDeliveries, "getIngestionFailures", ids[0], `${at}.storedEvents + ${at}.duplicateDeliveries`)]),
        ]
      : [];
    observations.push(
      rendered(
        {
          text: `${x.source}: ${x.recordsRedelivered} stored record version(s) were delivered more than once (${x.duplicateDeliveries} extra deliveries); each version is stored once, keyed by source and external id${x.storedEvents === null ? "" : `, so ${x.storedEvents} events are counted, not ${x.storedEvents + x.duplicateDeliveries}`}.`,
          evidenceIds: ids,
          status: "verified",
        },
        figures,
      ),
    );
  }
  if (redelivered[0]?.sampleRawEventIds[0]) await ctx.call("getSourceLineage", { rawEventId: redelivered[0].sampleRawEventIds[0] });
  for (const c of ing.payloadConflicts.slice(0, 3)) {
    observations.push({
      text: `Payload conflict (exception ${c.exceptionId}, ${c.status}): ${c.summary}. The first payload was kept; a person decides whether the source has a bug.`,
      evidenceIds: [evidence.exception(c.exceptionId)],
      status: "verified",
    });
  }
  if (def) {
    observations.push({
      text: `Prospects are counted as distinct phone (else email) hashes, so a person who calls twice is one prospect: "${def.formula}".`,
      evidenceIds: [evidence.metricDefinition("prospects")],
      status: "hypothesis",
      strength: "strong",
    });
  }
  return {
    summary: redelivered.length
      ? `Duplicate deliveries are absorbed at ingest and not double counted: ${redelivered.reduce((s, x) => s + x.duplicateDeliveries, 0)} extra deliveries across ${redelivered.length} source(s) were recognised as the same record version.${ing.payloadConflicts.length ? ` ${ing.payloadConflicts.length} same-version payload conflict(s) are open for review.` : ""}`
      : `No duplicate deliveries are recorded${d.branchId ? ` for ${d.branchId}` : ""}.`,
    observations,
    suspectedCause: null,
    confidence: { level: redelivered.length ? "high" : "medium", why: "Exactly-once ingest is enforced by a unique (source, external id) key; delivery counts are stored per event." },
    recommendedNextAction: ing.payloadConflicts.length ? "Review the open payload conflicts with the source owner." : "No action needed.",
    expectedEffect: "None: nothing is proposed.",
    risks: [],
    missingInformation: [],
    proposals: [],
  };
}

// ── customer lookup ──────────────────────────────────────────────────────────

async function customerPlan(ctx: PlanContext, d: DetectedIntent): Promise<DraftFindings> {
  const id = d.customerId!;
  const j = await ctx.call("getCustomerJourney", { customerId: id });
  if (!j) return nothingReadable(ctx, `Customer ${id} could not be read.`);
  const cust = evidence.customer(id);
  const observations: Observation[] = [];
  const a = j.attribution;
  const credited = a?.creditedLeadId ? j.leads.find((l) => l.id === a.creditedLeadId) : undefined;
  if (a && credited) {
    const lineage = await ctx.call("getSourceLineage", { rawEventId: credited.rawEventId });
    observations.push({
      text: `Customer ${id} (${j.branchId ?? "unknown branch"}, ${j.lifecycle}) is credited to ${channelLabel(a.channelCode)} by first evidenced touch: ${credited.source} lead ${credited.sourceLeadId} on ${day(credited.occurredAt)} (evidence: ${a.attributionEvidence ?? "none"}${a.campaignName ? `, campaign "${a.campaignName}"` : a.campaignExternalId ? `, campaign ${a.campaignExternalId}` : ""}), sold ${day(a.soldAt)}.`,
      evidenceIds: uniqueIds([cust, evidence.lead(credited.id), evidence.rawEvent(credited.rawEventId)]),
      status: "verified",
    });
    if (lineage && lineage.kind === "raw_event") {
      const raw = evidence.rawEvent(lineage.rawEvent.id);
      observations.push(
        rendered(
          {
            text: `That lead's raw record (raw event ${lineage.rawEvent.id}) was received ${day(lineage.rawEvent.receivedAt)}, mapped by ${lineage.rawEvent.adapterVersion}, delivered ${lineage.rawEvent.deliveryCount} time(s); ${lineage.versions.length} stored version(s).`,
            evidenceIds: [raw],
            status: "verified",
          },
          [field(lineage.rawEvent.deliveryCount, "getSourceLineage", raw, "rawEvent.deliveryCount"), field(lineage.versions.length, "getSourceLineage", raw, "#versions")],
        ),
      );
    }
  } else if (a) {
    observations.push({
      text: `Customer ${id} (${j.branchId ?? "unknown branch"}, ${j.lifecycle}) has attribution basis ${a.attributionBasis}: channel ${channelLabel(a.channelCode)}. ${j.flags.noLeadRecord ? "No lead record matches this customer." : "Its leads carry no attribution evidence."}`,
      evidenceIds: uniqueIds([cust, ...(j.customerRawEventId ? [evidence.rawEvent(j.customerRawEventId)] : [])]),
      status: "verified",
    });
  } else {
    observations.push({
      text: `Customer ${id} has no delivered subscription, so there is no acquisition to attribute yet (lifecycle ${j.lifecycle}).`,
      evidenceIds: [cust],
      status: "verified",
    });
  }
  if (j.leads.length > 0) {
    const bySource = j.leads.reduce<Record<string, number>>((acc, l) => ({ ...acc, [l.source]: (acc[l.source] ?? 0) + 1 }), {});
    observations.push(
      rendered(
        {
          text: `${j.leads.length} lead record(s) are linked by exact phone/email hash: ${Object.entries(bySource).map(([s, n]) => `${n} ${s}`).join(", ")}; channels ${[...new Set(j.leads.map((l) => channelLabel(l.channelCode)))].join(", ")}.`,
          evidenceIds: j.leads.slice(0, 5).map((l) => evidence.lead(l.id)),
          status: "verified",
        },
        [field(j.leads.length, "getCustomerJourney", cust, "#leads"), ...Object.entries(bySource).map(([s, n]) => field(n, "getCustomerJourney", cust, `#leads[source=${s}]`))],
      ),
    );
  }
  // One customer's money is not among the metric facts (those are a branch's); each figure is
  // proved against the journey's own money fields.
  const m = (key: keyof typeof j.money) => field(money(j.money[key]), "getCustomerJourney", cust, `money.${key}`);
  observations.push(
    rendered(
      {
        text: `Money: ${money(j.money.collectedCents)} collected = ${money(j.money.paymentsCents)} successful payments − ${money(j.money.refundsCents)} refunds; ${money(j.money.invoicedCents)} invoiced; ${money(j.money.failedOrVoidedCents)} failed or voided (never counted).`,
        evidenceIds: uniqueIds([cust, ...j.payments.slice(0, 5).map((p) => evidence.payment(p.id))]),
        status: "verified",
      },
      [m("collectedCents"), m("paymentsCents"), m("refundsCents"), m("invoicedCents"), m("failedOrVoidedCents")],
    ),
  );
  const exceptions = j.flags.openExceptions;
  if (exceptions.length > 0) {
    const first = await ctx.call("getReconciliationExceptions", { exceptionId: exceptions[0].id });
    // The exception's own summary is quoted: its figures are the exception's, not checked here.
    observations.push(
      rendered(
        {
          text: `${exceptions.length} open exception(s) touch this customer: ${exceptions.map((e) => `${e.kind} ${e.id}`).join(", ")}${first ? ` — "${first.exceptions[0].summary}"` : ""}.`,
          evidenceIds: exceptions.map((e) => evidence.exception(e.id)),
          status: "verified",
        },
        [field(exceptions.length, "getCustomerJourney", cust, "#flags.openExceptions")],
      ),
    );
    if (j.flags.noLeadRecord && exceptions.some((e) => e.kind === "quarantined_source_records")) {
      observations.push({
        text: `The customer's own lead is probably among the quarantined records: it has no lead record and a quarantine exception lists it.`,
        evidenceIds: [cust, ...exceptions.filter((e) => e.kind === "quarantined_source_records").map((e) => evidence.exception(e.id))],
        status: "hypothesis",
        strength: "strong",
      });
    }
  }
  if (j.flags.pendingConflicts > 0) {
    observations.push(rendered({ text: `${j.flags.pendingConflicts} identity match(es) for this customer wait for a reviewer.`, evidenceIds: [cust], status: "verified" }, [field(j.flags.pendingConflicts, "getCustomerJourney", cust, "flags.pendingConflicts")]));
  }
  return {
    summary: a
      ? `Customer ${id} is credited to ${channelLabel(a.channelCode)} (${a.attributionBasis.replace(/_/g, " ")})${credited ? ` from ${credited.source} lead ${credited.sourceLeadId}` : ""}; ${money(j.money.collectedCents)} collected to date.`
      : `Customer ${id} has no acquisition to attribute yet.`,
    observations,
    suspectedCause: null,
    confidence: { level: "high", why: "Read directly from the customer's stored records and the attribution view." },
    recommendedNextAction: exceptions.length ? `Open exception ${exceptions[0].id} in the Action Center.` : `Open the customer's journey for the full timeline.`,
    expectedEffect: "None: nothing is proposed.",
    risks: [],
    missingInformation: j.unknowns.slice(0, 3).map((u) => `${u.subject}: ${u.field} — ${u.note}`),
    proposals: [],
  };
}

// ── branch mismatch ──────────────────────────────────────────────────────────

async function branchMismatchPlan(ctx: PlanContext, d: DetectedIntent): Promise<DraftFindings> {
  const list = d.exceptionId
    ? await ctx.call("getReconciliationExceptions", { exceptionId: d.exceptionId })
    : await ctx.call("getReconciliationExceptions", { ...(d.branchId ? { branchId: d.branchId } : {}), kind: "branch_mismatch", status: "open", limit: 25 });
  if (!list) return nothingReadable(ctx, "Branch-mismatch exceptions could not be read.");
  const rows = list.exceptions.filter((e) => e.kind === "branch_mismatch");
  if (rows.length === 0) {
    const draft = emptyDraft(`No open branch mismatch${d.branchId ? ` at ${d.branchId}` : " in your scope"}.`);
    draft.confidence = { level: "medium", why: "The reconciliation detector found no lead credited to a branch other than the servicing one." };
    return draft;
  }
  const pairs = new Map<string, { lead: string; crm: string; territory: string | null; ids: number[] }>();
  for (const e of rows) {
    const ev = e.evidence as Record<string, unknown>;
    const key = `${ev.leadBranch}→${ev.crmBranch}`;
    const entry = pairs.get(key) ?? { lead: String(ev.leadBranch), crm: String(ev.crmBranch), territory: (ev.territoryBranch as string) ?? null, ids: [] };
    entry.ids.push(e.id);
    pairs.set(key, entry);
  }
  // The list is a bounded sample: state the true total from the tool's counts, and how many of
  // them were read, so a sample size is never presented as the whole (found by the numeric
  // claim check: "25 lead(s)" at a branch with 58 open mismatches).
  const openTotal = list.counts.find((c) => c.kind === "branch_mismatch")?.open ?? rows.length;
  const sampled = rows.length < openTotal;
  const observations: Observation[] = [...pairs.values()].slice(0, 4).map((p) => {
    const cite = evidence.exception(p.ids[0]);
    const pair = field(p.ids.length, "getReconciliationExceptions", cite, `#exceptions[kind=branch_mismatch&evidence.leadBranch=${p.lead}&evidence.crmBranch=${p.crm}]`);
    return rendered(
      {
        text: sampled
          ? `${openTotal} branch-mismatch exception(s) are open${d.branchId ? ` at ${d.branchId}` : ""}; of the ${rows.length} read, ${p.ids.length} are leads captured for ${p.lead} that belong to customers serviced by ${p.crm}${p.territory ? ` (the territory table also says ${p.territory})` : ""}.`
          : `${p.ids.length} lead(s) captured for ${p.lead} belong to customers serviced by ${p.crm}${p.territory ? ` (the territory table also says ${p.territory})` : ""}.`,
        evidenceIds: p.ids.slice(0, 5).map(evidence.exception),
        status: "verified" as const,
      },
      sampled ? [field(openTotal, "getReconciliationExceptions", cite, "counts[kind=branch_mismatch].open"), field(rows.length, "getReconciliationExceptions", cite, "#exceptions[kind=branch_mismatch]"), pair] : [pair],
    );
  });
  const top = rows[0];
  const tev = top.evidence as Record<string, unknown>;
  const journey = tev.customerId ? await ctx.call("getCustomerJourney", { customerId: Number(tev.customerId) }) : null;
  if (journey) {
    observations.push({
      text: `Example: customer ${tev.customerId} lives in zip ${tev.customerZip ?? "?"}, is serviced by ${journey.branchId}, and its credited lead was captured for ${tev.leadBranch}.`,
      evidenceIds: [evidence.exception(top.id), evidence.customer(Number(tev.customerId))],
      status: "verified",
    });
  }
  const agreed = [...pairs.values()].filter((p) => p.territory && p.territory === p.crm);
  if (agreed.length) {
    observations.push({
      text: `Where the territory table and the CRM office agree, the capturing system's zip → branch lookup is the likely fault (for example a website lookup not updated after a territory change).`,
      evidenceIds: agreed[0].ids.slice(0, 3).map(evidence.exception),
      status: "hypothesis",
      strength: "strong",
    });
  }
  const proposals: ProposalSuggestion[] = [];
  if (tev.territoryBranch && tev.territoryBranch === tev.crmBranch && top.status === "open") {
    proposals.push({
      exceptionId: top.id,
      kind: "override_lead_branch",
      params: { branchId: String(tev.crmBranch) },
      rationale: `Lead ${tev.leadId} was captured for ${tev.leadBranch}; the CRM office and the territory table both say ${tev.crmBranch}. Credit it to ${tev.crmBranch}; the capturing system's lookup still needs fixing at the source.`,
    });
  }
  return {
    summary: `${rows.length} lead(s) are credited to a branch other than the one servicing the customer; the main pattern is ${[...pairs.values()][0].lead} → ${[...pairs.values()][0].crm}.`,
    observations,
    suspectedCause: agreed.length
      ? { text: "The capturing system assigns these zips to the old branch while the CRM and the territory table use the new one.", evidenceIds: agreed[0].ids.slice(0, 3).map(evidence.exception) }
      : null,
    confidence: { level: agreed.length ? "medium" : "low", why: "The mismatch is recorded per lead; which side is right is a business decision for each case." },
    recommendedNextAction: "Fix the zip → branch lookup at the source; credit individual leads only where both the CRM and the territory table agree.",
    expectedEffect: proposals.length ? `Lead ${tev.leadId} is credited to ${tev.crmBranch}; the exception resolves (verified by the dry run). The other mismatches stay until the source is fixed.` : "None proposed.",
    risks: ["Overrides fix credit in this system only; new leads keep arriving with the wrong branch until the source lookup is fixed."],
    missingInformation: [],
    proposals,
  };
}

// ── conflicting acquisition channel ──────────────────────────────────────────

async function channelConflictPlan(ctx: PlanContext, d: DetectedIntent): Promise<DraftFindings> {
  const list = await ctx.call("getReconciliationExceptions", { ...(d.branchId ? { branchId: d.branchId } : {}), kind: "channel_conflict", status: "open", limit: 10 });
  if (!list) return nothingReadable(ctx, "Channel conflicts could not be read.");
  const rows = list.exceptions;
  if (rows.length === 0) return { ...emptyDraft(`No open D2D / paid channel conflict${d.branchId ? ` at ${d.branchId}` : ""}.`), confidence: { level: "medium", why: "The detector found none." } };
  const counted = list.counts.find((c) => c.kind === "channel_conflict")?.open;
  const count = counted ?? rows.length;
  const top = rows[0];
  const ev = top.evidence as Record<string, unknown>;
  const journey = ev.customerId ? await ctx.call("getCustomerJourney", { customerId: Number(ev.customerId) }) : null;
  await ctx.call("getMetricDefinition", { key: "acquired" });
  const observations: Observation[] = [
    rendered(
      {
        text: `${count} open conflict(s)${d.branchId ? ` at ${d.branchId}` : " in scope"}: a paid touch reached the customer first, then a door-to-door rep signed the sale; credit follows the first evidenced touch.`,
        evidenceIds: rows.slice(0, 5).map((e) => evidence.exception(e.id)),
        status: "verified",
      },
      [field(count, "getReconciliationExceptions", evidence.exception(top.id), counted === undefined ? "#exceptions" : "counts[kind=channel_conflict].open")],
    ),
  ];
  if (journey) {
    observations.push({
      text: `Example: customer ${ev.customerId} is credited to ${channelLabel(String(ev.creditedChannel))} (lead ${ev.leadId}) and was sold by rep ${ev.soldByRep ?? "?"} on ${day(ev.soldAt)}.`,
      evidenceIds: uniqueIds([evidence.exception(top.id), evidence.customer(Number(ev.customerId)), ...(ev.leadId ? [evidence.lead(Number(ev.leadId))] : [])]),
      status: "verified",
    });
  }
  observations.push({
    text: "If commission is paid on these sales, the same customer is paid for twice: once as media spend, once as commission.",
    evidenceIds: rows.slice(0, 3).map((e) => evidence.exception(e.id)),
    status: "hypothesis",
    strength: "weak",
  });
  return {
    summary: `${count} customer(s) have conflicting acquisition channels: credited to a paid first touch, signed by a door-to-door rep. This is a policy question (commission vs media credit), not a data error.`,
    observations,
    suspectedCause: null,
    confidence: { level: "medium", why: "The conflict is recorded per customer; whether it matters depends on the commission policy." },
    recommendedNextAction: "Review commission on these sales, then acknowledge each conflict in the Action Center (a person's decision; the AI path does not propose it).",
    expectedEffect: "None: nothing is proposed.",
    risks: ["Re-crediting the sale to D2D would hide that a paid touch came first."],
    missingInformation: ["Commission records — they are not in this system."],
    proposals: [],
  };
}

// ── refunds and payment reconciliation ───────────────────────────────────────

async function refundsPlan(ctx: PlanContext, d: DetectedIntent): Promise<DraftFindings> {
  if (!d.branchId && !d.customerId) return needBranch(ctx, "Refund reconciliation");
  const observations: Observation[] = [];
  let summary = "";
  if (d.branchId) {
    const m = await ctx.call("getBranchMetrics", { branchId: d.branchId, period: d.period });
    if (!m) return nothingReadable(ctx, `${d.branchId}'s revenue could not be read.`);
    observations.push({
      text: `${d.branchId}, ${m.period.label}: ${money(m.collectedCents)} collected net of ${money(m.refundsCents)} refunds (successful payments minus refund rows, by payment date).`,
      evidenceIds: [evidence.branchMetrics(d.branchId, m.period.key)],
      status: "verified",
    });
    summary = `${d.branchId} refunded ${money(m.refundsCents)} in ${m.period.label}; collected revenue is already net of it.`;
  }
  await ctx.call("getMetricDefinition", { key: "collected" });
  const pwt = await ctx.call("getReconciliationExceptions", { ...(d.branchId ? { branchId: d.branchId } : {}), kind: "payment_without_ticket", limit: 10 });
  if (pwt) {
    const c = pwt.counts.find((x) => x.kind === "payment_without_ticket");
    if (c && pwt.exceptions.length > 0) {
      observations.push({
        text: `Payments applied to an invoice the CRM feed had not delivered: ${c.open} open, ${c.resolved} resolved (they clear when the invoice arrives).`,
        evidenceIds: pwt.exceptions.slice(0, 5).map((e) => evidence.exception(e.id)),
        status: "verified",
      });
    }
  }
  if (d.customerId) {
    const j = await ctx.call("getCustomerJourney", { customerId: d.customerId });
    if (j) {
      const refunds = j.payments.filter((p) => p.isRefund);
      observations.push({
        text: `Customer ${d.customerId}: ${refunds.length} refund row(s) totalling ${money(j.money.refundsCents)}; ${money(j.money.collectedCents)} collected = ${money(j.money.paymentsCents)} payments − refunds.`,
        evidenceIds: uniqueIds([evidence.customer(d.customerId), ...refunds.map((p) => evidence.payment(p.id))]),
        status: "verified",
      });
      summary = `${summary} Customer ${d.customerId} has ${money(j.money.refundsCents)} in refunds; collected ${money(j.money.collectedCents)}.`.trim();
    }
  }
  if (observations.length === 0) return nothingReadable(ctx, "No refund data could be read.");
  return {
    summary,
    observations,
    suspectedCause: null,
    confidence: { level: "high", why: "Refunds are stored as negative payment rows linked to the original payment; collected revenue subtracts them." },
    recommendedNextAction: "No action needed unless a refund lacks its original payment.",
    expectedEffect: "None: nothing is proposed.",
    risks: [],
    missingInformation: [],
    proposals: [],
  };
}

// ── stale sync ───────────────────────────────────────────────────────────────

async function staleSyncPlan(ctx: PlanContext, d: DetectedIntent): Promise<DraftFindings> {
  const ing = await ctx.call("getIngestionFailures", { ...(d.branchId ? { branchId: d.branchId } : {}) });
  if (!ing) return nothingReadable(ctx, "Feed freshness could not be read.");
  const observations: Observation[] = [];
  const stale = ing.streams.filter((s) => s.hoursSinceSuccess === null || s.hoursSinceSuccess > FRESHNESS_MAX_AGE_HOURS);
  for (const s of ing.streams.slice(0, 8)) {
    if (!s.lastSuccessRunId) continue;
    const run = evidence.ingestionRun(s.lastSuccessRunId);
    const at = `streams[stream=${s.stream}]`;
    observations.push(
      rendered(
        {
          text: `${s.stream}: last successful run ${s.lastSuccessRunId} at ${when(s.lastSuccessAt)} (${s.hoursSinceSuccess ?? "?"} h before the business clock; stale after ${s.staleAfterHours} h); last run ${s.lastRunStatus ?? "none"}.`,
          evidenceIds: [run],
          status: "verified",
        },
        [...(s.hoursSinceSuccess === null ? [] : [field(s.hoursSinceSuccess, "getIngestionFailures", run, `${at}.hoursSinceSuccess`)]), field(s.staleAfterHours, "getIngestionFailures", run, `${at}.staleAfterHours`)],
      ),
    );
  }
  for (const f of ing.failedRuns.slice(0, 3)) {
    observations.push({
      text: `Run ${f.id} (${f.stream}) failed at ${when(f.startedAt)}${f.error ? ` (${f.error})` : ""}; ${f.recoveredByRunId ? `run ${f.recoveredByRunId} re-read its window and succeeded` : "no later run has succeeded yet"}.`,
      evidenceIds: uniqueIds([evidence.ingestionRun(f.id), ...(f.recoveredByRunId ? [evidence.ingestionRun(f.recoveredByRunId)] : [])]),
      status: "verified",
    });
  }
  if (d.branchId) await ctx.call("getDecisionReadiness", { branchId: d.branchId, period: d.period });
  return {
    summary: stale.length
      ? `${stale.length} feed(s) are stale (no success within ${FRESHNESS_MAX_AGE_HOURS} h): ${stale.map((s) => s.stream).join(", ")}.`
      : `Every feed succeeded within ${FRESHNESS_MAX_AGE_HOURS} h of the business clock${ing.failedRuns.length ? `; ${ing.failedRuns.length} failed run(s) were recovered by a later run` : ""}.`,
    observations,
    suspectedCause: null,
    confidence: { level: "high", why: "Read from the ingestion run log against the business clock." },
    recommendedNextAction: stale.length ? "Check the stale connectors on the Integrations page and trigger a sync." : "No action needed.",
    expectedEffect: "None: nothing is proposed.",
    risks: [],
    missingInformation: [],
    proposals: [],
  };
}

// ── no evidence ──────────────────────────────────────────────────────────────

async function noEvidencePlan(ctx: PlanContext, d: DetectedIntent): Promise<DraftFindings> {
  const list = await ctx.call("getReconciliationExceptions", { ...(d.branchId ? { branchId: d.branchId } : {}), status: "open", limit: 5 });
  const draft = emptyDraft(
    "No stored evidence answers this question. The tools cover branch metrics, customer journeys, source lineage, ingestion failures, reconciliation exceptions, mapper comparisons, campaign classification, metric definitions, audit history and decision readiness.",
  );
  draft.missingInformation = [
    "The question does not name anything the tools can look up (a branch metric, a customer id, an exception, a campaign, a feed).",
    ...failureNotes(ctx),
  ];
  if (list && list.exceptions.length > 0) {
    draft.recommendedNextAction = `Ask about a specific incident instead; for example exception ${list.exceptions[0].id} (${list.exceptions[0].kind}).`;
  }
  return draft;
}

// ── plain figure questions ───────────────────────────────────────────────────

/**
 * A plain question about figures ("How much did B33 spend…", "What did B42 collect…"): the
 * branch's scorecard figures and, for spend, its campaigns and the records held out at intake.
 * Every sentence is filled from a structured result (a template, proved by lib/ai/proof.ts). A
 * question that names a brand and no branch gets the brand's rollup.
 */
async function metricLookupPlan(ctx: PlanContext, d: DetectedIntent): Promise<DraftFindings> {
  if (d.brandId && !d.branchId) return brandRollupPlan(ctx, d, d.brandId);
  if (!d.branchId) return needBranch(ctx, "A branch's figures are");
  const b = d.branchId;
  const metrics = await ctx.call("getBranchMetrics", { branchId: b, period: d.period });
  if (!metrics) return nothingReadable(ctx, `${b}'s metrics could not be read.`);
  const bm = evidence.branchMetrics(b, metrics.period.key);
  const label = metrics.period.label;
  const observations: Observation[] = [];
  const trace = d.period === "all" ? null : await ctx.call("getMetricTrace", { branchId: b, period: d.period, metric: "paid_cac" });
  const campaigns = trace?.campaigns ?? [];
  const more = trace && trace.campaignsOmitted > 0 ? ` (the ${trace.campaignsOmitted} smallest not listed)` : "";
  observations.push(
    rendered(
      {
        text: `${b}, ${label}: paid media spend ${money(metrics.paidSpendCents)}${campaigns.length ? ` across ${campaigns.length + (trace?.campaignsOmitted ?? 0)} campaign(s)${more}` : ""}.`,
        evidenceIds: [bm],
        status: "verified",
      },
      trace && campaigns.length ? [field(campaigns.length + trace.campaignsOmitted, "getMetricTrace", bm, "#campaigns + campaignsOmitted"), ...(trace.campaignsOmitted > 0 ? [field(trace.campaignsOmitted, "getMetricTrace", bm, "campaignsOmitted")] : [])] : [],
    ),
  );
  for (const c of campaigns.slice(0, 5)) {
    const credited = c.paidCustomersCredited === null ? "" : `; campaign ${c.externalCampaignId} is credited with ${c.paidCustomersCredited} paid customer(s)`;
    observations.push({ text: `${b}, ${label}: campaign ${c.externalCampaignId} spent ${money(c.spendCents)} (filed as ${c.channelCode})${credited}.`, evidenceIds: [bm, c.evidenceId], status: "verified" });
  }
  observations.push({
    text: `${b}, ${label}: ${metrics.acquired} new customers serviced; ${metrics.paidAcquired} new customers whose first evidenced touch was paid; paid-media CAC ${money(metrics.paidCacCents)}${metrics.paidCacCents === null ? "" : ` = ${exactDollars(metrics.paidSpendCents)} ÷ ${metrics.paidAcquired}`}; ${metrics.unknownAcquired} of ${metrics.acquired} new customers (${pct(metrics.unknownShare)}) have channel unknown.`,
    evidenceIds: [bm],
    status: "verified",
  });
  observations.push({
    text: `${b}, ${label}: collected cash ${money(metrics.collectedCents)} (successful payments minus refunds, by payment date); refunds ${money(metrics.refundsCents)}.`,
    evidenceIds: [bm],
    status: "verified",
  });
  observations.push(...(await comparisonObservations(ctx, d, b, metrics)));
  // Questions about cash: the payments and refunds behind it, reproduced to the cent.
  const cash = d.asksCash && d.period !== "all" ? await ctx.call("getCashTrace", { branchId: b, period: d.period }) : null;
  if (cash) {
    const r = cash.value.reproduced;
    const broken = cash.invariants.filter((i) => !i.holds);
    observations.push(
      rendered(
        {
          text: cash.value.matches
            ? `${b}, ${label}: collected cash ${exactDollars(r.collectedCents)} = ${exactDollars(r.grossCents)} paid − ${exactDollars(r.refundsCents)} refunded, from ${cash.payments.count} stored payment record(s), ${cash.payments.refunds} of them refunds${broken.length ? `; ${broken.length} invariant(s) broken: ${broken.map((i) => i.name).join("; ")}` : ""}.`
            : `The stored payment records do NOT reproduce ${b}'s collected cash: ${cash.value.discrepancies.join(" ")}`,
          evidenceIds: [bm, ...cash.payments.sample.slice(0, 5).map((p) => p.evidenceId)],
          status: "verified",
        },
        cash.value.matches ? [field(cash.payments.count, "getCashTrace", bm, "payments.count"), field(cash.payments.refunds, "getCashTrace", bm, "payments.refunds")] : [],
      ),
    );
    for (const e of cash.excluded) {
      observations.push(
        rendered({ text: `${e.count} payment record(s) at ${b} are not in collected cash (${e.code}): ${e.reason}.`, evidenceIds: e.evidenceIds.slice(0, 5), status: "verified" }, e.evidenceIds[0] ? [field(e.count, "getCashTrace", e.evidenceIds[0], `excluded[code=${e.code}].count`)] : []),
      );
    }
  }
  const channels = metrics.channels.filter((c) => c.spendCents > 0 || c.acquired > 0);
  if (channels.length > 0) {
    observations.push({
      text: `${b}, ${label}, by channel: ${channels.map((c) => `${c.label} ${money(c.spendCents)} spend, ${c.acquired} new customer(s)`).join("; ")}.`,
      evidenceIds: channels.map((c) => evidence.channelMetrics(b, metrics.period.key, c.channelCode)),
      status: "verified",
    });
  }
  // What the figures do not contain: records held or excluded at intake, customers the definition leaves out.
  for (const r of trace?.sourceRecords ?? []) {
    const cite = r.sampleEvidenceIds[0];
    observations.push(
      rendered(
        { text: `${r.count} ${r.source} record(s) at ${b} were ${r.status} at intake (${r.code}) and are not in these figures.`, evidenceIds: r.sampleEvidenceIds.slice(0, 5), status: "verified" },
        cite ? [field(r.count, "getMetricTrace", cite, `sourceRecords[source=${r.source}&status=${r.status}&code=${r.code}].count`)] : [],
      ),
    );
  }
  for (const e of trace?.excluded ?? []) {
    observations.push(
      rendered({ text: `${e.count} new customer(s) are left out of the CAC denominator by the definition (${e.code}).`, evidenceIds: e.evidenceIds.slice(0, 5), status: "verified" }, e.evidenceIds[0] ? [field(e.count, "getMetricTrace", e.evidenceIds[0], `excluded[code=${e.code}].count`)] : []),
    );
  }
  const missingInformation = [
    ...(d.asksCause ? ["Whether the spend caused these customers or this cash: attribution credits each customer to the channel of the first evidenced touch; only a controlled experiment measures what spend caused."] : []),
    ...failureNotes(ctx),
  ];
  return {
    summary: `${b}, ${label}: paid media spend ${money(metrics.paidSpendCents)}; ${metrics.acquired} new customers serviced (${metrics.paidAcquired} paid); paid-media CAC ${money(metrics.paidCacCents)}; collected cash ${money(metrics.collectedCents)}.${d.asksCause ? " These figures describe what was recorded; they do not show what caused it." : ""}`,
    observations,
    suspectedCause: null,
    confidence: trace && !trace.value.matches ? { level: "medium", why: "The paid figures do not reproduce exactly from the stored records (see the trace)." } : { level: "high", why: "Each figure is read from the scorecard and, for paid media, reproduced from the stored records." },
    recommendedNextAction: `Open ${b}'s metric trace to see the records behind each figure.`,
    expectedEffect: "None: nothing is proposed.",
    risks: d.asksCause ? ["Reading a channel's credited customers as caused by its spend would overstate it: attribution is an association."] : [],
    missingInformation,
    proposals: [],
  };
}

/** A brand's figures: every branch from one scorecard query, and the totals (refused unless the viewer sees the whole brand). */
async function brandRollupPlan(ctx: PlanContext, d: DetectedIntent, brandId: BrandId): Promise<DraftFindings> {
  const res = await ctx.call("getBrandMetrics", { brandId, period: d.period });
  if (!res) return nothingReadable(ctx, "The brand's figures could not be read.");
  const ids = res.branches.map((x) => x.branchId);
  const t = res.totals;
  const list = ids.length > 1 ? `${ids.slice(0, -1).join(", ")} and ${ids[ids.length - 1]}` : ids[0];
  const cited = ids.map((id) => evidence.branchMetrics(id, res.period.key));
  return {
    summary: `${res.brandName}, ${res.period.label}: ${t.acquired} new customers serviced across its ${ids.length} branches; paid-media CAC ${money(t.paidCacCents)} (summed paid spend ÷ summed paid customers, not an average of branch CACs).`,
    observations: [
      {
        text: `${res.brandName}, ${res.period.label}, totals over ${list}: ${t.acquired} new customers serviced; ${t.paidAcquired} new customers whose first evidenced touch was paid; paid media spend ${money(t.paidSpendCents)}; paid-media CAC ${money(t.paidCacCents)}; collected cash ${money(t.collectedCents)}.`,
        evidenceIds: cited,
        status: "verified",
      },
      { text: `${res.brandName}, ${res.period.label}, by branch: ${res.branches.map((x) => `${x.branchId} ${money(x.paidSpendCents)} spend, ${x.acquired} new customers`).join("; ")}.`, evidenceIds: cited, status: "verified" },
    ],
    suspectedCause: null,
    confidence: { level: "high", why: "Every branch of the brand comes from the same scorecard query; totals are sums, and CAC is recomputed from the summed parts." },
    recommendedNextAction: "Open a branch's metric trace to see the records behind its figures.",
    expectedEffect: "None: nothing is proposed.",
    risks: [],
    missingInformation: failureNotes(ctx),
    proposals: [],
  };
}

/** A prediction or a what-if: the records describe what happened, not what will. */
function forecastDraft(d: DetectedIntent): DraftFindings {
  return {
    ...emptyDraft(
      `This asks for a prediction${d.branchId ? ` about ${d.branchId}` : ""}. The records describe what happened in September and October; no tool forecasts, and attribution cannot estimate what a budget change would do.`,
    ),
    missingInformation: ["A forecast under a changed budget: it would take a controlled experiment (a holdout test), not the stored records, to estimate the effect of spending more or less."],
    recommendedNextAction: "Ask what the records show for the current period, or plan a holdout test before changing the budget.",
  };
}
