import { describe, expect, it } from "vitest";
import { DraftFindingsSchema, InvestigationResultSchema, MODE_LABEL } from "@/lib/ai/contract";
import { EvidenceIdSchema, evidence, numericEvidenceId, parseEvidenceId } from "@/lib/ai/evidence";

/** The output contract and the evidence id format. */

const result = {
  mode: "deterministic",
  modeLabel: MODE_LABEL.deterministic,
  intent: "coverage_gap",
  summary: "Local Services spend is filed as Search.",
  observations: [{ text: "gap", evidenceIds: ["exception:2455"], status: "verified" }],
  suspectedCause: { text: "ads@1.0", evidenceIds: ["campaign:8677"] },
  confidence: { level: "high", why: "reproduced" },
  recommendedNextAction: "dry run",
  expectedEffect: "spend moves",
  risks: [],
  missingInformation: [],
  approvalRequired: true,
  proposals: [
    { exceptionId: 2455, kind: "remap_channel", params: { mapperVersion: "1.1" }, rationale: "r", status: "created", reason: "ok", proposalId: 1, caseId: 161 },
  ],
  refusal: null,
  grounding: { returnedEvidence: 48, claimsIn: 2, claimsKept: 2, claimsDropped: 0, downgraded: 0, dropped: [] },
  warnings: [],
};

const draft = {
  summary: result.summary,
  observations: result.observations,
  suspectedCause: result.suspectedCause,
  confidence: result.confidence,
  recommendedNextAction: result.recommendedNextAction,
  expectedEffect: result.expectedEffect,
  risks: [],
  missingInformation: [],
  proposals: [{ exceptionId: 2455, kind: "remap_channel", params: { mapperVersion: "1.1" }, rationale: "a rationale of length" }],
};

describe("output contract", () => {
  it("accepts a complete result and labels the deterministic mode honestly", () => {
    expect(InvestigationResultSchema.safeParse(result).success).toBe(true);
    expect(MODE_LABEL.deterministic).toBe("Deterministic investigator — no model configured");
  });

  it("rejects unknown fields, bad statuses, unknown proposal kinds and malformed evidence ids", () => {
    expect(InvestigationResultSchema.safeParse({ ...result, extra: 1 }).success).toBe(false);
    expect(InvestigationResultSchema.safeParse({ ...result, observations: [{ text: "x", evidenceIds: [], status: "certain" }] }).success).toBe(false);
    expect(InvestigationResultSchema.safeParse({ ...result, proposals: [{ ...result.proposals[0], kind: "delete_everything" }] }).success).toBe(false);
    expect(InvestigationResultSchema.safeParse({ ...result, observations: [{ text: "x", evidenceIds: ["DROP TABLE"], status: "verified" }] }).success).toBe(false);
    expect(InvestigationResultSchema.safeParse({ ...result, observations: [{ text: "x", evidenceIds: ["secret:1"], status: "verified" }] }).success).toBe(false);
    expect(InvestigationResultSchema.safeParse({ ...result, confidence: { level: "certain", why: "x" } }).success).toBe(false);
  });

  it("the draft a model submits must carry every section", () => {
    expect(DraftFindingsSchema.safeParse(draft).success).toBe(true);
    expect(DraftFindingsSchema.safeParse({ ...draft, recommendedNextAction: undefined }).success).toBe(false);
    expect(DraftFindingsSchema.safeParse({ ...draft, proposals: [{ ...draft.proposals[0], rationale: "short" }] }).success).toBe(false);
    expect(DraftFindingsSchema.safeParse({ ...draft, proposals: [{ ...draft.proposals[0], kind: "drop_table" }] }).success).toBe(false);
  });
});

describe("evidence ids", () => {
  it("formats and parses stable ids", () => {
    expect(evidence.exception(2455)).toBe("exception:2455");
    expect(evidence.channelMetrics("B09", "oct", "google_lsa")).toBe("channel_metrics:B09:oct:google_lsa");
    expect(parseEvidenceId("channel_metrics:B09:oct:google_lsa")).toEqual({ kind: "channel_metrics", key: "B09:oct:google_lsa", parts: ["B09", "oct", "google_lsa"] });
    expect(numericEvidenceId("raw_event:156389", "raw_event")).toBe(156389);
    expect(numericEvidenceId("raw_event:156389", "exception")).toBeNull();
    expect(parseEvidenceId("unknown:1")).toBeNull();
    expect(parseEvidenceId("exception:1; drop table x")).toBeNull();
    expect(EvidenceIdSchema.safeParse("customer:415347").success).toBe(true);
    expect(EvidenceIdSchema.safeParse("customer:").success).toBe(false);
  });
});
