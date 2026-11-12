import { describe, expect, it } from "vitest";
import { buildClaims, evidenceFacts, groundDraft, isCausalImpactClaim, isModelCausalClaim } from "@/lib/ai/analyst";
import type { DraftFindings } from "@/lib/ai/contract";
import { rendered } from "@/lib/ai/rendered";

/**
 * The claim check beyond observations (independent AI/security review, 2026-11-12): free text
 * that cites nothing, a figure whose trace does not reproduce, and a causal claim stated as a
 * hypothesis. Facts come from recorded tool steps, exactly as runInvestigation builds them.
 */
const steps = (matches: boolean) => [
  {
    kind: "tool_call",
    status: "ok",
    tool: "getReconciliationExceptions",
    evidenceIds: ["branch_metrics:B09:oct", "exception:77"],
    output: { value: { matches, reproduced: { paidSpendCents: 1664923, paidAcquired: 69, paidCacCents: 24129 } }, exceptions: [{ id: 77, records: 31 }] },
  },
];

const draft = (over: Partial<DraftFindings>): DraftFindings => ({
  summary: "B09's paid CAC is $241.29.",
  observations: [],
  suspectedCause: null,
  confidence: { level: "medium", why: "test" },
  recommendedNextAction: "Review the mapping.",
  expectedEffect: "None until reviewed.",
  risks: [],
  missingInformation: [],
  proposals: [],
  ...over,
});

describe("claim check beyond observations", () => {
  it("withholds a summary, next step, effect or risk that states a figure no tool returned (S5)", () => {
    const facts = evidenceFacts(steps(true));
    const g = groundDraft(
      draft({
        summary: "B09's paid CAC is $310.00.",
        recommendedNextAction: "Cut B09 spend by $9,999 now.",
        expectedEffect: "+120 new customers and $50,000 of revenue.",
        risks: ["Spend may be misfiled.", "A $77,777 swing is coming."],
      }),
      new Set(["branch_metrics:B09:oct", "exception:77"]),
      facts,
    );
    expect(g.draft.summary).toMatch(/withheld/);
    expect(g.draft.recommendedNextAction).toMatch(/^Withheld/);
    expect(g.draft.expectedEffect).toMatch(/^Withheld/);
    expect(g.draft.risks).toEqual(["Spend may be misfiled."]);
    expect(g.report.textWithheld).toBe(4);
    const claims = buildClaims(g, facts);
    expect(claims.filter((c) => c.status === "UNSUPPORTED").map((c) => c.type)).toEqual(["OBSERVATION", "RECOMMENDATION", "HYPOTHESIS", "OBSERVATION"]);
    expect(claims.find((c) => c.text.includes("$310.00"))?.numbers).toEqual([{ text: "$310.00", kind: "money", supported: false }]);
  });

  it("keeps a true summary, and a figure the tools returned", () => {
    const facts = evidenceFacts(steps(true));
    const g = groundDraft(draft({}), new Set(["branch_metrics:B09:oct"]), facts);
    expect(g.draft.summary).toBe("B09's paid CAC is $241.29.");
    expect(g.report.textWithheld).toBeUndefined();
  });

  it("a figure whose own trace does not reproduce is CONFLICTED and not shown as verified; other records stay (S6)", () => {
    const facts = evidenceFacts(steps(false));
    // The record count is certified by the field it renders (R-38), as the product's template declares it.
    const quarantined = rendered({ text: "31 records are quarantined at B09.", evidenceIds: ["exception:77"], status: "verified" as const }, [{ figure: "31", tool: "getReconciliationExceptions", evidenceId: "exception:77", path: "exceptions[id=77].records" }]);
    const g = groundDraft(
      draft({
        observations: [{ text: "Paid CAC at B09 is $241.29.", evidenceIds: ["branch_metrics:B09:oct"], status: "verified" }, quarantined],
      }),
      new Set(["branch_metrics:B09:oct", "exception:77"]),
      facts,
    );
    expect(g.draft.observations.map((o) => o.status)).toEqual(["hypothesis", "verified"]);
    const claims = buildClaims(g, facts);
    expect(claims.find((c) => c.text.startsWith("Paid CAC"))?.status).toBe("CONFLICTED");
    expect(claims.find((c) => c.text.startsWith("31 records"))?.status).toBe("SUPPORTED");
  });

  it("drops a causal claim stated as a hypothesis, and keeps its type (S7)", () => {
    const facts = evidenceFacts(steps(true));
    const g = groundDraft(
      draft({ observations: [{ text: "The remap drove more new customers and higher revenue at B09.", evidenceIds: ["branch_metrics:B09:oct"], status: "hypothesis", strength: "strong" }] }),
      new Set(["branch_metrics:B09:oct"]),
      facts,
    );
    expect(g.draft.observations).toEqual([]);
    expect(buildClaims(g, facts).find((c) => c.text.startsWith("The remap"))).toMatchObject({ type: "CAUSAL", status: "UNSUPPORTED" });
  });

  it("a negated causal sentence is not a causal claim", () => {
    const g = groundDraft(draft({ risks: ["A cheaper channel after the fix is not evidence it causes more customers."] }), new Set(), evidenceFacts([]));
    expect(g.draft.risks).toHaveLength(1);
  });
});

/** The AI-claims review of 2026-11-12, at the level of the claim check (lib/ai/analyst.ts). */
describe("the AI-claims review, 2026-11-12: causes, revisions and forecasts", () => {
  const metricSteps = [
    {
      kind: "tool_call",
      status: "ok",
      tool: "getBranchMetrics",
      evidenceIds: ["branch_metrics:B09:oct"],
      output: { branchId: "B09", branchName: "B09", period: { key: "oct", label: "oct" }, paidSpendCents: 482580, acquired: 25, paidAcquired: 20, unknownAcquired: 3, paidCacCents: 24129, unknownShare: 0.12, collectedCents: 10000000, refundsCents: 50000, atRiskCents: 125000, channels: [] },
    },
    { kind: "tool_call", status: "ok", tool: "getSourceLineage", evidenceIds: ["raw_event:100", "raw_event:101"], output: {} },
  ];
  const returned = new Set(["branch_metrics:B09:oct", "raw_event:100", "raw_event:101"]);
  const model = { origin: "model" as const, branchId: "B09" };

  it("12 · a hedge qualifies only its own sentence, and model findings are held to a wider causal net", () => {
    expect(isCausalImpactClaim("The Local Services remap increased B12's revenue by $10,000 from September; no evidence of fraud was found.")).toBe(true);
    expect(isCausalImpactClaim("The Local Services remap may have increased B12's revenue.")).toBe(false);
    for (const t of [
      "Thanks to the remap, B12's collections rose by $10,000 from September.",
      "B09's October revenue fell by $20,000 from September because the Meta campaign was paused.",
      "The Google Search campaign brought in 20 paid customers at B09 in October.",
      "B09's $4,825.80 of October paid spend returned $100,000 in cash.",
    ]) expect(isModelCausalClaim(t), t).toBe(true);
    // The product's own data-quality explanation is not a causal business claim, nor is the
    // model's when no metric moves (held-out IV-33).
    expect(isCausalImpactClaim("31 calls records at B20 are quarantined; 4 new customer(s) have no lead record because of it.")).toBe(false);
    expect(isModelCausalClaim("B07's budget signal is not trustworthy yet, because a campaign mapped to no branch produced Google Search customers that B07 serviced.")).toBe(false);
    const facts = evidenceFacts(metricSteps);
    const g = groundDraft(draft({ observations: [{ text: "The Google Search campaign brought in 20 paid customers at B09 in October.", evidenceIds: ["branch_metrics:B09:oct"], status: "verified" }] }), returned, facts, model);
    expect(g.draft.observations).toEqual([]);
    expect(buildClaims(g, facts).find((c) => c.text.startsWith("The Google Search"))).toMatchObject({ type: "CAUSAL", status: "UNSUPPORTED" });
  });

  it("14 · a business figure resting on a superseded revision is dropped, whatever words surround it", () => {
    const facts = evidenceFacts(metricSteps);
    const stale = new Map([["raw_event:100", "raw_event:101"]]);
    const g = groundDraft(
      draft({ observations: [{ text: "B09's October paid CAC, after the correction, is $241.29.", evidenceIds: ["branch_metrics:B09:oct", "raw_event:100"], status: "verified" }] }),
      returned,
      facts,
      { ...model, stale },
    );
    expect(g.draft.observations).toEqual([]);
    expect(g.report.staleDropped).toBe(1);
    // A claim about the record's own history may still cite the old revision.
    const h = groundDraft(draft({ observations: [{ text: "Raw event 100 was superseded by a corrected revision.", evidenceIds: ["raw_event:100"], status: "verified" }] }), returned, facts, { ...model, stale });
    expect(h.report.staleDropped).toBe(0);
  });

  it("17 · a forecast after a wrong figure does not get the summary shown", () => {
    const g = groundDraft(draft({ summary: "B09's October paid CAC was $4,825.80, which will need review." }), returned, evidenceFacts(metricSteps), model);
    expect(g.draft.summary).toMatch(/withheld/);
  });

  it("the model is never the only verifier: a finding with nothing to prove is a hypothesis", () => {
    const g = groundDraft(draft({ observations: [{ text: "The mapping for this campaign was changed by marketing.", evidenceIds: ["raw_event:101"], status: "verified" }] }), returned, evidenceFacts(metricSteps), model);
    expect(g.draft.observations.map((o) => o.status)).toEqual(["hypothesis"]);
  });
});
