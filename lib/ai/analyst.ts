import type { DraftFindings, DroppedClaim, GroundingReport, Observation } from "./contract";
import { parseEvidenceId } from "./evidence";

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

export function groundDraft(draft: DraftFindings, returned: ReadonlySet<string>): GroundedDraft {
  const dropped: DroppedClaim[] = [];
  let downgraded = 0;

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
      dropped,
    },
  };
}

/** Observations grouped the way the analyst reports them. */
export function classify(observations: Observation[]) {
  return {
    verified: observations.filter((o) => o.status === "verified"),
    strong: observations.filter((o) => o.status === "hypothesis" && o.strength === "strong"),
    weak: observations.filter((o) => o.status === "hypothesis" && o.strength !== "strong"),
  };
}
