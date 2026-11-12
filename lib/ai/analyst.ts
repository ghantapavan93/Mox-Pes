import type { Claim, DraftFindings, DroppedClaim, GroundingReport, Observation } from "./contract";
import { parseEvidenceId } from "./evidence";
import { checkNumbers, outputNumbers, type NumberCheck } from "./numbers";

/**
 * What the tools of this run actually said, per evidence id: the numbers in the output of every
 * tool call that returned the id, and ids whose output reports it does not reproduce (a metric
 * trace with a discrepancy). Built from the recorded steps, never from the model's text.
 */
export interface EvidenceFacts {
  numbersById: ReadonlyMap<string, ReadonlySet<number>>;
  conflicted: ReadonlySet<string>;
}

export function evidenceFacts(steps: ReadonlyArray<{ kind: string; status: string; output: unknown; evidenceIds: string[] }>): EvidenceFacts {
  const numbersById = new Map<string, Set<number>>();
  const conflicted = new Set<string>();
  for (const s of steps) {
    if (s.kind !== "tool_call" || s.status !== "ok") continue;
    const numbers = outputNumbers(s.output);
    const value = (s.output as { value?: { matches?: unknown } } | null)?.value;
    for (const id of s.evidenceIds) {
      const set = numbersById.get(id) ?? new Set<number>();
      for (const n of numbers) set.add(n);
      numbersById.set(id, set);
      if (value && value.matches === false) conflicted.add(id);
    }
  }
  return { numbersById, conflicted };
}

function factsFor(ids: string[], facts: EvidenceFacts): Set<number> {
  const out = new Set<number>();
  for (const id of ids) for (const n of facts.numbersById.get(id) ?? []) out.add(n);
  return out;
}

/** The figures in a claim that none of its cited tool outputs contains. */
function unsupportedFigures(text: string, ids: string[], facts: EvidenceFacts | undefined): NumberCheck[] {
  if (!facts) return [];
  return checkNumbers(text, factsFor(ids, facts)).filter((c) => !c.supported);
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

export interface GroundedDraft {
  draft: DraftFindings;
  report: GroundingReport;
}

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
];
// Hedges, case-sensitive where a word is also a month ("May").
const HEDGED = /\b(may (?:have|be|not|also)|might|could|possibly|hypothes\w*|unproven|not (?:yet )?measured|cannot (?:yet )?say)\b/i;

export function isCausalImpactClaim(text: string): boolean {
  return CAUSAL_IMPACT.some((re) => re.test(text)) && !HEDGED.test(text);
}

export function groundDraft(draft: DraftFindings, returned: ReadonlySet<string>, facts?: EvidenceFacts): GroundedDraft {
  const dropped: DroppedClaim[] = [];
  let downgraded = 0;
  let numericDropped = 0;
  const figureReason = (bad: NumberCheck[]) => `states ${bad.map((b) => b.text).join(", ")}, which no tool output it cites contains; figures must come from the tools`;

  const observations: Observation[] = [];
  for (const o of draft.observations) {
    if (o.status === "verified" && isCausalImpactClaim(o.text)) {
      dropped.push({ where: "observation", text: o.text, evidenceIds: o.evidenceIds, unsupported: [], reason: "claims a business improvement was caused; only a measured experiment can show that, and none exists" });
      continue;
    }
    const unsupported = unsupportedIds(o.evidenceIds, returned);
    if (o.evidenceIds.length === 0 || unsupported.length > 0) {
      dropped.push({
        where: "observation",
        text: o.text,
        evidenceIds: o.evidenceIds,
        unsupported,
        reason: o.evidenceIds.length === 0 ? "cites no evidence" : "cites evidence no tool returned in this run",
      });
      continue;
    }
    const badFigures = unsupportedFigures(o.text, o.evidenceIds, facts);
    if (badFigures.length > 0) {
      numericDropped++;
      dropped.push({ where: "observation", text: o.text, evidenceIds: o.evidenceIds, unsupported: [], reason: figureReason(badFigures) });
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
    dropped.push({ where: "suspectedCause", text: suspectedCause.text, evidenceIds: suspectedCause.evidenceIds, unsupported: [], reason: "claims a business improvement was caused; only a measured experiment can show that, and none exists" });
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

  const proposals = draft.proposals.filter((p) => {
    const ref = `exception:${p.exceptionId}`;
    if (returned.has(ref)) return true;
    dropped.push({ where: "proposal", text: `${p.kind} for exception ${p.exceptionId}`, evidenceIds: [ref], unsupported: [ref], reason: "the exception was not returned by a tool in this run" });
    return false;
  });

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
    draft: { ...draft, observations, suspectedCause, proposals, confidence },
    report: {
      returnedEvidence: returned.size,
      claimsIn,
      claimsKept: claimsIn - claimsDropped,
      claimsDropped,
      downgraded,
      ...(facts ? { numericDropped } : {}),
      dropped,
    },
  };
}

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

  for (const o of d.observations) {
    const nums = numbers(o.text, o.evidenceIds);
    if (o.status === "verified") {
      const conflict = conflicted(o.evidenceIds);
      add({
        // A computed figure (a ratio, a share, a reproduction) is a derivation; a count or amount
        // read from a record is an observation, even though it contains a number.
        type: DERIVED.test(o.text) ? "DERIVATION" : "OBSERVATION",
        text: o.text,
        evidenceIds: o.evidenceIds,
        numbers: nums,
        status: conflict ? "CONFLICTED" : "SUPPORTED",
        reason: conflict ? "its evidence reports the number does not reproduce from the records" : nums.length ? "cited records returned by tools in this run; every figure appears in their output" : "cited records returned by tools in this run",
      });
    } else {
      add({ type: "HYPOTHESIS", text: o.text, evidenceIds: o.evidenceIds, numbers: nums, status: "PARTIALLY_SUPPORTED", reason: `consistent with the cited evidence (${o.strength ?? "weak"}), not proof` });
    }
  }
  if (d.suspectedCause) {
    add({ type: "HYPOTHESIS", text: d.suspectedCause.text, evidenceIds: d.suspectedCause.evidenceIds, numbers: numbers(d.suspectedCause.text, d.suspectedCause.evidenceIds), status: "PARTIALLY_SUPPORTED", reason: "the most likely explanation of the evidence; an investigation does not prove a cause" });
  }
  for (const x of grounded.report.dropped) {
    add({
      type: x.reason.startsWith("claims a business improvement") ? "CAUSAL" : x.where === "proposal" ? "RECOMMENDATION" : "OBSERVATION",
      text: x.text,
      evidenceIds: x.evidenceIds,
      numbers: [],
      status: "UNSUPPORTED",
      reason: x.reason,
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
