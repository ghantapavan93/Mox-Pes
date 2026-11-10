import { describe, expect, it } from "vitest";
import { PERIODS, parsePeriod } from "@/lib/period";

describe("parsePeriod", () => {
  it("returns the named period for a known key", () => {
    expect(parsePeriod("oct")).toBe(PERIODS.oct);
    expect(parsePeriod("sep")).toBe(PERIODS.sep);
    expect(parsePeriod("all")).toBe(PERIODS.all);
  });

  it("takes the first value of a repeated parameter", () => {
    expect(parsePeriod(["sep", "oct"])).toBe(PERIODS.sep);
  });

  it("falls back to October when the parameter is missing or unknown", () => {
    expect(parsePeriod(undefined)).toBe(PERIODS.oct);
    expect(parsePeriod("")).toBe(PERIODS.oct);
    expect(parsePeriod("nov")).toBe(PERIODS.oct);
    expect(parsePeriod([])).toBe(PERIODS.oct);
  });

  it.each(["toString", "constructor", "__proto__", "hasOwnProperty", "valueOf"])(
    "treats the inherited name %s as unknown, not as a period",
    (key) => {
      const period = parsePeriod(key);
      expect(period).toBe(PERIODS.oct);
      expect(period.from).toBeInstanceOf(Date);
      expect(period.key).toBe("oct");
    },
  );
});
