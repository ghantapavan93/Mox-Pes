import { describe, expect, it } from "vitest";
import { wallWindow } from "@/lib/connectors/fieldroutes-client";
import { instantToWallTime } from "@/lib/primitives";

/**
 * Audit 2026-11-09 (G-4): FieldRoutes filters on zone-less wall time. Across the autumn clock
 * change, consecutive sync windows with a 30-minute overlap could both miss a record.
 */
const CHICAGO = "America/Chicago";
const between = (wall: string, [lo, hi]: [string, string]) => wall >= lo && wall <= hi;
const at = (iso: string) => new Date(iso);

describe("FieldRoutes wall-time windows", () => {
  it("a record in the repeated hour is read by one of two overlapping windows (Chicago, 2026-11-01)", () => {
    const w1 = wallWindow(at("2026-11-01T05:50:00Z"), at("2026-11-01T07:20:00Z"), CHICAGO);
    const w2 = wallWindow(at("2026-11-01T06:50:00Z"), at("2026-11-01T08:20:00Z"), CHICAGO); // checkpoint 07:20Z − 30 min
    const record = instantToWallTime(at("2026-11-01T06:40:00Z"), CHICAGO);
    expect(record).toBe("2026-11-01 01:40:00");
    expect(between(record, w1) || between(record, w2)).toBe(true);
  });

  it("every minute of the transition day is inside some window of an hourly sync with a 30-minute overlap", () => {
    const start = at("2026-10-31T22:00:00Z").getTime();
    const windows: Array<[string, string]> = [];
    for (let k = 0; k < 12; k++) windows.push(wallWindow(new Date(start + k * 3_600_000 - 30 * 60_000), new Date(start + (k + 1) * 3_600_000), CHICAGO));
    for (let t = start; t < start + 11 * 3_600_000; t += 60_000) {
      const wall = instantToWallTime(new Date(t), CHICAGO);
      expect(windows.some((w) => between(wall, w)), wall).toBe(true);
    }
  });

  it("a window with no clock change is unchanged", () => {
    const from = at("2026-10-15T15:00:00Z");
    const to = at("2026-10-15T16:00:00Z");
    expect(wallWindow(from, to, CHICAGO)).toEqual([instantToWallTime(from, CHICAGO), instantToWallTime(to, CHICAGO)]);
  });
});
