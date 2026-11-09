import { describe, expect, it } from "vitest";
import { MODE_LABEL } from "@/lib/ai/contract";
import { EVAL_CASES, scoreCase, skippedScore, summarize, type Fixture } from "@/lib/ai/eval";
import type { InvestigationStep } from "@/lib/ai/steps";

/** The evaluation dataset's shape and the deterministic scorer, on hand-built outcomes. */

const fixture: Fixture = {
  gapId: 2455,
  gapBranch: "B09",
  successorCampaignId: 8677,
  successorRawEventIds: ["raw_event:1", "raw_event:2"],
  quarantineId: 1063,
  quarantineBranch: "B20",
  customerWithoutLead: 5,
  paidCustomer: { id: 6, creditedLeadId: 7 },
  refundCustomer: { id: 8, refundPaymentIds: ["payment:9"] },
  mismatchBranch: "B07",
  mismatchExceptionIds: ["exception:10"],
  conflictBranch: "B12",
  conflictExceptionIds: ["exception:11"],
  redeliveredRawEventIds: ["raw_event:12"],
  lastSuccessRunIds: ["ingestion_run:13"],
};

const golden = EVAL_CASES.find((c) => c.id === "golden-b09-misclassified-campaign")!;

const step = (tool: string): InvestigationStep => ({
  seq: 1, stage: "investigator", kind: "tool_call", tool, input: {}, outputSummary: "", output: null, evidenceIds: [], status: "ok", error: null, ms: 1, at: "",
});

function goodResult() {
  return {
    mode: "deterministic",
    modeLabel: MODE_LABEL.deterministic,
    intent: "coverage_gap",
    summary: "Local Services spend since the gap is stored under Search.",
    observations: [{ text: "gap", evidenceIds: ["exception:2455", "campaign:8677", "raw_event:2"], status: "verified" }],
    suspectedCause: null,
    confidence: { level: "high", why: "x" },
    recommendedNextAction: "dry run",
    expectedEffect: "moves",
    risks: [],
    missingInformation: [],
    approvalRequired: true,
    proposals: [{ exceptionId: 2455, kind: "remap_channel", params: {}, rationale: "r", status: "created", reason: "ok", proposalId: 1, caseId: 2 }],
    refusal: null,
    grounding: { returnedEvidence: 3, claimsIn: 2, claimsKept: 2, claimsDropped: 0, downgraded: 0, dropped: [] },
    warnings: [],
  };
}

const goldenSteps = () => golden.expectedTools.map(step);

describe("evaluation dataset", () => {
  it("has at least 12 cases covering every required category, with unique ids", () => {
    expect(EVAL_CASES.length).toBeGreaterThanOrEqual(12);
    expect(new Set(EVAL_CASES.map((c) => c.id)).size).toBe(EVAL_CASES.length);
    const categories = new Set(EVAL_CASES.map((c) => c.category));
    for (const required of [
      "missing lead mapping / quarantine",
      "duplicate events",
      "wrong-branch",
      "misclassified campaign",
      "unmatched customer",
      "stale sync",
      "refund reconciliation",
      "conflicting acquisition channel",
      "no evidence available",
      "misleading question",
      "unauthorized action request",
      "prompt injection in a record",
    ]) {
      expect(categories.has(required), required).toBe(true);
    }
    expect(EVAL_CASES.filter((c) => c.expectRefusal).length).toBeGreaterThan(0);
  });
});

describe("scoreCase", () => {
  it("passes an outcome that meets every expectation", () => {
    const s = scoreCase(golden, "q", fixture, { steps: goldenSteps(), result: goodResult(), latencyMs: 10, costMicros: 0 });
    expect(s.failures).toEqual([]);
    expect(s).toMatchObject({ pass: true, toolPrecision: 1, toolRecall: 1, evidenceRecall: 1, groundingRate: 1, schemaValid: true });
  });

  it("catches missing tools, extra tools, missing evidence and dropped claims", () => {
    const r = goodResult();
    r.observations[0].evidenceIds = ["exception:2455"];
    r.grounding = { ...r.grounding, claimsIn: 4, claimsKept: 2, claimsDropped: 2 };
    const steps = [...goldenSteps().slice(1), step("getAuditHistory")];
    const s = scoreCase(golden, "q", fixture, { steps, result: r, latencyMs: 10, costMicros: 0 });
    expect(s.pass).toBe(false);
    expect(s.toolRecall).toBeCloseTo(6 / 7);
    expect(s.toolPrecision).toBeCloseTo(6 / 7);
    expect(s.evidenceRecall).toBeCloseTo(1 / 3);
    expect(s.groundingRate).toBe(0.5);
    expect(s.unsupportedClaims).toBe(2);
    expect(s.failures.join(" ")).toMatch(/missing tools: getReconciliationExceptions/);
    expect(s.failures.join(" ")).toMatch(/not cited: campaign:8677, a raw spend record/);
  });

  it("catches forbidden claims, wrong refusals, wrong proposals and an invalid contract", () => {
    const r = goodResult();
    r.summary = "Local Services is cheaper, so move budget to it.";
    r.proposals = [];
    r.refusal = { reason: "no" } as never;
    const s = scoreCase(golden, "q", fixture, { steps: goldenSteps(), result: r, latencyMs: 10, costMicros: 0 });
    expect(s.forbiddenHits).toBe(2);
    expect(s.refusalCorrect).toBe(false);
    expect(s.proposalsCorrect).toBe(false);
    const invalid = scoreCase(golden, "q", fixture, { steps: goldenSteps(), result: { summary: "only" }, latencyMs: 1, costMicros: 0 });
    expect(invalid.schemaValid).toBe(false);
    expect(invalid.pass).toBe(false);
  });

  it("checks no-findings and warning expectations", () => {
    const noEvidence = EVAL_CASES.find((c) => c.id === "no-evidence")!;
    const s = scoreCase(noEvidence, "q", fixture, { steps: [step("getReconciliationExceptions")], result: { ...goodResult(), proposals: [] }, latencyMs: 1, costMicros: 0 });
    expect(s.failures).toContain("returned findings where none were expected");
    const injection = EVAL_CASES.find((c) => c.id === "prompt-injection-in-record")!;
    const t = scoreCase(injection, "q", fixture, { steps: [step("getCustomerJourney")], result: { ...goodResult(), proposals: [] }, latencyMs: 1, costMicros: 0 });
    expect(t.failures).toContain("no injection warning raised");
  });
});

describe("summarize", () => {
  it("averages scored cases, counts skipped ones apart, and reports latency percentiles and cost", () => {
    const pass = scoreCase(golden, "q", fixture, { steps: goldenSteps(), result: goodResult(), latencyMs: 100, costMicros: 2500 });
    const fail = scoreCase(golden, "q", fixture, { steps: [], result: goodResult(), latencyMs: 300, costMicros: 500 });
    const summary = summarize([pass, fail, skippedScore(golden, "fixture missing")]);
    expect(summary).toMatchObject({ cases: 3, scored: 2, skipped: 1, passed: 1, toolRecall: 0.5, costMicros: 3000, schemaValidity: 1 });
    expect(summary.latencyMs).toEqual({ p50: 100, p95: 300, max: 300 });
  });
});
