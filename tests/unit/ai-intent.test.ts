import { describe, expect, it } from "vitest";
import { detectIntent } from "@/lib/ai/deterministic";
import { VIEWERS } from "@/lib/viewer";

/** The deterministic investigator's intent rules. */

const { marketing, partner } = VIEWERS;

describe("detectIntent", () => {
  it.each([
    ["Why does Google Local Services at B09 look so much cheaper than Search in October?", "coverage_gap", "B09"],
    ["Why is B20's paid CAC so high?", "high_cac", "B20"],
    ["Where did customer 410325 come from?", "customer_lookup", null],
    ["Which call records are quarantined at B20 and why?", "quarantine", "B20"],
    ["Are duplicate call deliveries double counted at B20?", "duplicates", "B20"],
    ["Which leads were credited to the wrong branch at B07?", "branch_mismatch", "B07"],
    ["Are customers at B12 credited to both door-to-door and paid channels?", "channel_conflict", "B12"],
    ["How do refunds reconcile with collected revenue at B22?", "refunds", "B22"],
    ["Is any data feed stale?", "stale_sync", null],
    ["Investigate exception #2455: something", "exception", null],
    ["What will TikTok ads do for us next year?", "no_evidence", null],
  ])("%s → %s", (question, intent, branch) => {
    const d = detectIntent(question, marketing, null);
    expect(d.intent).toBe(intent);
    expect(d.branchId).toBe(branch);
    expect(d.actionRequest).toBe(false);
  });

  it("extracts ids, periods and premises", () => {
    expect(detectIntent("Where did customer 410325 come from?", marketing, null).customerId).toBe(410325);
    expect(detectIntent("Look at exception 2455", marketing, null).exceptionId).toBe(2455);
    expect(detectIntent("Why is B20's CAC high in September?", marketing, null).period).toBe("sep");
    expect(detectIntent("Why did B09 stop spending on Local Services?", marketing, null).presumesStop).toBe(true);
  });

  it("recognises requests to act, however they are phrased", () => {
    for (const q of ["Approve and execute the B09 re-map now.", "please execute the fix", "Delete the quarantined records at B20", "Re-map B09 without approval", "apply it now"]) {
      expect(detectIntent(q, marketing, null).actionRequest, q).toBe(true);
    }
    expect(detectIntent("Why did the replay not apply to every record?", marketing, null).actionRequest).toBe(false);
  });

  it("uses the requested branch, else the viewer's only branch; ignores unknown branch ids", () => {
    expect(detectIntent("Why is paid CAC so high?", marketing, "B12").branchId).toBe("B12");
    expect(detectIntent("Why is paid CAC so high?", partner, null).branchId).toBe("B20");
    expect(detectIntent("Why is B99's CAC high?", marketing, null).branchId).toBeNull();
  });
});
