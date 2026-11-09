import { describe, expect, it } from "vitest";
import {
  canonicalJson,
  hashEmail,
  hashPhone,
  instantToWallTime,
  microsToCents,
  normalizePhone,
  parseMoneyToCents,
  payloadHash,
  wallTimeToInstant,
} from "@/lib/primitives";

describe("money is parsed exactly, never through floats", () => {
  it.each([
    ["149.00", 14900],
    ["149.1", 14910],
    ["0.07", 7],
    ["-25.50", -2550],
    ["1000000", 100_000_000],
  ])("%s → %d cents", (input, cents) => expect(parseMoneyToCents(input)).toBe(cents));

  it("rejects ambiguous amounts", () => {
    for (const bad of ["1,000.00", "12.345", "$5", "", "1e3"]) expect(() => parseMoneyToCents(bad)).toThrow();
  });

  it("sums of parsed amounts have no float drift", () => {
    const total = Array.from({ length: 1000 }, () => parseMoneyToCents("0.10")).reduce((a, b) => a + b, 0);
    expect(total).toBe(10_000);
  });

  it("converts Google Ads micros half-up", () => {
    expect(microsToCents("1234560000")).toBe(123456);
    expect(microsToCents("5000")).toBe(1); // 0.5 cent rounds up
    expect(microsToCents("4999")).toBe(0);
  });
});

describe("identity normalisation: one person, one hash, whatever the source format", () => {
  const formats = ["(212) 555-0142", "212-555-0142", "+12125550142", "2125550142", "1 212 555 0142"];
  it("normalises every US phone format to E.164", () => {
    for (const f of formats) expect(normalizePhone(f)).toBe("+12125550142");
  });
  it("hashes every format to the same key", () => {
    expect(new Set(formats.map(hashPhone)).size).toBe(1);
  });
  it("refuses non-dialable numbers instead of guessing", () => {
    expect(normalizePhone("555-0142")).toBeNull();
    expect(normalizePhone("+44 20 7946 0958")).toBeNull();
  });
  it("normalises email case and whitespace", () => {
    expect(hashEmail("  Person1@Example.COM ")).toBe(hashEmail("person1@example.com"));
  });
});

const instant_wall = (d: Date) => instantToWallTime(d, "America/Chicago");

describe("zone-less CRM timestamps are interpreted at the branch", () => {
  it("Phoenix has no DST: 10:00 local is 17:00Z in summer and winter", () => {
    expect(wallTimeToInstant("2026-07-01 10:00:00", "America/Phoenix").toISOString()).toBe("2026-07-01T17:00:00.000Z");
    expect(wallTimeToInstant("2026-12-01 10:00:00", "America/Phoenix").toISOString()).toBe("2026-12-01T17:00:00.000Z");
  });
  it("Chicago shifts with DST", () => {
    expect(wallTimeToInstant("2026-07-01 10:00:00", "America/Chicago").toISOString()).toBe("2026-07-01T15:00:00.000Z");
    expect(wallTimeToInstant("2026-12-01 10:00:00", "America/Chicago").toISOString()).toBe("2026-12-01T16:00:00.000Z");
  });
  it("round-trips outside the repeated hour", () => {
    for (const iso of ["2026-11-01T05:30:00Z", "2026-11-01T08:30:00Z", "2026-03-08T09:30:00Z"]) {
      const instant = new Date(iso);
      expect(wallTimeToInstant(instant_wall(instant), "America/Chicago").getTime()).toBe(instant.getTime());
    }
  });
  it("the fall-back hour is ambiguous in a zone-less format; it resolves to the earlier instant, deterministically", () => {
    // 2026-11-01 01:30 happens twice in Chicago (CDT, then CST). The CRM format cannot say which.
    const first = new Date("2026-11-01T06:30:00Z");
    const second = new Date("2026-11-01T07:30:00Z");
    expect(instant_wall(first)).toBe(instant_wall(second));
    expect(wallTimeToInstant("2026-11-01 01:30:00", "America/Chicago").toISOString()).toBe(first.toISOString());
  });
  it("rejects ISO strings where the CRM format is required", () => {
    expect(() => wallTimeToInstant("2026-10-01T10:00:00Z", "America/Chicago")).toThrow();
  });
});

describe("payload hashing ignores key order", () => {
  it("equal payloads hash equally", () => {
    expect(payloadHash({ a: 1, b: { c: 2, d: [1, 2] } })).toBe(payloadHash({ b: { d: [1, 2], c: 2 }, a: 1 }));
    expect(canonicalJson({ b: 1, a: undefined })).toBe('{"b":1}');
  });
  it("different payloads hash differently", () => {
    expect(payloadHash({ total: "149.00" })).not.toBe(payloadHash({ total: "174.00" }));
  });
});
