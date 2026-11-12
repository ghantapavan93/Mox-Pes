import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { decideIdentityConflict, resolveIdentities } from "@/lib/identity";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { acquisition, freshDb, ingest, one, testPool } from "../helpers";

/**
 * One paid call must not credit two customers (independent review 2026-11-12, finding 1).
 * Attribution matched a customer to a lead by phone or email alone, so a call from a phone that
 * two CRM customers share became the paid first touch of both: paid customers were inflated and
 * paid CAC understated (SR-4). A lead that matches more than one customer is ambiguous and
 * credits none of them until a reviewer accepts the pair.
 */
const NOW = new Date("2026-10-31T13:00:00Z");
const at = (d: number) => new Date(Date.UTC(2026, 9, d, 16));
const SHARED = "+14805557001";

let pool: Pool;
beforeEach(async () => {
  pool ??= testPool();
  await freshDb(pool);
}, 60_000);
afterAll(async () => pool?.end());

async function oct(branchId = "B12") {
  const [row] = await branchRows(pool, { from: PERIODS.oct.from, to: PERIODS.oct.to, branchIds: [branchId] });
  return row;
}

describe("a lead that matches more than one customer", () => {
  it("credits neither customer sharing its phone, while a customer with their own phone keeps the credit", async () => {
    const first = acquisition(1, "B12", SHARED, at(10));
    const second = acquisition(2, "B12", SHARED, at(12));
    const own = acquisition(3, "B12", "+14805557003", at(14));
    // One paid call from the shared phone; the second customer made no call of their own.
    await ingest(pool, "calls", [first.call, own.call], { now: NOW });
    await ingest(pool, "crm", [...first.crm, ...second.crm, ...own.crm], { now: NOW });

    const row = await oct();
    expect(row.acquired).toBe(3);
    // Only the customer whose phone is theirs alone is credited to the paid call.
    expect(row.paidAcquired).toBe(1);
  });

  it("credits the customer a reviewer accepts, and only that one", async () => {
    const first = acquisition(1, "B12", SHARED, at(10));
    const second = acquisition(2, "B12", SHARED, at(12));
    await ingest(pool, "calls", [first.call], { now: NOW });
    await ingest(pool, "crm", [...first.crm, ...second.crm], { now: NOW });
    await resolveIdentities(pool, NOW);

    const conflict = await one<{ id: string }>(
      pool,
      "select k.id from identity_conflicts k join leads l on l.id = k.lead_id where l.source_lead_id = $1 and k.crm_customer_id = $2 and k.status = 'pending'",
      [(first.call.payload as { id: string }).id, first.customerId],
    );
    expect(conflict).toBeTruthy();
    await decideIdentityConflict(pool, { conflictId: Number(conflict.id), decision: "accept", reason: "Customer confirmed the call on the phone", actor: "test:reviewer", now: NOW });

    const row = await oct();
    expect(row.acquired).toBe(2);
    expect(row.paidAcquired).toBe(1);
  });
});
