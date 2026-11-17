import { describe, expect, it } from "vitest";
import { brandNamed } from "@/lib/ai/deterministic";
import { branchesNamedIn } from "@/lib/shadow/answer";
import { BRANDS, branchesOfBrands } from "@/lib/reference";

/**
 * Book gap N30: a real company's brand names were shown beside synthetic numbers. The brands are
 * fictional now; their former names are recognised in typed text only, so questions and answers
 * written with them still resolve to the same brand.
 */
describe("brands are fictional, and still recognised by any name", () => {
  it("shows no real brand name", () => {
    for (const b of BRANDS) expect(b.name).not.toMatch(/moxie|joshua|mission/i);
    expect(BRANDS.map((b) => b.name)).toEqual(["Desert Range Pest", "Copper Mesa Pest", "Bluepine Pest"]);
  });

  it("reads a question naming a brand by its display name or a former one", () => {
    expect(brandNamed("What did Copper Mesa spend in October?")).toBe("joshuas");
    expect(brandNamed("Compare Desert Range's paid CAC with September")).toBe("moxie");
    expect(brandNamed("How is the Bluepine brand doing?")).toBe("mission");
    expect(brandNamed("What did Joshua's spend in October?")).toBe("joshuas");
    // A proper noun only: "our mission" is not a brand.
    expect(brandNamed("What is our mission for October?")).toBeNull();
  });

  it("reads an answer naming a brand as every branch of that brand", () => {
    const joshuas = branchesOfBrands(["joshuas"]);
    expect(branchesNamedIn("Copper Mesa Pest spent $50,900 in October.")).toEqual(expect.arrayContaining(joshuas));
    expect(branchesNamedIn("Copper Mesa's branches spent $50,900.")).toEqual(expect.arrayContaining(joshuas));
    expect(branchesNamedIn("Joshua's Pest Control spent $50,900 in October.")).toEqual(expect.arrayContaining(joshuas));
  });
});
