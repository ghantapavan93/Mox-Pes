import { describe, expect, it } from "vitest";
import { takeaway } from "@/lib/metrics/movement-copy";
import type { Movement } from "@/lib/metrics/movement";
import type { GapCoverage } from "@/lib/reconcile/gap-coverage";
import { gapStatus, weekAgainstWindow, windowProgress } from "@/lib/reconcile/gap-status";

/**
 * A coverage gap's decision status in words (lib/reconcile/gap-status.ts): the sentences the
 * Overview, the daily evidence, the incident and Decision Lab share. Synthetic coverage; the
 * reconciliation that produces it is tested in tests/integration/b09-recovery.test.ts.
 */

const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-10-${String(from + i).padStart(2, "0")}`);
const filedAsSearch = (dates: string[], branchId = "B12") => dates.map((date) => ({ date, externalCampaignId: "pmax-x", channel: "google_search", branchId, cents: 10_000 }));

/** Local Services stopped after Oct 12; its successor spends $100.00 a day, Oct 13–30 (18 dates, $1,800.00). */
function coverage(over: Partial<GapCoverage> = {}): GapCoverage {
  return {
    branchId: "B12",
    channel: "google_lsa",
    channelLabel: "Google Local Services",
    lastSpendDate: "2026-10-12",
    window: { from: "2026-10-13", to: "2026-10-30" },
    frozen: false,
    transition: [],
    required: days(13, 30),
    covered: [],
    missing: days(13, 30),
    recordedZero: [],
    misfiled: filedAsSearch(days(13, 30)),
    runs: [],
    coveredCents: 0,
    misfiledCents: 180_000,
    complete: false,
    amountChanges: [],
    days: [],
    ...over,
  };
}

/** The original finding, as the incident stored it: the successor's spend, filed as Google Search. */
const finding = { successors: [{ externalCampaignId: "pmax-x", spendSinceGapCents: 180_000, classifiedAs: ["google_search"] }] };
const verification = { verifiedAt: "2026-10-31T13:15:00.000Z", window: { from: "2026-10-13", to: "2026-10-30" }, requiredDates: 18, coveredDates: 18, coveredCents: 180_000, runs: [], rule: "…" };
const partial = coverage({ covered: days(26, 30), missing: days(13, 25), misfiled: filedAsSearch(days(13, 25)), coveredCents: 50_000, misfiledCents: 130_000 });
const complete = coverage({ covered: days(13, 30), missing: [], misfiled: [], coveredCents: 180_000, misfiledCents: 0, complete: true });

describe("one status, the same words everywhere", () => {
  it("missing: held, nothing covered, and where the successor's money is filed instead", () => {
    const s = gapStatus({ id: 7, status: "open", evidence: finding }, coverage());
    expect(s).toMatchObject({ state: "missing", held: true, label: "Hold the budget decision", reclassified: false });
    expect(s.conclusion).toBe("Hold the budget decision. A required Google Local Services spend record is missing at B12: none of the 18 dates in the decision window (Oct 13–Oct 30) has one.");
    expect(s.change).toBe("Since Oct 13, $1,800.00 has been spent under pmax-x, which is filed as Google Search; none of it is filed as Google Local Services.");
  });

  it("partial: the repaired week does not clear the window; the before/after names both halves", () => {
    const s = gapStatus({ id: 7, status: "open", evidence: finding }, partial);
    expect(s).toMatchObject({ state: "partial", held: true, label: "Still on hold · 5 of 18 days verified", coveredLabel: "Oct 26–Oct 30", openLabel: "Oct 13–Oct 25" });
    expect(s.conclusion).toBe("Still on hold · 5 of 18 days verified. Oct 26–Oct 30 are covered, but the decision window (Oct 13–Oct 30) is not: Oct 13–Oct 25 still have no Google Local Services record.");
    expect(s.statusText).toBe("Oct 26–Oct 30 are covered, but the decision window (Oct 13–Oct 30) is not: Oct 13–Oct 25 still have no Google Local Services record.");
    expect(s.change).toBe("Originally $1,800.00 was filed as Google Search. Now $500.00 (Oct 26–Oct 30) is filed as Google Local Services; $1,300.00 (Oct 13–Oct 25) is still filed as Google Search.");
  });

  it("verified: cleared, and reclassified, not added, only when the window carries exactly the original amount", () => {
    const s = gapStatus({ id: 7, status: "resolved", evidence: { ...finding, verification } }, complete);
    expect(s).toMatchObject({ state: "verified", held: false, label: "Coverage hold cleared · 18 of 18 days verified", reclassified: true });
    expect(s.conclusion).toBe("Coverage hold cleared · 18 of 18 days verified. All 18 dates in the decision window (Oct 13–Oct 30) have Google Local Services spend at B12, verified Oct 31, 1:15 PM UTC.");
    expect(s.change).toBe("$1,800.00 moved from Google Search to Google Local Services, and no amount changed: reclassified, not added.");
    // The source re-sent the window with $50.00 more: covered, verified, but not "the same money".
    const more = gapStatus({ id: 7, status: "resolved", evidence: { ...finding, verification } }, { ...complete, coveredCents: 185_000 });
    expect(more.reclassified).toBe(false);
    expect(more.change).toBe("The window now carries $1,850.00 filed as Google Local Services; the original finding recorded $1,800.00 filed as Google Search.");
    // The same total, but two days restated money in opposite directions: that is not "the same money".
    const offset = gapStatus(
      { id: 7, status: "resolved", evidence: { ...finding, verification } },
      { ...complete, amountChanges: [{ date: "2026-10-14", externalCampaignId: "pmax-x", beforeCents: 10_000, afterCents: 10_500 }, { date: "2026-10-15", externalCampaignId: "pmax-x", beforeCents: 10_000, afterCents: 9_500 }] },
    );
    expect(offset.reclassified).toBe(false);
    expect(offset.change).toBe("The window now carries $1,800.00 filed as Google Local Services; the original finding recorded $1,800.00 filed as Google Search. Amounts changed: Oct 14: $100.00 became $105.00; Oct 15: $100.00 became $95.00.");
    expect(offset.change).not.toMatch(/reclassified, not added|moved from/i);
  });

  it("historical: a verification the records no longer support says so, and a recorded $0.00 is not a missing day", () => {
    const later = coverage({ covered: days(13, 30).filter((d) => d !== "2026-10-20"), missing: [], recordedZero: ["2026-10-20"], misfiled: [], coveredCents: 170_000, misfiledCents: 0, frozen: true });
    const s = gapStatus({ id: 7, status: "resolved", evidence: { ...finding, verification } }, later);
    expect(s).toMatchObject({ state: "historical", held: false, label: "Verification no longer current · 17 of 18 days covered" });
    expect(s.conclusion).toBe("Verification no longer current · 17 of 18 days covered. It was verified Oct 31, 1:15 PM UTC, but now 17 of 18 dates in the decision window (Oct 13–Oct 30) have Google Local Services spend at B12; Oct 20 recorded $0.00; this is history, not a current clearance.");
    expect(s.label).not.toMatch(/cleared/i);
    expect(s.change).toBe("Originally $1,800.00 was filed as Google Search. Now $1,700.00 (Oct 13–Oct 19, Oct 21–Oct 30) is filed as Google Local Services; Oct 20 recorded $0.00.");
  });

  it("no record and a recorded $0.00 are named apart; spend at another branch is misfiled, not covered", () => {
    const mixed = coverage({ covered: days(21, 30), missing: days(13, 19), recordedZero: ["2026-10-20"], misfiled: [], coveredCents: 100_000, misfiledCents: 0 });
    expect(windowProgress(mixed)).toBe("10 of 18 dates in the decision window (Oct 13–Oct 30) have Google Local Services spend at B12; Oct 13–Oct 19 have no record and Oct 20 recorded $0.00");
    const elsewhere = coverage({ covered: days(13, 30), missing: [], misfiled: filedAsSearch(["2026-10-14"], "B13").map((m) => ({ ...m, channel: "google_lsa" })), coveredCents: 180_000, misfiledCents: 10_000 });
    expect(windowProgress(elsewhere)).toBe("all 18 dates in the decision window (Oct 13–Oct 30) have Google Local Services spend at B12, but $100.00 of successor spend in it is still filed at B13");
    expect(gapStatus({ id: 7, status: "open", evidence: finding }, elsewhere).state).toBe("partial");
  });

  it("an incident resolved before verifications existed says only that", () => {
    const s = gapStatus({ id: 7, status: "resolved", evidence: finding, resolution: "Condition no longer detected" }, complete);
    expect(s).toMatchObject({ state: "resolved", label: "Resolved", conclusion: "Resolved. Condition no longer detected.", change: null });
    expect(weekAgainstWindow(s, { start: "2026-10-26", end: "2026-10-30" })).toBeNull();
  });
});

describe("a selected week is not the decision window", () => {
  const held = gapStatus({ id: 7, status: "open", evidence: finding }, partial);
  it("a complete week inside an incomplete window says both", () => {
    expect(weekAgainstWindow(held, { start: "2026-10-26", end: "2026-10-30" })).toBe(
      "This week's dates in the decision window are covered, but the window (Oct 13–Oct 30) is not: Oct 13–Oct 25 still have no Google Local Services spend. The decision stays held.",
    );
  });
  it("a week with open dates names them; a week outside the window says so", () => {
    expect(weekAgainstWindow(held, { start: "2026-10-19", end: "2026-10-25" })).toBe(
      "The decision window (Oct 13–Oct 30) has Google Local Services spend on 5 of 18 dates; Oct 13–Oct 25 still have none, Oct 19–Oct 25 in this week. The decision stays held.",
    );
    expect(weekAgainstWindow(held, { start: "2026-10-05", end: "2026-10-11" })).toBe("This week is outside the decision window (Oct 13–Oct 30).");
    const none = gapStatus({ id: 7, status: "open", evidence: finding }, coverage());
    expect(weekAgainstWindow(none, { start: "2026-10-26", end: "2026-10-30" })).toBe("None of the 18 dates in the decision window (Oct 13–Oct 30) has Google Local Services spend, this week's included. The decision stays held.");
  });
  it("after verification, the window is covered whatever week is picked", () => {
    const done = gapStatus({ id: 7, status: "resolved", evidence: { ...finding, verification } }, complete);
    expect(weekAgainstWindow(done, { start: "2026-10-19", end: "2026-10-25" })).toBe("The decision window (Oct 13–Oct 30) has Google Local Services spend on all 18 dates, verified Oct 31, 1:15 PM UTC.");
  });
});

describe("the Overview quotes the incident's status, it does not recompute it", () => {
  const base = (status: string, recovery: ReturnType<typeof gapStatus>): Movement => ({
    scope: { branchId: "B12", branchIds: ["B12"] },
    period: { key: "oct", label: "Oct 1–30, 2026 (UTC)", compareLabel: "Sep 1–30, 2026 (UTC)" },
    weeks: [],
    series: [{ channel: "google_lsa", label: "Google Local Services", cells: [], periodCents: 0, compareCents: 0 }],
    markers: [{ exceptionId: 7, status, date: "2026-10-13", week: "2026-10-12", channel: "google_lsa", channelLabel: "Google Local Services", successors: [] }],
    recoveries: [recovery],
    holds: status === "open" ? [{ exceptionId: 7, branchId: "B12", kind: "channel_coverage_gap", summary: "…", amountCents: 180_000, companyLevel: false }] : [],
    deliveredThrough: "2026-10-30",
    feedStale: null,
    totals: { periodCents: 0, compareCents: 0 },
  });
  it("held: the status line is the incident's own, with its evidence", () => {
    const t = takeaway(base("open", gapStatus({ id: 7, status: "open", evidence: finding }, partial)), "B12");
    expect(t.headline).toBe("Google Local Services spend at B12 stopped after Oct 12; since then only Oct 26–Oct 30 have any.");
    expect(t.trust).toEqual({ tone: "review", label: "Still on hold · 5 of 18 days verified", text: "Oct 26–Oct 30 are covered, but the decision window (Oct 13–Oct 30) is not: Oct 13–Oct 25 still have no Google Local Services record.", exceptionId: 7 });
    expect(t.detail).toContain("$1,300.00 (Oct 13–Oct 25) is still filed as Google Search.");
  });
  it("cleared: what cleared, and that the money moved between channels", () => {
    const t = takeaway(base("resolved", gapStatus({ id: 7, status: "resolved", evidence: { ...finding, verification } }, complete)), "B12");
    expect(t.trust).toMatchObject({ tone: "clear", label: "Coverage hold cleared · 18 of 18 days verified", exceptionId: 7 });
    expect(t.trust.text).toContain("$1,800.00 moved from Google Search to Google Local Services, and no amount changed: reclassified, not added.");
  });
});
