import { describe, expect, it } from "vitest";
import { attentionFlags } from "@/lib/attention";
import { cacDefined, paidCac, type BranchRow } from "@/lib/metrics/scorecard";

/**
 * Business-fit fixture, 2026-11-17: Branch A's campaign (B10, $200) produced the lead; Branch B
 * (B11) serviced the customer. Spend follows the campaign's mapped branch and customers follow the
 * servicing office (D-2), so B11 had 1 paid customer and $0 of paid spend, and every surface read
 * its paid CAC as "$0.00": the cheapest branch in the company, from a measurement gap.
 */
describe("paid-media CAC (definition v4)", () => {
  it("is not computed for paid customers with no paid spend counted", () => {
    expect(paidCac(0, 1)).toBeNull(); // v3 returned 0, shown as $0.00
  });

  it("is still not computed without paid customers", () => {
    expect(paidCac(20_000, 0)).toBeNull();
    expect(paidCac(0, 0)).toBeNull();
  });

  it("divides and rounds to the cent otherwise, as before (control)", () => {
    expect(paidCac(20_000, 1)).toBe(20_000); // the fixture's company figure, $200.00
    expect(paidCac(25_000, 3)).toBe(8_333);
    expect(paidCac(1, 2)).toBe(1); // half a cent rounds up
  });

  it("exposes the same rule for the unrounded callers (weekly bars, attention flags)", () => {
    expect(cacDefined(0, 1)).toBe(false);
    expect(cacDefined(20_000, 0)).toBe(false);
    expect(cacDefined(20_000, 1)).toBe(true);
  });
});

const row = (branchId: string, paidSpendCents: number, paidAcquired: number): BranchRow => ({
  branchId,
  name: branchId,
  region: "Synthetic",
  paidSpendCents,
  platformClaimed: 0,
  rawLeads: 0,
  prospects: 0,
  paidProspects: 0,
  sold: 0,
  acquired: paidAcquired,
  paidAcquired,
  heldCampaignAcquired: 0,
  partlyHeldAcquired: 0,
  unknownAcquired: 0,
  channelConflicts: 0,
  newCustomerCollectedCents: 0,
  newCustomerAcvCents: 0,
  collectedCents: 0,
  refundsCents: 0,
  openExceptions: 0,
  atRiskCents: 0,
});

describe("attention flags use the same rule", () => {
  it("leaves branches with no spend counted out of the median instead of pulling it to $0", () => {
    // v3: median of [$0, $0, $100, $150] = $50, so both real branches read "2.0× / 3.0× median".
    const flags = attentionFlags([row("X1", 0, 4), row("X2", 0, 2), row("X3", 10_000, 1), row("X4", 15_000, 1)]);
    expect([...flags.values()].flat()).toEqual([]);
  });

  it("still flags a branch far above the median of branches that have a CAC (control)", () => {
    const flags = attentionFlags([row("X1", 10_000, 1), row("X2", 10_000, 1), row("X3", 30_000, 1)]);
    expect(flags.get("X3")).toEqual([{ code: "cac", label: "CAC 3.0× median" }]);
    expect(flags.get("X1")).toEqual([]);
  });
});
