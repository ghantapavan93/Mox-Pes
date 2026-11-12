import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { decideIdentityConflict, resolveIdentities } from "@/lib/identity";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { acquisition, call, freshDb, ingest, one, testPool } from "../helpers";

/**
 * A lead credits at most one customer (SR-4; independent review 2026-11-12, finding 1).
 * Attribution matched a customer to a lead by phone or email alone, so ONE call from a phone two
 * CRM customers share became the paid first touch of both: paid customers inflated, paid CAC
 * understated. Migrations 0022 then 0024: a reviewer's decision wins; otherwise the lead belongs
 * to the first sale it preceded. Customers who each made their own call keep their own calls
 * (the investigator held-out set, IV-44 and IV-46, written blind, expects exactly that).
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
const channelOf = async (customerId: number) => (await one<{ channel_code: string }>(pool, "select channel_code from v_acquisitions where crm_customer_id = $1", [customerId])).channel_code;

describe("a lead credits at most one customer", () => {
  it("one call from a shared phone credits the first customer it reached, not both", async () => {
    const first = acquisition(1, "B12", SHARED, at(10));
    const second = acquisition(2, "B12", SHARED, at(12));
    const own = acquisition(3, "B12", "+14805557003", at(14));
    // One paid call from the shared phone; the second customer made no call of their own.
    await ingest(pool, "calls", [first.call, own.call], { now: NOW });
    await ingest(pool, "crm", [...first.crm, ...second.crm, ...own.crm], { now: NOW });

    const row = await oct();
    expect(row.acquired).toBe(3);
    expect(row.paidAcquired).toBe(2); // before the fix: 3
    expect(await channelOf(first.customerId)).not.toBe("unknown");
    expect(await channelOf(second.customerId)).toBe("unknown");
  });

  it("two customers who each called from the shared phone keep their own calls", async () => {
    const first = acquisition(1, "B12", SHARED, at(6));
    const second = acquisition(2, "B12", SHARED, at(19));
    // Each customer's own call: Google before the first, Meta before the second.
    const meta = call("CAL-META-2", "B12", SHARED, new Date(at(19).getTime() - 3_600_000), "Facebook");
    await ingest(pool, "calls", [first.call, meta], { now: NOW });
    await ingest(pool, "crm", [...first.crm, ...second.crm], { now: NOW });

    const row = await oct();
    expect(row.paidAcquired).toBe(2);
    const firstLead = (await one<{ lead_id: string }>(pool, "select lead_id from v_acquisitions where crm_customer_id = $1", [first.customerId])).lead_id;
    const secondLead = (await one<{ lead_id: string }>(pool, "select lead_id from v_acquisitions where crm_customer_id = $1", [second.customerId])).lead_id;
    expect(firstLead).not.toBe(secondLead);
  });

  it("a reviewer can give the call to the other customer, and then only that one is credited", async () => {
    const first = acquisition(1, "B12", SHARED, at(10));
    const second = acquisition(2, "B12", SHARED, at(12));
    await ingest(pool, "calls", [first.call], { now: NOW });
    await ingest(pool, "crm", [...first.crm, ...second.crm], { now: NOW });
    await resolveIdentities(pool, NOW);

    const conflict = await one<{ id: string }>(
      pool,
      "select k.id from identity_conflicts k join leads l on l.id = k.lead_id where l.source_lead_id = $1 and k.crm_customer_id = $2 and k.status = 'pending'",
      [(first.call.payload as { id: string }).id, second.customerId],
    );
    expect(conflict).toBeTruthy();
    await decideIdentityConflict(pool, { conflictId: Number(conflict.id), decision: "accept", reason: "The second customer confirmed the call", actor: "test:reviewer", now: NOW });

    const row = await oct();
    expect(row.acquired).toBe(2);
    expect(row.paidAcquired).toBe(1);
    expect(await channelOf(second.customerId)).not.toBe("unknown");
    expect(await channelOf(first.customerId)).toBe("unknown");
  });
});
