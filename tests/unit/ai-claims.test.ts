import { describe, expect, it } from "vitest";
import { buildClaims, evidenceFacts, groundDraft } from "@/lib/ai/analyst";
import type { DraftFindings } from "@/lib/ai/contract";

/**
 * The claim check beyond observations (independent AI/security review, 2026-11-12): free text
 * that cites nothing, a figure whose trace does not reproduce, and a causal claim stated as a
 * hypothesis. Facts come from recorded tool steps, exactly as runInvestigation builds them.
 */
const steps = (matches: boolean) => [
  {
    kind: "tool_call",
    status: "ok",
    evidenceIds: ["branch_metrics:B09:oct", "exception:77"],
    output: { value: { matches, reproduced: { paidSpendCents: 1664923, paidAcquired: 69, paidCacCents: 24129 } }, exceptions: [{ records: 31 }] },
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
    const g = groundDraft(
      draft({
        observations: [
          { text: "Paid CAC at B09 is $241.29.", evidenceIds: ["branch_metrics:B09:oct"], status: "verified" },
          { text: "31 records are quarantined at B09.", evidenceIds: ["exception:77"], status: "verified" },
        ],
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
