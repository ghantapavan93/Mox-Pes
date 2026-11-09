import { describe, expect, it } from "vitest";
import { classify, groundDraft } from "@/lib/ai/analyst";
import type { DraftFindings } from "@/lib/ai/contract";

/** The grounding validator: claims must cite evidence a tool returned in this run. */

const draft = (over: Partial<DraftFindings> = {}): DraftFindings => ({
  summary: "s",
  observations: [],
  suspectedCause: null,
  confidence: { level: "high", why: "because" },
  recommendedNextAction: "n",
  expectedEffect: "e",
  risks: [],
  missingInformation: [],
  proposals: [],
  ...over,
});

const returned = new Set(["exception:2455", "campaign:8677", "raw_event:156250", "metric_definition:paidCac", "channel_metrics:B09:oct:google_lsa"]);

describe("groundDraft", () => {
  it("keeps claims whose every evidence id was returned", () => {
    const { draft: out, report } = groundDraft(
      draft({
        observations: [{ text: "gap", evidenceIds: ["exception:2455", "campaign:8677"], status: "verified" }],
        suspectedCause: { text: "ads@1.0", evidenceIds: ["raw_event:156250"] },
      }),
      returned,
    );
    expect(out.observations).toHaveLength(1);
    expect(out.suspectedCause?.text).toBe("ads@1.0");
    expect(report).toMatchObject({ claimsIn: 2, claimsKept: 2, claimsDropped: 0, returnedEvidence: 5 });
    expect(out.confidence.level).toBe("high");
  });

  it("drops a claim citing an id no tool returned, even when its other ids are real", () => {
    const { draft: out, report } = groundDraft(
      draft({
        observations: [
          { text: "real", evidenceIds: ["exception:2455"], status: "verified" },
          { text: "half invented", evidenceIds: ["exception:2455", "raw_event:999"], status: "verified" },
          { text: "no evidence at all", evidenceIds: [], status: "hypothesis", strength: "strong" },
        ],
      }),
      returned,
    );
    expect(out.observations.map((o) => o.text)).toEqual(["real"]);
    expect(report.claimsDropped).toBe(2);
    expect(report.dropped[0]).toMatchObject({ where: "observation", unsupported: ["raw_event:999"], reason: "cites evidence no tool returned in this run" });
    expect(report.dropped[1]).toMatchObject({ reason: "cites no evidence" });
  });

  it("drops an ungrounded cause and lowers high confidence; drops proposals for exceptions not returned", () => {
    const { draft: out, report } = groundDraft(
      draft({
        observations: [{ text: "real", evidenceIds: ["exception:2455"], status: "verified" }],
        suspectedCause: { text: "made up", evidenceIds: ["exception:1"] },
        proposals: [
          { exceptionId: 2455, kind: "remap_channel", params: { mapperVersion: "1.1" }, rationale: "grounded rationale" },
          { exceptionId: 77, kind: "replay_quarantine", params: { mapperVersion: "1.1" }, rationale: "ungrounded rationale" },
        ],
      }),
      returned,
    );
    expect(out.suspectedCause).toBeNull();
    expect(out.confidence.level).toBe("medium");
    expect(out.proposals.map((p) => p.exceptionId)).toEqual([2455]);
    expect(report.dropped.map((d) => d.where)).toEqual(["suspectedCause", "proposal"]);
    expect(report).toMatchObject({ claimsIn: 4, claimsKept: 2, claimsDropped: 2 });
  });

  it("a descriptive answer without a cause keeps its confidence; no verified finding means low", () => {
    const kept = groundDraft(draft({ observations: [{ text: "fact", evidenceIds: ["campaign:8677"], status: "verified" }] }), returned);
    expect(kept.draft.confidence.level).toBe("high");
    const empty = groundDraft(draft({ observations: [{ text: "x", evidenceIds: ["lead:1"], status: "verified" }] }), returned);
    expect(empty.draft.confidence.level).toBe("low");
    expect(empty.draft.confidence.why).toMatch(/no verified finding/);
  });

  it("downgrades a 'verified' claim that cites only metric definitions, and defaults hypotheses to weak", () => {
    const { draft: out, report } = groundDraft(
      draft({
        observations: [
          { text: "definition only", evidenceIds: ["metric_definition:paidCac"], status: "verified" },
          { text: "unrated hypothesis", evidenceIds: ["channel_metrics:B09:oct:google_lsa"], status: "hypothesis" },
          { text: "fact", evidenceIds: ["exception:2455"], status: "verified" },
        ],
      }),
      returned,
    );
    expect(out.observations[0]).toMatchObject({ status: "hypothesis", strength: "weak" });
    expect(out.observations[1]).toMatchObject({ status: "hypothesis", strength: "weak" });
    expect(report.downgraded).toBe(1);
    const groups = classify(out.observations);
    expect(groups.verified.map((o) => o.text)).toEqual(["fact"]);
    expect(groups.weak).toHaveLength(2);
    expect(groups.strong).toHaveLength(0);
  });
});
