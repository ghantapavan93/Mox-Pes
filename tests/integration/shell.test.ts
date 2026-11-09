import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { totals } from "@/lib/metrics/scorecard";
import { T0, acquisition, crm, freshDb, ingest, runReconcile, testPool } from "../helpers";

/**
 * Shell (Overview) regressions that need the database. The Overview headline splits revenue in
 * open exceptions into "cannot yet be tied" and "tied, but credit disputed"; these tests pin the
 * split that `totals()` returns, so the sentence on screen matches what is summed.
 */
const pool: Pool = testPool();
beforeEach(async () => freshDb(pool));
afterAll(async () => pool.end());

const OCT = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-31T00:00:00Z"), branchIds: null };
const at = (h: number) => new Date(T0.getTime() + h * 3_600_000);

describe("Overview: revenue in open exceptions", () => {
  it("separates disputed credit (branch mismatch, D2D / paid conflict) from revenue that is not tied at all", async () => {
    // Customer 1004 (B07): lead captured by B06, signed by a D2D rep after a paid touch → a branch
    // mismatch and a channel conflict. Tied to a branch and a channel; only the credit is disputed.
    const disputed = acquisition(4, "B07", "+12125550126", at(0));
    (disputed.call.payload as Record<string, unknown>).branch_tag = "B06";
    await ingest(pool, "calls", [disputed.call]);
    await ingest(pool, "d2d", [{ entity: "sale", payload: { saleId: "S-1", repId: "rep-1", branchId: "B07", signedAt: at(0.5).toISOString(), customer: { phone: "+12125550126", email: null, zip: "10001" } } }]);
    await ingest(pool, "crm", disputed.crm);

    // Customer 1005 (B01): paid, but the ticket the payment is applied to never arrived → the
    // revenue cannot yet be tied to the work (payment without ticket).
    const untied = acquisition(5, "B01", "+12125550127", at(0), { amount: "200.00" });
    await ingest(pool, "calls", [untied.call]);
    await ingest(pool, "crm", untied.crm.filter((r) => r.entity !== "ticket"));
    await runReconcile(pool);

    const kinds = (await pool.query("select kind from exceptions where status = 'open' order by kind")).rows.map((r) => r.kind);
    expect(kinds).toEqual(["branch_mismatch", "channel_conflict", "payment_without_ticket"]);
    const t = await totals(pool, OCT);
    expect(t.atRiskCents).toBe(34_900);
    expect(t.untiedCents).toBe(20_000);
    expect(t.creditDisputedCents).toBe(14_900);
    expect(t.untiedCents + t.creditDisputedCents).toBe(t.atRiskCents);
  });

  it("counts a customer in both a dispute and an untied exception once, as untied", async () => {
    const a = acquisition(4, "B07", "+12125550126", at(0));
    (a.call.payload as Record<string, unknown>).branch_tag = "B06";
    await ingest(pool, "calls", [a.call]);
    await ingest(pool, "crm", a.crm);
    // A second payment from the same customer, applied to a ticket that was never delivered.
    await ingest(pool, "crm", [crm.payment(5999, a.customerId, 9999, "B07", "10.00", at(60))]);
    await runReconcile(pool);

    const kinds = (await pool.query("select kind from exceptions where status = 'open' order by kind")).rows.map((r) => r.kind);
    expect(kinds).toEqual(["branch_mismatch", "payment_without_ticket"]);
    const t = await totals(pool, OCT);
    expect(t.atRiskCents).toBe(15_900); // 149.00 + 10.00, the customer once
    expect(t.untiedCents).toBe(15_900);
    expect(t.creditDisputedCents).toBe(0);
  });

  it("scopes the split to the viewer's branches", async () => {
    const a = acquisition(4, "B07", "+12125550126", at(0));
    (a.call.payload as Record<string, unknown>).branch_tag = "B06";
    await ingest(pool, "calls", [a.call]);
    await ingest(pool, "crm", a.crm);
    await runReconcile(pool);

    const b07 = await totals(pool, { ...OCT, branchIds: ["B07"] });
    expect(b07).toMatchObject({ atRiskCents: 14_900, untiedCents: 0, creditDisputedCents: 14_900 });
    const b01 = await totals(pool, { ...OCT, branchIds: ["B01"] });
    expect(b01).toMatchObject({ atRiskCents: 0, untiedCents: 0, creditDisputedCents: 0 });
  });
});
