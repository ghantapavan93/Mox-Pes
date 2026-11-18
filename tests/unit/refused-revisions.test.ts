import { describe, expect, it } from "vitest";
import { mapperVersions, replayableVersions } from "@/lib/adapters/registry";
import {
  correctedResolution,
  correctionsOf,
  holdMoney,
  revisionsOf,
  unattributedSentence,
  type RefusedRevision,
  type RevisionCorrection,
} from "@/lib/reconcile/refused-revisions";

/**
 * The pure rules behind a hold on refused spend revisions (EGM review of HOLD-TO-DECISION.md,
 * 2026-11-18): one entry and one counted amount per campaign-day however often it is refused (K1),
 * "Corrected" only when a revision was accepted (K2), and a replay only through a mapper that still
 * applies the check that refused the record (K6). The database paths are in
 * tests/integration/refused-revision.test.ts.
 */

/** A stored evidence entry as rule 1 wrote it before 2026-11-18: one per refused delivery. */
const stored = (over: Record<string, unknown>) => ({
  rawEventId: 1,
  campaignId: 7,
  externalCampaignId: "pmax-lsa-B09",
  platform: "google_ads",
  date: "2026-10-20",
  channel: "google_lsa",
  errorDetail: "spend_day pmax-lsa-B09: 2.5 platform conversions; the store keeps whole numbers only",
  refusedFetchedAt: "2026-10-31T12:00:00.000Z",
  refusedRunId: 5,
  refusedCents: 40_000,
  acceptedRawEventId: 99,
  acceptedFetchedAt: "2026-10-21T06:00:00.000Z",
  acceptedRunId: 1,
  acceptedCents: 20_740,
  ...over,
});

const lift = (r: RefusedRevision, correction: Partial<RevisionCorrection["correction"]>): RevisionCorrection => ({
  ...r,
  correction: { how: "newer_accepted", rawEventId: 200, runId: 9, replayId: null, fetchedAt: "2026-10-31T15:00:00.000Z", cents: r.acceptedCents, branchId: "B09", at: "2026-10-31T15:05:00.000Z", ...correction },
});

describe("one campaign-day, however often it is refused (K1)", () => {
  const revisions = revisionsOf({
    revisions: [
      stored({ rawEventId: 3, refusedFetchedAt: "2026-10-31T14:00:00.000Z", refusedRunId: 7 }),
      stored({ rawEventId: 1 }),
      stored({ rawEventId: 2, refusedFetchedAt: "2026-10-31T13:00:00.000Z", refusedRunId: 6 }),
      stored({ rawEventId: 4, date: "2026-10-21", acceptedCents: 20_777 }),
    ],
  });

  it("evidence stored per delivery reads as one entry per day: the newest refusal speaks, every delivery is kept", () => {
    expect(revisions.map((r) => [r.date, r.rawEventId, r.refusedRunId, r.refusedRawEventIds])).toEqual([
      ["2026-10-20", 3, 7, [1, 2, 3]],
      ["2026-10-21", 4, 5, [4]],
    ]);
  });

  it("the counted amount is summed once per day, not once per refusal", () => {
    expect(holdMoney(revisions, []).heldCents).toBe(20_740 + 20_777);
  });

  it("the same lift stored once per delivery is said once", () => {
    const [oct20] = revisions;
    const once = lift(oct20, { cents: 40_000 });
    expect(correctionsOf({ corrected: [once, once, once] })).toHaveLength(1);
  });
});

describe("a lift is a correction only when a revision was accepted (K2)", () => {
  const [oct20, oct21] = revisionsOf({ revisions: [stored({}), stored({ rawEventId: 4, date: "2026-10-21", acceptedCents: 20_777 })] });
  const accepted = lift(oct20, { cents: 40_000 });
  const notCounted = lift(oct21, { how: "no_longer_counted", rawEventId: null, runId: null, cents: null });
  const moved = lift(oct20, { how: "other", rawEventId: 99, runId: null, cents: 20_740, branchId: "B10" });

  it("an accepted newer revision is 'Corrected', with what it changed", () => {
    expect(correctedResolution([accepted], "B09")).toBe("Corrected. Oct 20: ingestion run #9 accepted a newer revision (fetched Oct 31, 3:00 PM UTC): $207.40 became $400.00.");
  });

  it("a day the ledger stops counting is not corrected, and is not a $0.00 day: its counted amount left the total", () => {
    const text = correctedResolution([notCounted], "B09");
    expect(text).toMatch(/^No longer held by this incident; nothing was corrected for Oct 21\. /);
    expect(text).toContain("the $207.77 it counted left the total; the day is held spend now");
    expect(text).not.toContain("$0.00");
    expect(holdMoney([], [notCounted])).toEqual({ heldCents: 0, countedNowCents: 0, notCounted: 1, changeCents: -20_777, changedDays: 1 });
  });

  it("a campaign mapped to another branch moves the hold; it does not correct it", () => {
    expect(correctedResolution([moved], "B09")).toBe("No longer held by this incident; nothing was corrected for Oct 20. Oct 20: the campaign is now mapped to B10, so the hold moved there with it.");
  });

  it("mixed lifts name only the days that were not corrected", () => {
    expect(correctedResolution([accepted, notCounted], "B09")).toMatch(/^No longer held by this incident; nothing was corrected for Oct 21\. Oct 20: ingestion run #9 /);
    expect(holdMoney([], [accepted, notCounted])).toEqual({ heldCents: 0, countedNowCents: 40_000, notCounted: 1, changeCents: 40_000 - 20_740 - 20_777, changedDays: 2 });
  });

  it("a held day in a company-level group is said to hold its channel, never 'never counted' or 'not a hold'", () => {
    const text = unattributedSentence({ unidentified: 0, unknownCampaign: 0, unmapped: 0, heldDay: { count: 1, branchIds: ["B09"] }, sameInstant: 0 });
    expect(text).toBe("1 record is a day the ledger counts no revision of at B09: held spend, which holds that channel's decision in Decision Lab until a revision is accepted. No branch's budget decision is held by this incident.");
  });
});

describe("a replay keeps every check that refused the record (K6)", () => {
  it("ads: a version older than the check is never offered", () => {
    expect(replayableVersions("ads", ["AMBIGUOUS_CAMPAIGN_TYPE"])).toEqual(["1.1", "1.2"]);
    expect(replayableVersions("ads", ["CURRENCY_UNSUPPORTED"])).toEqual(["1.2"]);
    expect(replayableVersions("ads", ["FRACTIONAL_CONVERSIONS", "AMBIGUOUS_CAMPAIGN_TYPE"])).toEqual(["1.2"]);
  });

  it("a refusal no version introduced, or another source, keeps every shipped version (rollbacks stay possible)", () => {
    expect(replayableVersions("ads", ["SCHEMA_INVALID"])).toEqual(mapperVersions("ads"));
    expect(replayableVersions("calls", ["SCHEMA_INVALID"])).toEqual(mapperVersions("calls"));
  });
});
