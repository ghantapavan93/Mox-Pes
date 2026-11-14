import { describe, expect, it } from "vitest";
import { explainCell, takeaway, weekLabel } from "@/lib/metrics/movement-copy";
import { cellStatus, parseChannel, parseWeek, windowWeeks, type Cell, type Movement } from "@/lib/metrics/movement";
import { PERIODS } from "@/lib/period";

/** The "What changed" panel's rules without a database (lib/metrics/movement.ts, movement-copy.ts). */

describe("weeks and what a week's records support", () => {
  it("covers Sep 1 – Oct 30 in Monday weeks, partial at both ends, the period marked", () => {
    const w = windowWeeks(PERIODS.oct, "2026-10-30");
    expect(w.map((x) => [x.start, x.days, x.delivered, x.inPeriod])).toEqual([
      ["2026-08-31", 6, 6, false],
      ["2026-09-07", 7, 7, false],
      ["2026-09-14", 7, 7, false],
      ["2026-09-21", 7, 7, false],
      ["2026-09-28", 7, 7, true],
      ["2026-10-05", 7, 7, true],
      ["2026-10-12", 7, 7, true],
      ["2026-10-19", 7, 7, true],
      ["2026-10-26", 5, 5, true],
    ]);
    // A feed that has delivered only through Oct 20: later days are unknown, not missing.
    const late = windowWeeks(PERIODS.oct, "2026-10-20");
    expect(late.find((x) => x.start === "2026-10-19")!.delivered).toBe(2);
    expect(late.find((x) => x.start === "2026-10-26")!.delivered).toBe(0);
  });

  it("recorded, partial, zero, missing and not delivered are five different things", () => {
    expect(cellStatus(7, 7, 84_234)).toBe("recorded");
    expect(cellStatus(1, 7, 11_791)).toBe("partial");
    expect(cellStatus(7, 7, 0)).toBe("zero");
    expect(cellStatus(0, 7, null)).toBe("missing");
    expect(cellStatus(0, 0, null)).toBe("not_delivered");
    // Some days report $0.00, others have no record: partial, never "zero".
    expect(cellStatus(3, 7, 0)).toBe("partial");
  });

  it("accepts only a Monday inside the window and a channel code's shape from the URL", () => {
    expect(parseWeek("2026-10-19")).toBe("2026-10-19");
    expect(parseWeek("2026-10-20")).toBeNull(); // a Tuesday
    expect(parseWeek("2026-11-02")).toBeNull(); // outside the window
    expect(parseWeek("x")).toBeNull();
    expect(parseChannel("google_lsa")).toBe("google_lsa");
    expect(parseChannel("Google LSA")).toBeNull();
    expect(parseChannel("x'; drop")).toBeNull();
  });
});

const cell = (week: string, cents: number | null, days: number, status: Cell["status"], leads = 0): Cell => ({ week, cents, daysWithRecord: days, daysDelivered: 7, status, leads });

function fixture(over: Partial<Movement> = {}): Movement {
  const weeks = windowWeeks(PERIODS.oct, "2026-10-30");
  return {
    scope: { branchId: "B12", branchIds: null },
    period: { key: "oct", label: "Oct 1–30, 2026 (UTC)", compareLabel: "Sep 1–30, 2026 (UTC)" },
    weeks,
    series: [
      {
        channel: "google_lsa",
        label: "Google Local Services",
        cells: weeks.map((w) => (w.start < "2026-10-12" ? cell(w.start, 90_000, 7, "recorded", 10) : w.start === "2026-10-12" ? cell(w.start, 12_000, 1, "partial", 20) : cell(w.start, null, 0, "missing", 15))),
        periodCents: 100_000,
        compareCents: 380_000,
      },
    ],
    markers: [
      { exceptionId: 77, status: "open", date: "2026-10-14", week: "2026-10-12", channel: "google_lsa", channelLabel: "Google Local Services", successors: [{ externalCampaignId: "pmax-x", classifiedAs: ["Google Search"], spendSinceCents: 150_000, firstSpendDate: "2026-10-14" }] },
    ],
    holds: [{ exceptionId: 77, branchId: "B12", kind: "channel_coverage_gap", summary: "…", amountCents: 150_000 }],
    deliveredThrough: "2026-10-30",
    feedStale: null,
    totals: { periodCents: 100_000, compareCents: 380_000 },
    ...over,
  };
}

describe("the takeaway comes from the stored scope, not the demo", () => {
  it("a coverage gap: what stopped, what kept arriving, where the money went, and that it calls for review", () => {
    const t = takeaway(fixture(), "B12");
    expect(t.headline).toBe("Google Local Services spend at B12 stopped after Oct 13 while its leads kept arriving.");
    expect(t.detail).toBe("$1,500.00 has since been spent under pmax-x, which is filed as Google Search. Until it is re-mapped, cost per customer is wrong for both channels.");
    expect(t.trust).toMatchObject({ tone: "review", label: "Investigate before acting" });
    expect(t.trust.text).toBe("An open incident records a coverage gap here from Oct 14. This is a number to investigate, not a budget movement to act on.");
  });

  it("no incident: the period against September and the largest channel change; nothing calls for review", () => {
    const t = takeaway(fixture({ markers: [], holds: [] }), "B12");
    expect(t.headline).toBe("Paid media spend at B12: $1,000.00 in Oct 1–30, −74% vs September.");
    expect(t.detail).toBe("The largest change by channel: Google Local Services, −$2,800.00.");
    expect(t.trust.tone).toBe("clear");
  });

  it("a stale ads feed says the latest weeks may be incomplete", () => {
    const t = takeaway(fixture({ markers: [], holds: [], feedStale: "The ads feed last delivered 52 h ago (limit 36 h)." }), "B12");
    expect(t.trust).toMatchObject({ tone: "unknown", label: "Spend may be incomplete" });
  });
});

describe("one point, in words", () => {
  const m = fixture();
  const s = m.series[0];
  const week = (start: string) => m.weeks.find((w) => w.start === start)!;
  it("missing is not $0; partial names the days; a marker in the week is named", () => {
    expect(explainCell(s, s.cells[7], week("2026-10-19"), m.markers)).toEqual([
      // Was "nothing was delivered for this channel here": a delivered day filed under another
      // channel also has no record here (B09-RECOVERY.md).
      "No spend record on any of its 7 days. This is not $0: no record here says what this channel spent.",
      "15 lead records from this channel arrived here that week (a count, not dollars).",
    ]);
    const partial = explainCell(s, s.cells[6], week("2026-10-12"), m.markers);
    expect(partial[0]).toBe("$120.00, from records on 1 of 7 days. The other 6 days have no spend record.");
    expect(partial).toContain("Incident #77 (open) records a coverage gap from Oct 14, in this week.");
    expect(weekLabel(week("2026-10-26"))).toBe("Oct 26–Oct 30");
  });
});
