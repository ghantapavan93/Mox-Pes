import { describe, expect, it } from "vitest";
import { failureText } from "@/lib/workflow/failure";
import type { Verification } from "@/lib/workflow/snapshot";

/** Panel audit Q6: a failed dry run showed raw database text, and was marked as a success. */
describe("failureText", () => {
  const verification = (problems: string[]): Verification => ({ ok: problems.length === 0, expectedExceptionStatus: ["resolved"], exceptionStatus: "open", conservation: [], problems });

  it("shows an authored verification failure as written", () => {
    expect(failureText("Dry run did not verify", verification(["Total ad spend changed from 123431864 to 123431865"]))).toBe(
      "Dry run did not verify: Total ad spend changed from 123431864 to 123431865",
    );
  });

  it("replaces an unexpected error's raw text with one plain sentence", () => {
    const text = failureText("Execution failed and was rolled back", verification([]));
    expect(text).toContain("nothing was changed");
    expect(text).not.toMatch(/relation|constraint|violates/);
    expect(failureText("Did not verify", null)).toContain("an unexpected error stopped it");
  });
});
