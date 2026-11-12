import { describe, expect, it } from "vitest";
import { checkNumbers, claimNumbers, outputNumbers } from "@/lib/ai/numbers";

describe("numeric claim verification", () => {
  it("extracts money, percentages and counts, and ignores dates, ids, versions and years", () => {
    const n = claimNumbers("B09, Oct 1–30, 2026: CAC $241.29 = $16,649 ÷ 69 customers; 21 of 146 (14.4%) unknown; ads@1.0 since 2026-10-12 08:00, exception:2455, campaign pmax-lsa-B09, $1.2K");
    expect(n.map((x) => `${x.kind}:${x.text}`)).toEqual(["money:$241.29", "money:$16,649", "money:$1.2K", "percent:14.4%", "count:69", "count:21", "count:146"]);
  });

  const facts = outputNumbers({ paidCacCents: 24129, paidSpendCents: 1664923, paidAcquired: 69, unknownAcquired: 21, acquired: 146, unknownShare: 0.14383, note: "45 Google Local Services leads kept arriving" });

  it("accepts numbers that the tool output states, at the precision written", () => {
    const text = "CAC $241.29 = $16,649 spend ÷ 69; 21 of 146 (14.4%) unknown; 45 leads";
    expect(checkNumbers(text, facts).every((c) => c.supported)).toBe(true);
    expect(checkNumbers("about $16.6K of spend", facts)[0].supported).toBe(true);
    expect(checkNumbers("14%", facts)[0].supported).toBe(true);
  });

  it("rejects a number no cited output contains: invented, recalculated or rounded wrongly", () => {
    expect(checkNumbers("CAC $310.00", facts)[0].supported).toBe(false); // invented
    expect(checkNumbers("CAC $241.30", facts)[0].supported).toBe(false); // wrong at the stated precision
    expect(checkNumbers("$16,650 of spend", facts)[0].supported).toBe(false); // rounded wrongly
    expect(checkNumbers("70 new customers", facts)[0].supported).toBe(false);
    expect(checkNumbers("15.1% unknown", facts)[0].supported).toBe(false);
    expect(checkNumbers("a combined $18,000", facts)[0].supported).toBe(false); // a sum the model did itself
  });

  it("a claim with no checkable number has nothing to check", () => {
    expect(checkNumbers("The Local Services spend is filed as search by ads@1.0 since Oct 12.", facts)).toEqual([]);
  });
});
