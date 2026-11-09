import { ACTIVE_VERSION, mapperVersions } from "@/lib/adapters/registry";
import type { SourceName } from "@/lib/adapters/contract";
import { FRESHNESS_MAX_AGE_HOURS } from "@/lib/decision/verdicts";
import type { PeriodKey } from "@/lib/period";
import { formatCents } from "@/lib/primitives";
import { BRANCH_BY_ID, CHANNEL_BY_CODE, type ChannelCode } from "@/lib/reference";
import type { Viewer } from "@/lib/viewer";
import type { DraftFindings, Observation, ProposalSuggestion } from "./contract";
import { evidence, uniqueIds } from "./evidence";
import type { ToolData, ToolInput, ToolName } from "./tools";

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
  | "no_evidence";

export interface DetectedIntent {
  intent: Intent;
  branchId: string | null;
  customerId: number | null;
  exceptionId: number | null;
  period: PeriodKey;
  /** The question asks the AI path to act (approve, execute, delete…), not to investigate. */
  actionRequest: boolean;
  /** The question presumes spend stopped or dropped. */
  presumesStop: boolean;
}

const ACTION_REQUEST = [
  /^\s*(please\s+)?(approve|execute|apply|delete|drop|purge|merge|force|bypass|skip|reject|close)\b/i,
  /\b(approve|execute|apply)\b[^.?!]{0,40}\b(proposals?|fix|re-?map|replay|it|them|now|change)\b/i,
  /\b(without|skip|bypass|no)\b[^.?!]{0,20}\b(approval|dry[- ]run|review)\b/i,
  /\b(delete|drop|purge|truncate)\b[^.?!]{0,30}\b(records?|events?|exceptions?|tables?|rows?|customers?)\b/i,
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

export function detectIntent(question: string, viewer: Viewer, requestedBranch: string | null): DetectedIntent {
  const branchMatch = /\bB(\d{2})\b/.exec(question);
  const branchId = branchMatch ? `B${branchMatch[1]}` : requestedBranch ?? (viewer.branchIds?.length === 1 ? viewer.branchIds[0] : null);
  const exceptionMatch = /\b(?:exception|incident|case)\s*#?\s*(\d{1,12})\b/i.exec(question);
  const customerMatch = /\bcustomer\s*#?\s*(\d{4,12})\b/i.exec(question);
  const period: PeriodKey = /\bseptember\b|\bsep\b/i.test(question) ? (/\boctober\b|\boct\b/i.test(question) ? "all" : "sep") : "oct";
  const actionRequest = ACTION_REQUEST.some((re) => re.test(question));
  const presumesStop = /\b(stop(ped)?|drop(ped)?|cut|paused?|went to zero)\b/i.test(question);
  let intent: Intent = "no_evidence";
  if (exceptionMatch) intent = "exception";
  else if (customerMatch) intent = "customer_lookup";
  else intent = TOPICS.find((t) => t.re.test(question))?.intent ?? "no_evidence";
  return {
    intent,
    branchId: branchId && BRANCH_BY_ID.has(branchId) ? branchId : null,
    customerId: customerMatch ? Number(customerMatch[1]) : null,
    exceptionId: exceptionMatch ? Number(exceptionMatch[1]) : null,
    period,
    actionRequest,
    presumesStop,
  };
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
      text: `${b}, ${metrics.period.label}: paid-media CAC ${money(metrics.paidCacCents)} = ${money(metrics.paidSpendCents)} paid spend ÷ ${metrics.paidAcquired} new customers whose first evidenced touch was paid; ${metrics.unknownAcquired} of ${metrics.acquired} new customers (${pct(metrics.unknownShare)}) have channel unknown.`,
      evidenceIds: [bm],
      status: "verified",
    },
  ];
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
    observations.push({
      text: `${ev.records} ${src} record(s) at ${b} are quarantined (${ev.errorCode}: ${ev.sampleError}) from ${day(ev.firstOccurredAt)} to ${day(ev.lastOccurredAt)}; ${ev.customersWithoutLead} new customer(s) have no lead record because of it.`,
      evidenceIds: [qId, ...samples],
      status: "verified",
    });
    const group = ing?.quarantineGroups.find((g) => g.exceptionId === quarantine.id);
    const stored = group?.adapterVersions.map(versionOf) ?? [];
    const fromVersion = stored.find((v) => v !== ACTIVE_VERSION[src]) ?? stored[0];
    const cmp = fromVersion ? await ctx.call("compareMappingVersions", { source: src, fromVersion, toVersion: ACTIVE_VERSION[src], exceptionId: quarantine.id }) : null;
    if (cmp) {
      observations.push({
        text: `Re-running ${src}@${cmp.fromVersion} and ${src}@${cmp.toVersion} over the ${cmp.records} held record(s), read-only: ${cmp.outcomes.nowProjects} would now project, ${cmp.outcomes.stillFails} would still fail.`,
        evidenceIds: uniqueIds([qId, ...cmp.samples.nowProjects.slice(0, 5).map(evidence.rawEvent)]),
        status: "verified",
      });
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
      text: `A channel coverage gap is also open at ${b}: ${gap.summary}`,
      evidenceIds: [evidence.exception(gap.id)],
      status: "verified",
    });
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
    observations.push({
      text: `${g.records} ${g.source} record(s)${g.branchId ? ` at ${g.branchId}` : ""} are quarantined with ${g.errorCode} (${g.sampleError ?? "no detail"}), first ${day(g.firstOccurredAt)}, last ${day(g.lastOccurredAt)}, refused by ${g.adapterVersions.join(", ")}.`,
      evidenceIds: ids,
      status: "verified",
    });
  }
  const top = groups[0];
  const src = top.source as SourceName;
  const sample = top.sampleRawEventIds[0];
  if (sample) await ctx.call("getSourceLineage", { rawEventId: sample });
  const fromVersion = top.adapterVersions.map(versionOf).find((v) => v !== ACTIVE_VERSION[src]) ?? versionOf(top.adapterVersions[0]);
  const cmp = top.exceptionId ? await ctx.call("compareMappingVersions", { source: src, fromVersion, toVersion: ACTIVE_VERSION[src], exceptionId: top.exceptionId }) : null;
  if (cmp && top.exceptionId) {
    observations.push({
      text: `Read-only comparison: ${src}@${cmp.toVersion} (deployed) maps ${cmp.outcomes.nowProjects} of the ${cmp.records} held record(s) that ${src}@${cmp.fromVersion} refused; ${cmp.outcomes.stillFails} still fail.`,
      evidenceIds: uniqueIds([evidence.exception(top.exceptionId), ...cmp.samples.nowProjects.slice(0, 5).map(evidence.rawEvent)]),
      status: "verified",
    });
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
    observations.push({
      text: `${x.source}: ${x.recordsRedelivered} stored record version(s) were delivered more than once (${x.duplicateDeliveries} extra deliveries); each version is stored once, keyed by source and external id${x.storedEvents === null ? "" : `, so ${x.storedEvents} events are counted, not ${x.storedEvents + x.duplicateDeliveries}`}.`,
      evidenceIds: x.sampleRawEventIds.map(evidence.rawEvent),
      status: "verified",
    });
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
      observations.push({
        text: `That lead's raw record (raw event ${lineage.rawEvent.id}) was received ${day(lineage.rawEvent.receivedAt)}, mapped by ${lineage.rawEvent.adapterVersion}, delivered ${lineage.rawEvent.deliveryCount} time(s); ${lineage.versions.length} stored version(s).`,
        evidenceIds: [evidence.rawEvent(lineage.rawEvent.id)],
        status: "verified",
      });
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
    observations.push({
      text: `${j.leads.length} lead record(s) are linked by exact phone/email hash: ${Object.entries(bySource).map(([s, n]) => `${n} ${s}`).join(", ")}; channels ${[...new Set(j.leads.map((l) => channelLabel(l.channelCode)))].join(", ")}.`,
      evidenceIds: j.leads.slice(0, 5).map((l) => evidence.lead(l.id)),
      status: "verified",
    });
  }
  observations.push({
    text: `Money: ${money(j.money.collectedCents)} collected = ${money(j.money.paymentsCents)} successful payments − ${money(j.money.refundsCents)} refunds; ${money(j.money.invoicedCents)} invoiced; ${money(j.money.failedOrVoidedCents)} failed or voided (never counted).`,
    evidenceIds: uniqueIds([cust, ...j.payments.slice(0, 5).map((p) => evidence.payment(p.id))]),
    status: "verified",
  });
  const exceptions = j.flags.openExceptions;
  if (exceptions.length > 0) {
    const first = await ctx.call("getReconciliationExceptions", { exceptionId: exceptions[0].id });
    observations.push({
      text: `${exceptions.length} open exception(s) touch this customer: ${exceptions.map((e) => `${e.kind} ${e.id}`).join(", ")}${first ? ` — ${first.exceptions[0].summary}` : ""}.`,
      evidenceIds: exceptions.map((e) => evidence.exception(e.id)),
      status: "verified",
    });
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
    observations.push({ text: `${j.flags.pendingConflicts} identity match(es) for this customer wait for a reviewer.`, evidenceIds: [cust], status: "verified" });
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
  const observations: Observation[] = [...pairs.values()].slice(0, 4).map((p) => ({
    text: `${p.ids.length} lead(s) captured for ${p.lead} belong to customers serviced by ${p.crm}${p.territory ? ` (the territory table also says ${p.territory})` : ""}.`,
    evidenceIds: p.ids.slice(0, 5).map(evidence.exception),
    status: "verified" as const,
  }));
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
  const count = list.counts.find((c) => c.kind === "channel_conflict")?.open ?? rows.length;
  const top = rows[0];
  const ev = top.evidence as Record<string, unknown>;
  const journey = ev.customerId ? await ctx.call("getCustomerJourney", { customerId: Number(ev.customerId) }) : null;
  await ctx.call("getMetricDefinition", { key: "acquired" });
  const observations: Observation[] = [
    {
      text: `${count} open conflict(s)${d.branchId ? ` at ${d.branchId}` : " in scope"}: a paid touch reached the customer first, then a door-to-door rep signed the sale; credit follows the first evidenced touch.`,
      evidenceIds: rows.slice(0, 5).map((e) => evidence.exception(e.id)),
      status: "verified",
    },
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
    observations.push({
      text: `${s.stream}: last successful run ${s.lastSuccessRunId} at ${when(s.lastSuccessAt)} (${s.hoursSinceSuccess ?? "?"} h before the business clock; stale after ${FRESHNESS_MAX_AGE_HOURS} h); last run ${s.lastRunStatus ?? "none"}.`,
      evidenceIds: [evidence.ingestionRun(s.lastSuccessRunId)],
      status: "verified",
    });
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
