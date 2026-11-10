import { describe, expect, it } from "vitest";
import { subjectFilter } from "@/lib/workflow/queries";

/** Audit 2026-11-09 (J6): "case:1" used to match case:10 … case:199 by prefix. */
describe("audit subject filter", () => {
  it("an id-bearing subject matches exactly", () => {
    expect(subjectFilter("case:1")).toEqual({ exact: "case:1", prefix: null });
    expect(subjectFilter("investigation:42")).toEqual({ exact: "investigation:42", prefix: null });
  });

  it("a bare type, with or without the colon, matches every subject of that type", () => {
    expect(subjectFilter("case")).toEqual({ exact: null, prefix: "case%" });
    expect(subjectFilter("case:")).toEqual({ exact: null, prefix: "case:%" });
  });

  it("LIKE metacharacters in a prefix are escaped, not treated as wildcards", () => {
    expect(subjectFilter("a_b%")).toEqual({ exact: null, prefix: String.raw`a\_b\%%` });
  });

  it("no subject means no filter", () => {
    expect(subjectFilter(undefined)).toEqual({ exact: null, prefix: null });
  });
});
