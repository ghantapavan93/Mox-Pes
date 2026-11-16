import { describe, expect, it } from "vitest";
import type { GapCoverage, GapDay, GapDayRecord } from "@/lib/reconcile/gap-coverage";
import { dayEvidence, defaultDay, windowFacts } from "@/lib/reconcile/gap-days";

/**
 * The decision window, one date at a time (lib/reconcile/gap-days.ts): what arrived, why it did or
 * did not count, what clears it; and the selected week beside the window. Synthetic records.
 */

const ctx = { branchId: "B09", channelLabel: "Google Local Services" };
const rec = (over: Partial<GapDayRecord> = {}): GapDayRecord => ({
  externalCampaignId: "pmax-lsa-B09",
  channel: "google_lsa",
  branchId: "B09",
  cents: 12_091,
  rawEventId: 200_027,
  runId: 677,
  fetchedAt: "2026-10-31T13:10:00Z",
  adapterVersion: "ads@1.2",
  ...over,
});
const day = (date: string, state: GapDay["state"], records: GapDayRecord[] = [], misfiled: GapDayRecord[] = []): GapDay => ({ date, state, records, misfiled });

describe("one date's evidence", () => {
  it("a missing date whose spend is filed as Search says where it is, why it does not count and what clears it", () => {
    const e = dayEvidence(day("2026-10-13", "missing", [], [rec({ channel: "google_search", cents: 10_869, rawEventId: 158_811, runId: 412, fetchedAt: "2026-10-15T06:00:00.000Z", adapterVersion: "ads@1.0" })]), ctx);
    expect(e).toMatchObject({ date: "2026-10-13", dayOfMonth: 13, long: "Tue, Oct 13", mark: "missing", stateLabel: "No record", unresolved: true });
    expect(e.received).toEqual([{ text: "pmax-lsa-B09: $108.69 filed as Google Search, fetched Oct 15, 6:00 AM UTC, run #412 (ads@1.0)", rawEventId: 158_811 }]);
    expect(e.why).toBe("Its spend is filed as Google Search, not Google Local Services, so Google Local Services has no record for this date. The mapper that filed it (ads@1.0) read the campaign that way.");
    expect(e.clears).toBe("A record of this date filed as Google Local Services at B09: re-sent by the source, or re-mapped in Fix & approval.");
    expect(e.ariaLabel).toBe("Tue, Oct 13: no Google Local Services record; spend filed as Google Search");
  });

  it("a verified date counts, and nothing is left; a recorded $0.00 is never spend; no record at all says so", () => {
    expect(dayEvidence(day("2026-10-20", "covered", [rec()]), ctx)).toMatchObject({ mark: "verified", stateLabel: "Verified", unresolved: false, why: "It counts: Google Local Services spend at B09 on this date.", clears: "Nothing is left for this date." });
    const zero = dayEvidence(day("2026-10-21", "zero", [rec({ cents: 0 })]), ctx);
    expect(zero).toMatchObject({ mark: "zero", stateLabel: "Recorded $0.00", unresolved: true });
    expect(zero.why).toContain("A recorded zero is not spend");
    const none = dayEvidence(day("2026-10-22", "missing"), ctx);
    expect(none.received).toEqual([{ text: "No spend record for Google Local Services at B09, and none filed elsewhere.", rawEventId: null }]);
    expect(none.why).toBe("Nothing for Google Local Services at B09 arrived for this date.");
    expect(none.received[0].text).not.toMatch(/\$0\.00/);
  });

  it("spend at another branch is named with that branch, and a verified date with spend still filed elsewhere stays unresolved", () => {
    const e = dayEvidence(day("2026-10-14", "covered", [rec()], [rec({ branchId: "B13", cents: 500 })]), ctx);
    expect(e).toMatchObject({ mark: "verified", unresolved: true });
    expect(e.why).toContain("filed as Google Local Services at B13");
  });
});

describe("the selected week beside the decision window", () => {
  const dates = Array.from({ length: 18 }, (_, i) => `2026-10-${String(13 + i).padStart(2, "0")}`);
  const partial = { required: dates, window: { from: dates[0], to: dates[17] }, covered: dates.slice(13), complete: false, days: dates.map((d, i) => day(d, i >= 13 ? "covered" : "missing", i >= 13 ? [rec({ fetchedAt: "2026-10-31T13:00:00Z" })] : [])) } as unknown as GapCoverage;

  it("at 5 of 18 a covered week and an incomplete window read as both", () => {
    const f = windowFacts(partial, { start: "2026-10-26", end: "2026-11-01" });
    expect(f.counts).toEqual({ verified: 5, missing: 13, zero: 0 });
    expect(f.week).toEqual({ label: "Oct 26–Oct 30", total: 5, verified: 5, complete: true });
    expect(f.window).toEqual({ label: "Oct 13–Oct 30", total: 18, verified: 5, complete: false, openLabel: "Oct 13–Oct 25" });
  });

  it("a week outside the window, or no week, gives no week fact; the first unresolved date is selected first, and none when all are verified", () => {
    expect(windowFacts(partial, { start: "2026-10-05", end: "2026-10-11" }).week).toBeNull();
    expect(windowFacts(partial, null).week).toBeNull();
    const days = partial.days.map((d) => dayEvidence(d, ctx));
    expect(defaultDay(days)).toBe("2026-10-13");
    // At 18 of 18 nothing needs explaining, so no date opens by itself (the money moved leads instead).
    expect(defaultDay(days.slice(13))).toBeNull();
    // A verified date with spend still filed elsewhere is still unresolved, so it opens.
    const stray = dayEvidence(day("2026-10-27", "covered", [rec()], [rec({ branchId: "B13", cents: 500 })]), ctx);
    expect(defaultDay([...days.slice(13, 14), stray])).toBe("2026-10-27");
    expect(defaultDay([])).toBeNull();
  });
});
