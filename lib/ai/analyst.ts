import type { Claim, DraftFindings, DroppedClaim, GroundingReport, Observation } from "./contract";
import { parseEvidenceId } from "./evidence";
import { metricFacts, statusFacts, type MetricFact, type StatusFacts } from "./facts";
import { checkNumbers, emptyFacts, mergeFacts, outputFacts, type Facts, type NumberCheck } from "./numbers";
import { citedFacts, judge, proveStatement, type Judgement, type Proof, type ProofOrigin } from "./proof";

/**
 * What the tools of this run actually said, per evidence id: the TYPED figures (money, percent,
 * count) in the output of every tool call that returned the id, all of them together (for text
 * that cites nothing, such as the summary), and the metric figures whose trace reports they do
 * not reproduce. Built from the recorded steps, never from the model's text.
 */
export interface EvidenceFacts {
  byId: ReadonlyMap<string, Facts>;
  all: Facts;
  /** branch_metrics ids whose trace in this run did not reproduce the scorecard. */
  conflicted: ReadonlySet<string>;
  /** What the metric tools said each metric IS, for which entity and period (lib/ai/facts.ts). */
  metrics: MetricFact[];
  /** Readiness and feed freshness from every tool call of the run. */
  status: StatusFacts;
}

export function evidenceFacts(steps: ReadonlyArray<{ kind: string; status: string; tool?: string | null; output: unknown; evidenceIds: string[] }>): EvidenceFacts {
  const byId = new Map<string, Facts>();
  const all = emptyFacts();
  const conflicted = new Set<string>();
  for (const s of steps) {
    if (s.kind !== "tool_call" || s.status !== "ok") continue;
    const facts = outputFacts(s.output);
    mergeFacts(all, facts);
    const value = (s.output as { value?: { matches?: unknown } } | null)?.value;
    for (const id of s.evidenceIds) {
      byId.set(id, mergeFacts(byId.get(id) ?? emptyFacts(), facts));
      // Only the metric itself is in conflict, not every record the trace listed.
      if (value && value.matches === false && id.startsWith("branch_metrics:")) conflicted.add(id);
    }
  }
  const typed = steps.map((s) => ({ ...s, tool: s.tool ?? null }));
  return { byId, all, conflicted, metrics: metricFacts(typed), status: statusFacts(typed) };
}

function factsFor(ids: string[], facts: EvidenceFacts): Facts {
  const out = emptyFacts();
  for (const id of ids) {
    const f = facts.byId.get(id);
    if (f) mergeFacts(out, f);
  }
  return out;
}

/** The figures in a claim that none of its cited tool outputs contains (all outputs when it cites nothing). */
function unsupportedFigures(text: string, ids: string[] | null, facts: EvidenceFacts | undefined): NumberCheck[] {
  if (!facts) return [];
  return checkNumbers(text, ids === null ? facts.all : factsFor(ids, facts)).filter((c) => !c.supported);
}

/**
 * The analyst stage: grounding and classification, the same for both investigators.
 *
 * Grounding rule (roadmap §6): every claim must cite evidence ids that a tool RETURNED IN THIS
 * RUN. A claim that cites nothing, or cites any id no tool returned (an invented record, a
 * typo, an id remembered from another run), is dropped and counted — never repaired, because
 * a claim whose evidence is wrong cannot be trusted for its other ids either.
 *
 * Classification: a "verified" claim must rest on at least one stored record; one that cites
 * only metric definitions is downgraded to a hypothesis (a formula proves nothing about the
 * data). Hypotheses without a stated strength are weak. The result groups into verified
 * findings, strong hypotheses, weak hypotheses and missing information.
 */

/** Evidence kinds that are not records: citing only these cannot verify a fact about the data. */
const NON_RECORD_KINDS = new Set(["metric_definition"]);

export interface Proved {
  proofs: Proof[];
  judgement: Judgement | null;
}

export interface GroundedDraft {
  draft: DraftFindings;
  report: GroundingReport;
  /** Who wrote the draft. */
  origin: ProofOrigin;
  /** The proofs of each kept observation and suspected cause, by text. */
  proved: ReadonlyMap<string, Proved>;
}

export interface GroundOptions {
  /** The deterministic investigator's templates, or the model's free text (lib/ai/proof.ts `judge`). */
  origin: ProofOrigin;
  /** The investigation's branch: the subject of a statement that names none. */
  branchId: string | null;
  /** Cited source records that a newer revision superseded: raw_event id → the newer one. */
  stale?: ReadonlyMap<string, string>;
}

/** Prescriptive wording: a recommendation, not an observation. */
const PRESCRIPTIVE = /\b(?:should|must|ought to|needs? to|recommend\w*|it is time to)\b/i;

/** A claim about a record's own history may cite an old revision; a claim about the business may not. */
const RECORD_HISTORY = /\b(?:quarantin\w*|held|excluded|supersed\w*|revisions?|replay\w*|earlier version|previous version|corrected|correction)\b/i;

function unsupportedIds(ids: string[], returned: ReadonlySet<string>): string[] {
  return ids.filter((id) => !returned.has(id));
}

/**
 * A claim that something CAUSED a business improvement (revenue, sales, bookings, conversions,
 * customers, profit, ROI). Only a measured experiment can support that, and no tool returns
 * experiment evidence, so such a claim is always dropped, whatever records it cites. Stating it
 * as a hypothesis ("may have") is allowed and stays a hypothesis.
 */
// Business OUTCOMES only. A bare "customers" or "paid customers" is a reporting count ("paid
// customers 3 → 5 in the preview", "0 customers attributed") and must stay; "new / more
// customers" is growth. "caused 53 customers to lose their lead" is a defect finding and stays.
const IMPACT = String.raw`(revenue|sales|profit|roi|bookings?|conversions?|(?:new|more|additional|extra)(?: \w+)? customers)`;
// Gaps of free text that may contain decimals ("12.5%") but do not cross a sentence end.
const GAP = (n: number) => String.raw`(?:[^.]|\.(?=\d)){0,${n}}`;
const CHANGE = String.raw`(change|remap|mapping|release|fix|correction|campaign|launch|update)`;
const CAUSAL_IMPACT = [
  new RegExp(String.raw`\b(increas|rais|boost|improv|lift|grew|grow|drove|generat|caus|add|brought in|deliver)\w*\b${GAP(80)}\b${IMPACT}\b`, "i"),
  new RegExp(String.raw`\b${IMPACT}\b${GAP(60)}\b(rose|increased|grew|improved|went up|jumped|doubled)\b${GAP(60)}\b(because|due to|thanks to|as a result|after the ${CHANGE})\b`, "i"),
  new RegExp(String.raw`\b(led to|resulted in|responsible for)\b${GAP(30)}\b(more|higher|additional|extra|increased?)\b${GAP(40)}\b${IMPACT}\b`, "i"),
  // Cost of acquisition claimed as lowered by something.
  new RegExp(String.raw`\b(cut|reduc|lower|halv|slash)\w*\b${GAP(20)}\b(cac|acquisition cost|cost per (customer|acquisition|lead))\b`, "i"),
  // "Starting the campaign caused B20's CAC to fall by $90.00" (held-out IV-35): a metric's move
  // attributed to an action.
  new RegExp(String.raw`\b(caus\w*|led to|resulted in|drove|made)\b${GAP(60)}\b(cac|acquisition cost|cost per (?:new )?(?:customer|acquisition)|spend|revenue|collections?|cash|customers?|sales)\b${GAP(30)}\b(fall|fell|drop\w*|rise|rose|increase\w*|decrease\w*|declin\w*|go(?:es)? (?:up|down)|jump\w*|grow|grew|improv\w*)\b`, "i"),
];
// Hedges, case-sensitive where a word is also a month ("May").
// Negations count too: "is not evidence it causes more customers" denies the claim.
const HEDGED = /\b(may (?:have|be|not|also)|might|could|possibly|hypothes\w*|unproven|not (?:yet )?measured|cannot (?:yet )?(?:say|show)|not (?:evidence|proof|proven|shown)|no evidence|does not (?:show|prove|mean)|without an experiment)\b/i;

export function isCausalImpactClaim(text: string): boolean {
  return CAUSAL_IMPACT.some((re) => re.test(text)) && !HEDGED.test(text);
}

export function groundDraft(draft: DraftFindings, returned: ReadonlySet<string>, facts?: EvidenceFacts, opts: GroundOptions = { origin: "template", branchId: null }): GroundedDraft {
  const dropped: DroppedClaim[] = [];
  let downgraded = 0;
  let numericDropped = 0;
  let proofDropped = 0;
  let proofDowngraded = 0;
  let staleDropped = 0;
  const figureReason = (bad: NumberCheck[]) => `states ${bad.map((b) => b.text).join(", ")}, which no tool output it cites contains; figures must come from the tools`;
  const proved = new Map<string, Proved>();
  // Proofs against the typed metric facts the claim cites (all of them for text that cites nothing).
  const prove = (text: string, ids: string[] | null): Proved => {
    if (!facts) return { proofs: [], judgement: null };
    const proofs = proveStatement(text, { branchId: opts.branchId, facts: ids === null ? facts.metrics : citedFacts(facts.metrics, ids), status: facts.status });
    return { proofs, judgement: judge(proofs, opts.origin) };
  };
  const proofReason = (j: Judgement) => `does not follow from the facts it cites: ${j.reason}`;
  /** A figure the proofs derive from cited facts (and nothing in the statement contradicts). */
  const derived = (p: Proved, figure: string) =>
    !p.proofs.some((x) => x.verdict === "CONTRADICTED") && p.proofs.some((x) => x.verdict === "VERIFIED" && x.figure.trim() === figure.trim());
  const staleOf = (text: string, ids: string[]) => {
    if (!opts.stale || RECORD_HISTORY.test(text)) return null;
    const old = ids.find((id) => opts.stale?.has(id) && !ids.includes(opts.stale.get(id) as string));
    return old ? { old, newer: opts.stale.get(old) as string } : null;
  };

  const observations: Observation[] = [];
  for (const o of draft.observations) {
    // Stated as fact or as hypothesis, an unhedged claim that something caused a business
    // outcome is dropped (a "strong hypothesis" is shown as a finding too; review S7).
    if (isCausalImpactClaim(o.text)) {
      dropped.push({ where: "observation", claimStatus: o.status, text: o.text, evidenceIds: o.evidenceIds, unsupported: [], reason: CAUSAL_REASON });
      continue;
    }
    const unsupported = unsupportedIds(o.evidenceIds, returned);
    if (o.evidenceIds.length === 0 || unsupported.length > 0) {
      dropped.push({
        where: "observation",
        claimStatus: o.status,
        text: o.text,
        evidenceIds: o.evidenceIds,
        unsupported,
        reason: o.evidenceIds.length === 0 ? "cites no evidence" : "cites evidence no tool returned in this run",
      });
      continue;
    }
    // Each figure (and stated direction) must FOLLOW from the facts cited: metric, entity,
    // period, sign, arithmetic, unit. Appearing in an output is not enough (lib/ai/proof.ts).
    const p = prove(o.text, o.evidenceIds);
    // A figure no cited output contains is dropped, unless its proof derives it from cited facts
    // (a difference, a share, a sum): then the proof is the evidence.
    const badFigures = unsupportedFigures(o.text, o.evidenceIds, facts).filter((b) => !derived(p, b.text));
    if (badFigures.length > 0) {
      numericDropped++;
      dropped.push({ where: "observation", claimStatus: o.status, text: o.text, evidenceIds: o.evidenceIds, unsupported: [], reason: figureReason(badFigures), ...(p.proofs.length ? { proofs: p.proofs } : {}) });
      continue;
    }
    // A claim about the business resting on a superseded revision of a source record.
    const stale = staleOf(o.text, o.evidenceIds);
    if (stale) {
      staleDropped++;
      dropped.push({ where: "observation", claimStatus: o.status, text: o.text, evidenceIds: o.evidenceIds, unsupported: [], reason: `cites ${stale.old}, a source record that a newer revision (${stale.newer}) superseded; a claim must rest on the current revision` });
      continue;
    }
    // A hypothesis may leave a figure unproved (it is shown as a hypothesis); it may not contradict its evidence.
    if (p.judgement?.status === "UNSUPPORTED" && (o.status === "verified" || p.proofs.some((x) => x.verdict === "CONTRADICTED"))) {
      proofDropped++;
      dropped.push({ where: "observation", claimStatus: o.status, text: o.text, evidenceIds: o.evidenceIds, unsupported: [], reason: proofReason(p.judgement), proofs: p.proofs });
      continue;
    }
    // What should be done is not a fact: a model's "verified" recommendation is shown as one.
    if (opts.origin === "model" && o.status === "verified" && PRESCRIPTIVE.test(o.text) && p.judgement?.status !== "PARTIALLY_SUPPORTED") {
      p.judgement = { status: "PARTIALLY_SUPPORTED", reason: "a recommendation stated as a finding: what should be done is not a fact the records establish", decisive: null };
    }
    proved.set(o.text, p);
    if (o.status === "verified" && p.judgement?.status === "PARTIALLY_SUPPORTED") {
      // Free text whose figure could not be proved is shown with that limitation, never as a finding.
      downgraded++;
      proofDowngraded++;
      observations.push({ text: o.text, evidenceIds: o.evidenceIds, status: "hypothesis", strength: "weak" });
      continue;
    }
    // A figure whose own trace does not reproduce is not a verified fact (review S6).
    if (o.status === "verified" && facts && o.evidenceIds.some((id) => facts.conflicted.has(id))) {
      downgraded++;
      observations.push({ text: o.text, evidenceIds: o.evidenceIds, status: "hypothesis", strength: "weak" });
      continue;
    }
    const recordBacked = o.evidenceIds.some((id) => !NON_RECORD_KINDS.has(parseEvidenceId(id)?.kind ?? ""));
    if (o.status === "verified" && !recordBacked) {
      downgraded++;
      observations.push({ text: o.text, evidenceIds: o.evidenceIds, status: "hypothesis", strength: "weak" });
      continue;
    }
    observations.push(o.status === "hypothesis" ? { ...o, strength: o.strength ?? "weak" } : { text: o.text, evidenceIds: o.evidenceIds, status: "verified" });
  }

  let suspectedCause = draft.suspectedCause;
  if (suspectedCause && isCausalImpactClaim(suspectedCause.text)) {
    dropped.push({ where: "suspectedCause", text: suspectedCause.text, evidenceIds: suspectedCause.evidenceIds, unsupported: [], reason: CAUSAL_REASON });
    suspectedCause = null;
  }
  if (suspectedCause) {
    const unsupported = unsupportedIds(suspectedCause.evidenceIds, returned);
    if (suspectedCause.evidenceIds.length === 0 || unsupported.length > 0) {
      dropped.push({
        where: "suspectedCause",
        text: suspectedCause.text,
        evidenceIds: suspectedCause.evidenceIds,
        unsupported,
        reason: suspectedCause.evidenceIds.length === 0 ? "cites no evidence" : "cites evidence no tool returned in this run",
      });
      suspectedCause = null;
    }
  }
  if (suspectedCause) {
    const badFigures = unsupportedFigures(suspectedCause.text, suspectedCause.evidenceIds, facts);
    if (badFigures.length > 0) {
      numericDropped++;
      dropped.push({ where: "suspectedCause", text: suspectedCause.text, evidenceIds: suspectedCause.evidenceIds, unsupported: [], reason: figureReason(badFigures) });
      suspectedCause = null;
    }
  }
  if (suspectedCause) {
    // A hypothesis may leave figures unproved, but may not contradict its own evidence.
    const p = prove(suspectedCause.text, suspectedCause.evidenceIds);
    if (p.proofs.some((x) => x.verdict === "CONTRADICTED") && p.judgement) {
      proofDropped++;
      dropped.push({ where: "suspectedCause", text: suspectedCause.text, evidenceIds: suspectedCause.evidenceIds, unsupported: [], reason: proofReason(p.judgement), proofs: p.proofs });
      suspectedCause = null;
    } else {
      proved.set(suspectedCause.text, p);
    }
  }

  const proposals = draft.proposals.filter((p) => {
    const ref = `exception:${p.exceptionId}`;
    if (returned.has(ref)) return true;
    dropped.push({ where: "proposal", text: `${p.kind} for exception ${p.exceptionId}`, evidenceIds: [ref], unsupported: [ref], reason: "the exception was not returned by a tool in this run" });
    return false;
  });

  // Text that cites nothing (summary, next step, expected effect, risks) is still shown, so it
  // gets the same two checks against everything the tools returned: no figure the tools did not
  // return, no unhedged claim of a caused business outcome. A failing field is WITHHELD with a
  // notice, never silently rewritten (review S5).
  const textDropped: DroppedClaim[] = [];
  const checkText = (where: "summary" | "recommendedNextAction" | "expectedEffect" | "risk", text: string | undefined): boolean => {
    if (text === undefined) return true;
    if (isCausalImpactClaim(text)) {
      textDropped.push({ where, text, evidenceIds: [], unsupported: [], reason: CAUSAL_REASON });
      return false;
    }
    const p = prove(text, null);
    const bad = unsupportedFigures(text, null, facts).filter((b) => !derived(p, b.text));
    if (bad.length > 0) {
      textDropped.push({ where, text, evidenceIds: [], unsupported: [], reason: `states ${bad.map((b) => b.text).join(", ")}, which no tool output in this run contains` });
      return false;
    }
    // The summary states facts: it must follow from them. The other fields look forward, so
    // only a contradiction of a current fact withholds them.
    const contradicted = p.proofs.some((x) => x.verdict === "CONTRADICTED");
    if (p.judgement && (contradicted || (where === "summary" && p.judgement.status === "UNSUPPORTED"))) {
      textDropped.push({ where, text, evidenceIds: [], unsupported: [], reason: proofReason(p.judgement), proofs: p.proofs });
      return false;
    }
    return true;
  };
  const summary = checkText("summary", draft.summary) ? draft.summary : "The investigator's summary stated a figure, a change or a cause that its evidence does not support, so it was withheld. The verified findings below stand on their own.";
  const recommendedNextAction = checkText("recommendedNextAction", draft.recommendedNextAction) ? draft.recommendedNextAction : "Withheld: the suggested next step stated a figure or a cause no tool supports. Review the verified findings.";
  const expectedEffect = checkText("expectedEffect", draft.expectedEffect) ? draft.expectedEffect : "Withheld: the expected effect stated a figure or a cause no tool supports.";
  const risks = (draft.risks ?? []).filter((r) => checkText("risk", r));

  // Confidence cannot outlive its evidence: no kept facts → low; a cause that was drafted but
  // failed grounding → at most medium. (A descriptive answer that never claimed a cause keeps
  // its confidence.)
  let confidence = draft.confidence;
  if (observations.filter((o) => o.status === "verified").length === 0 && confidence.level !== "low") {
    confidence = { level: "low", why: `${confidence.why} (Lowered: no verified finding survived grounding.)` };
  } else if (draft.suspectedCause && !suspectedCause && confidence.level === "high") {
    confidence = { level: "medium", why: `${confidence.why} (Lowered: the suspected cause cited unsupported evidence.)` };
  }

  const claimsIn = draft.observations.length + (draft.suspectedCause ? 1 : 0) + draft.proposals.length;
  const claimsDropped = dropped.length;
  return {
    draft: { ...draft, summary, observations, suspectedCause, proposals, confidence, recommendedNextAction, expectedEffect, risks },
    report: {
      returnedEvidence: returned.size,
      claimsIn,
      claimsKept: claimsIn - claimsDropped,
      claimsDropped,
      downgraded,
      ...(facts ? { numericDropped, proofDropped, proofDowngraded } : {}),
      ...(opts.stale ? { staleDropped } : {}),
      ...(textDropped.length ? { textWithheld: textDropped.length } : {}),
      dropped: [...dropped, ...textDropped],
    },
    origin: opts.origin,
    proved,
  };
}

const CAUSAL_REASON = "claims a business improvement was caused; only a measured experiment can show that, and none exists";

const DERIVED = /[÷=]|\breproduc|\bper (?:(?:new|paid) )*customer\b|\bCAC\b|\bshare\b|\bratio\b/i;

/**
 * Every statement of a grounded result, typed and with its support status (see ClaimSchema).
 * Kept observations are SUPPORTED (verified) or PARTIALLY_SUPPORTED (hypotheses); anything the
 * grounding dropped is UNSUPPORTED with its reason; a claim whose cited evidence reports it does
 * not reproduce is CONFLICTED; missing information is NOT_DETERMINABLE.
 */
export function buildClaims(grounded: GroundedDraft, facts: EvidenceFacts | undefined): Claim[] {
  const claims: Claim[] = [];
  const add = (c: Omit<Claim, "id">) => claims.push({ id: `c${claims.length + 1}`, ...c });
  const numbers = (text: string, ids: string[]) => (facts ? checkNumbers(text, factsFor(ids, facts)) : []);
  const conflicted = (ids: string[]) => facts !== undefined && ids.some((id) => facts.conflicted.has(id));
  const d = grounded.draft;

  const origin = grounded.origin;
  const proofsOf = (text: string) => {
    const p = grounded.proved.get(text);
    return p && p.proofs.length > 0 ? { proofs: p.proofs } : {};
  };
  const provedAll = (text: string) => {
    const p = grounded.proved.get(text);
    return p !== undefined && p.proofs.length > 0 && p.proofs.every((x) => x.verdict === "VERIFIED");
  };

  for (const o of d.observations) {
    const nums = numbers(o.text, o.evidenceIds);
    const judgement = grounded.proved.get(o.text)?.judgement ?? null;
    // A computed figure (a ratio, a share, a reproduction) is a derivation; a count or amount
    // read from a record is an observation, even though it contains a number.
    const factual: Claim["type"] = DERIVED.test(o.text) ? "DERIVATION" : "OBSERVATION";
    if (o.status === "verified") {
      const conflict = conflicted(o.evidenceIds);
      const n = grounded.proved.get(o.text)?.proofs.length ?? 0;
      add({
        type: factual,
        text: o.text,
        evidenceIds: o.evidenceIds,
        numbers: nums,
        status: conflict ? "CONFLICTED" : "SUPPORTED",
        reason: conflict
          ? "its evidence reports the number does not reproduce from the records"
          : provedAll(o.text)
            ? `cited records returned by tools in this run; ${n === 1 ? "its figure follows" : `all ${n} figures follow`} from the facts they cite (proofs attached)`
            : nums.length
              ? "cited records returned by tools in this run; every figure appears in their output"
              : "cited records returned by tools in this run",
        origin,
        ...proofsOf(o.text),
      });
    } else if (conflicted(o.evidenceIds)) {
      // A verified figure the analyst downgraded because its own trace does not reproduce.
      add({ type: factual, text: o.text, evidenceIds: o.evidenceIds, numbers: nums, status: "CONFLICTED", reason: "its metric's trace in this run does not reproduce the scorecard; shown as a hypothesis, not a finding", origin, ...proofsOf(o.text) });
    } else if (judgement?.status === "PARTIALLY_SUPPORTED") {
      // Stated as fact, but a figure could not be proved from what it cites: a limitation, not a finding.
      add({ type: factual, text: o.text, evidenceIds: o.evidenceIds, numbers: nums, status: "PARTIALLY_SUPPORTED", reason: `not proved, so shown as a hypothesis: ${judgement.reason}`, origin, ...proofsOf(o.text) });
    } else {
      add({ type: "HYPOTHESIS", text: o.text, evidenceIds: o.evidenceIds, numbers: nums, status: "PARTIALLY_SUPPORTED", reason: `consistent with the cited evidence (${o.strength ?? "weak"}), not proof`, origin, ...proofsOf(o.text) });
    }
  }
  if (d.suspectedCause) {
    add({ type: "HYPOTHESIS", text: d.suspectedCause.text, evidenceIds: d.suspectedCause.evidenceIds, numbers: numbers(d.suspectedCause.text, d.suspectedCause.evidenceIds), status: "PARTIALLY_SUPPORTED", reason: "the most likely explanation of the evidence; an investigation does not prove a cause", origin, ...proofsOf(d.suspectedCause.text) });
  }
  for (const x of grounded.report.dropped) {
    const type: Claim["type"] =
      x.reason === CAUSAL_REASON ? "CAUSAL"
      : x.where === "proposal" || x.where === "recommendedNextAction" ? "RECOMMENDATION"
      : x.where === "suspectedCause" || x.where === "expectedEffect" || x.claimStatus === "hypothesis" ? "HYPOTHESIS"
      : "OBSERVATION";
    add({
      type,
      text: x.text,
      evidenceIds: x.evidenceIds,
      // Which figure failed, so the reader sees it (empty for a claim dropped for its evidence ids).
      numbers: facts ? checkNumbers(x.text, x.evidenceIds.length ? factsFor(x.evidenceIds, facts) : facts.all) : [],
      status: "UNSUPPORTED",
      reason: x.where === "summary" || x.where === "recommendedNextAction" || x.where === "expectedEffect" ? `${x.reason} (withheld from the ${x.where === "summary" ? "summary" : x.where === "expectedEffect" ? "expected effect" : "next step"})` : x.reason,
      origin,
      ...(x.proofs?.length ? { proofs: x.proofs } : {}),
    });
  }
  add({ type: "RECOMMENDATION", text: d.recommendedNextAction, evidenceIds: [], numbers: [], status: "PARTIALLY_SUPPORTED", reason: "a suggested next step, not a fact; any change it leads to goes through dry run and approval" });
  for (const m of d.missingInformation) add({ type: "OBSERVATION", text: m, evidenceIds: [], numbers: [], status: "NOT_DETERMINABLE", reason: "the investigation could not establish this from the records it may read" });
  return claims;
}

/** Observations grouped the way the analyst reports them. */
export function classify(observations: Observation[]) {
  return {
    verified: observations.filter((o) => o.status === "verified"),
    strong: observations.filter((o) => o.status === "hypothesis" && o.strength === "strong"),
    weak: observations.filter((o) => o.status === "hypothesis" && o.strength !== "strong"),
  };
}
