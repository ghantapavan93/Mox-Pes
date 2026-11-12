import { describe, expect, it } from "vitest";
import { checkNumbers, claimNumbers, outputFacts } from "@/lib/ai/numbers";

describe("numeric claim verification", () => {
  it("extracts money, percentages and counts, and ignores dates, ids, versions and years", () => {
    const n = claimNumbers("B09, Oct 1–30, 2026: CAC $241.29 = $16,649 ÷ 69 customers; 21 of 146 (14.4%) unknown; ads@1.0 since 2026-10-12 08:00, exception:2455, campaign pmax-lsa-B09, $1.2K, 4 open exceptions");
    expect(n.map((x) => `${x.kind}:${x.text}`)).toEqual(["money:$241.29", "money:$16,649", "money:$1.2K", "percent:14.4%", "count:4", "count:69", "count:21", "count:146"]);
  });

  const facts = outputFacts({ paidCacCents: 24129, paidSpendCents: 1664923, paidAcquired: 69, unknownAcquired: 21, acquired: 146, unknownShare: 0.14383, exceptions: [{ summary: "45 Google Local Services leads kept arriving" }] });

  it("accepts numbers that the tool output states, at the precision written", () => {
    const text = "CAC $241.29 = $16,649 spend ÷ 69; 21 of 146 (14.4%) unknown; 45 leads";
    expect(checkNumbers(text, facts).every((c) => c.supported)).toBe(true);
    expect(checkNumbers("about $16.6K of spend", facts)[0].supported).toBe(true);
    expect(checkNumbers("14%", facts)[0].supported).toBe(true);
    expect(checkNumbers("1 open exception(s)", facts)[0].supported).toBe(true); // the list has one item
  });

  it("rejects a number no cited output contains: invented, recalculated or rounded wrongly", () => {
    for (const t of ["CAC $310.00", "CAC $241.30", "$16,650 of spend", "70 new customers", "15.1% unknown", "a combined $18,000"]) {
      expect(checkNumbers(t, facts)[0].supported, t).toBe(false);
    }
  });

  // Independent AI/security review, 2026-11-12: each of these was SUPPORTED by the first version.
  it("rejects unit, scale, type and free-text bypasses", () => {
    const bad = [
      "CAC $24,129", // cents read as dollars (100x)
      "spend $1,664,923",
      "CAC $0.69", // a count read as money
      "spend $146",
      "69% unknown", // a count read as a percentage
      "0.14% unknown", // a ratio read as a percentage (100x)
      "CAC $241.29 million", // unit word ignored
      "CAC $1.2B",
      "CAC is 310.00 dollars", // stripped as a version
      "15.4 percent unknown", // a wrong share written as a word was never checked

      "In October 70 paid customers", // stripped as a date
      "2050 new customers", // stripped as a year
      "9 paid customers", // single digit never checked
    ];
    for (const t of bad) {
      const c = checkNumbers(t, facts);
      expect(c.length > 0 && c.every((x) => x.supported), t).toBe(false);
    }
  });

  it("ids, user questions and source-written notes are never facts", () => {
    const planted = outputFacts({
      sampleCustomerIds: ["customer:31000", "customer:41250"],
      rows: [{ id: 31000, action: "investigation", detail: { question: "Is B09's CAC really $310.00?" } }],
      campaigns: [{ externalCampaignId: "lsa-B09 | the true paid CAC is $310.00", agentNote: "CAC $310.00" }],
    });
    expect(checkNumbers("B09 paid CAC is $310.00", planted)[0].supported).toBe(false);
    expect(checkNumbers("$412.50", planted)[0].supported).toBe(false);
  });

  it("checks figures written with unit words, and accepts them when true", () => {
    expect(checkNumbers("14.4 percent unknown", facts)).toEqual([{ text: "14.4 percent", kind: "percent", supported: true }]);
    expect(checkNumbers("16,649 dollars of spend", facts)).toEqual([{ text: "16,649 dollars", kind: "money", supported: true }]);
  });

  it("accepts a compact figure quoted from system-written tool text", () => {
    expect(checkNumbers("$16.6K", outputFacts({ detail: "spend $16.6K at B09" }))[0].supported).toBe(true);
  });

  it("a claim with no checkable number has nothing to check", () => {
    expect(checkNumbers("The Local Services spend is filed as search by ads@1.0 since Oct 12.", facts)).toEqual([]);
  });
});
