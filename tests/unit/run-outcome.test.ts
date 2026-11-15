import { describe, expect, it } from "vitest";
import { EFFECT_NOT_RECORDED, runOutcome, verificationSentence, type RunFacts } from "@/lib/ingest/run-outcome";

/**
 * A delivery run's outcome in words (lib/ingest/run-outcome.ts), as its row on the Integrations
 * pipeline shows it. Synthetic counts; the runs that record them are tested in
 * tests/integration/b09-recovery.test.ts and tests/integration/run-effect.test.ts.
 */

const run = (facts: Partial<RunFacts>): RunFacts => ({ fetched: 13, inserted: 13, duplicates: 0, projected: 13, rowsChanged: 13, ...facts });
const days = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => `2026-10-${String(from + i).padStart(2, "0")}`);
const verification = (dates: string[]) => ({ exceptionId: 2455, verifiedAt: "2026-10-31T13:15:00.000Z", dates, requiredDates: 18 });

describe("a run's outcome is what was recorded when it ran", () => {
  it("a run that changed accepted records says how many changes, whatever it stored", () => {
    expect(runOutcome(run({ rowsChanged: 13 }))).toEqual({ recorded: true, effect: "13 changes to accepted records", reason: null, verifications: [] });
    expect(runOutcome(run({ inserted: 1, projected: 1, rowsChanged: 1 })).effect).toBe("1 change to accepted records");
    // More changes than versions stored: an earlier version accepted again, or an exclusion applied.
    expect(runOutcome(run({ inserted: 188, projected: 188, rowsChanged: 189 })).effect).toBe("189 changes to accepted records");
  });

  it("stored is not changed: a stored version older than the accepted one changes nothing (run #679)", () => {
    expect(runOutcome(run({ fetched: 1, inserted: 1, projected: 1, rowsChanged: 0 }))).toEqual({
      recorded: true,
      effect: "No change to accepted records",
      reason: "Stored, but a newer revision was already accepted",
      verifications: [],
    });
  });

  it("a duplicate delivery changes nothing (run #678)", () => {
    expect(runOutcome(run({ inserted: 0, duplicates: 13, projected: 0, rowsChanged: 0 }))).toMatchObject({
      effect: "No change to accepted records",
      reason: "Duplicate: every delivery was a version already stored",
    });
  });

  it("a run's other no-change cases say only what its counts show", () => {
    expect(runOutcome(run({ fetched: 0, inserted: 0, projected: 0, rowsChanged: 0 })).reason).toBe("Nothing delivered");
    // Some deliveries conflicted with a stored version: not every one was a duplicate.
    expect(runOutcome(run({ fetched: 3, inserted: 0, duplicates: 2, projected: 0, rowsChanged: 0 })).reason).toBe("Nothing new stored");
    // Some stored versions were quarantined or excluded: the run cannot say all were superseded.
    expect(runOutcome(run({ fetched: 5, inserted: 5, projected: 3, rowsChanged: 0 })).reason).toBe("Stored, none accepted");
  });

  it("an effect that was not recorded is never 'no change', even when the counts look like a duplicate", () => {
    for (const facts of [run({ rowsChanged: null }), run({ inserted: 0, duplicates: 13, projected: 0, rowsChanged: null }), run({ fetched: 0, inserted: 0, projected: 0, rowsChanged: null })]) {
      const o = runOutcome(facts);
      expect(o).toEqual({ recorded: false, effect: EFFECT_NOT_RECORDED, reason: null, verifications: [] });
      expect(o.effect).not.toMatch(/no change/i);
    }
  });

  it("a verification that used the run says which of its dates, out of how many, cleared which incident's hold", () => {
    const partial = runOutcome(run({ fetched: 5, inserted: 5, projected: 5, rowsChanged: 5 }), [verification(days(26, 30))]);
    expect(partial.verifications.map(verificationSentence)).toEqual(["Incident #2455's verification used Oct 26–Oct 30 (5 of 18 dates) to clear its coverage hold."]);
    const rest = runOutcome(run({ rowsChanged: 13 }), [verification(days(13, 25))]);
    expect(rest.verifications.map(verificationSentence)).toEqual(["Incident #2455's verification used Oct 13–Oct 25 (13 of 18 dates) to clear its coverage hold."]);
    // Neither sentence, nor any effect or reason, claims a decision is ready or a budget change approved.
    const words = [partial, rest, runOutcome(run({ fetched: 1, inserted: 1, projected: 1, rowsChanged: 0 }))].flatMap((o) => [o.effect, o.reason ?? "", ...o.verifications.map(verificationSentence)]);
    expect(words.join(" ")).not.toMatch(/\bready\b|\bapprov|\bbudget\b|\bdecision\b/i);
  });

  it("a run can have changed nothing when it ran and still be used later: both are said", () => {
    const o = runOutcome(run({ rowsChanged: 0 }), [verification(["2026-10-20"])]);
    expect([o.effect, o.verifications.map(verificationSentence)]).toEqual(["No change to accepted records", ["Incident #2455's verification used Oct 20 (1 of 18 dates) to clear its coverage hold."]]);
    expect(runOutcome(run({ rowsChanged: null }), [verification(["2026-10-20"])]).effect).toBe(EFFECT_NOT_RECORDED);
  });
});
