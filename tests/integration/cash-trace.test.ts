import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { rollupBrand, traceAttribution, traceCash } from "@/lib/lineage/cash";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { BRANCH_BY_ID, BRANDS } from "@/lib/reference";
import { ForbiddenError, VIEWERS } from "@/lib/viewer";
import { acquisition, crm, freshDb, ingest, runReconcile, testPool } from "../helpers";

/**
 * The money traces as reference cases (Financial Evidence Graph 2.0). Collected cash is payments
 * minus refunds by payment date, in the CRM office's branch, to the cent, including a refund in a
 * later month than its sale and a partial refund with odd cents. Each trace reproduces the
 * scorecard exactly and its invariants hold; a brand is exactly its branches.
 */
const NOW = new Date("2026-10-31T13:00:00Z");
const at = (m: number, d: number) => new Date(Date.UTC(2026, m - 1, d, 16));
const { marketing, partner } = VIEWERS;

let pool: Pool;
beforeAll(async () => {
  pool = testPool();
  await freshDb(pool);
  // B05: three October customers. #1 paid $149.37 and got $49.99 back in October; #2 paid
  // $210.00 in September (sold in September) and was refunded $10.01 in October; #3 has a
  // voided payment of $75.00 (no money moved) and a call with no tracking (channel unknown).
  const sales = [
    { n: 1, m: 10, d: 4, amount: "149.37", source: "Google Ads" },
    { n: 2, m: 9, d: 20, amount: "210.00", source: "Google LSA" },
    { n: 3, m: 10, d: 12, amount: "75.00", source: "Direct" },
  ];
  for (const s of sales) {
    const won = acquisition(s.n, "B05", `+1480556${String(1000 + s.n)}`, at(s.m, s.d), { source: s.source, amount: s.amount });
    if (s.n === 3) won.crm[5] = crm.payment(5003, 1003, 4003, "B05", "75.00", at(10, 15), "0");
    await ingest(pool, "calls", [won.call], { now: NOW });
    await ingest(pool, "crm", won.crm, { now: NOW });
  }
  await ingest(pool, "crm", [crm.payment(9001, 1001, 4001, "B05", "-49.99", at(10, 20), "1", "5001"), crm.payment(9002, 1002, 4002, "B05", "-10.01", at(10, 21), "1", "5002")], { now: NOW });
  await runReconcile(pool, NOW);
}, 120_000);
afterAll(async () => pool?.end());

describe("collected cash, refunds and new-customer collections", () => {
  it("reproduces the scorecard to the cent, with refunds in the month they were paid out", async () => {
    const t = await traceCash(pool, marketing, { branchId: "B05", period: PERIODS.oct });
    // October: +$149.37 (#1, Oct 6) − $49.99 − $10.01 = $89.37; the September $210.00 is September's.
    expect(t.value.reproduced).toMatchObject({ grossCents: 14_937, refundsCents: 6_000, collectedCents: 8_937 });
    expect(t.value.matches).toBe(true);
    expect(t.value.reproduced.collectedCents).toBe(t.value.scorecard.collectedCents);
    expect(t.payments).toMatchObject({ count: 3, refunds: 2 });
    expect(t.payments.rows.filter((r) => r.kind === "refund").map((r) => [r.amountCents, r.originalPaymentId])).toEqual([[-4_999, 5001], [-1_001, 5002]]);
    expect(t.excluded).toEqual([expect.objectContaining({ code: "NOT_SUCCESSFUL", count: 1, amountCents: 7_500 })]);
    expect(t.invariants.every((i) => i.holds)).toBe(true);
    const sep = await traceCash(pool, marketing, { branchId: "B05", period: PERIODS.sep });
    expect(sep.value.reproduced).toMatchObject({ grossCents: 21_000, refundsCents: 0, collectedCents: 21_000 });
  });

  it("collected from new customers counts each October customer's payments to date, refunds included", async () => {
    const t = await traceCash(pool, marketing, { branchId: "B05", period: PERIODS.oct });
    // October's new customers are #1 and #3 (#2 was serviced in September): $149.37 − $49.99; #3 paid nothing.
    expect(t.newCustomers).toMatchObject({ count: 2, collectedCents: 9_938 });
    expect(t.value.scorecard.newCollectedCents).toBe(9_938);
  });

  it("is refused outside the viewer's scope", async () => {
    await expect(traceCash(pool, partner, { branchId: "B05", period: PERIODS.oct })).rejects.toThrow(ForbiddenError);
  });
});

describe("attribution coverage and unknown share", () => {
  it("partitions the new customers by channel and reproduces the unknown share", async () => {
    const t = await traceAttribution(pool, marketing, { branchId: "B05", period: PERIODS.oct });
    expect(t.value.matches).toBe(true);
    expect(t.value.reproduced).toMatchObject({ acquired: 2, unknownAcquired: 1, unknownShare: 0.5, coverage: 0.5 });
    expect(t.byChannel.map((c) => [c.channelCode, c.customers]).sort()).toEqual([["google_search", 1], ["unknown", 1]]);
    expect(t.invariants.every((i) => i.holds)).toBe(true);
  });
});

describe("brand rollups", () => {
  it("are exactly their branches, CAC from summed parts, and the brands partition the company to the cent", async () => {
    const brand = BRANCH_BY_ID.get("B05")!.brandId;
    const r = await rollupBrand(pool, marketing, { brandId: brand, period: PERIODS.oct });
    expect(r.invariants.every((i) => i.holds)).toBe(true);
    const rows = await branchRows(pool, { from: PERIODS.oct.from, to: PERIODS.oct.to, branchIds: null });
    const company = rows.reduce((t, x) => t + x.collectedCents, 0);
    let summed = 0;
    for (const b of BRANDS) summed += (await rollupBrand(pool, marketing, { brandId: b.id, period: PERIODS.oct })).totals.collectedCents;
    expect(summed).toBe(company);
    expect(r.totals.collectedCents).toBe(8_937);
    await expect(rollupBrand(pool, partner, { brandId: brand, period: PERIODS.oct })).rejects.toThrow(ForbiddenError);
  });
});

// Last: these break the shared world on purpose.
describe("invariants that can fail (review 2026-11-12, financial 13)", () => {
  it("a refund against a voided payment is a refund beyond what was paid", async () => {
    await ingest(pool, "crm", [crm.payment(9003, 1003, 4003, "B05", "-5.00", at(10, 22), "1", "5003")], { now: NOW });
    const t = await traceCash(pool, marketing, { branchId: "B05", period: PERIODS.oct });
    expect(t.invariants.find((i) => i.name === "no payment is refunded beyond what was paid")).toMatchObject({ holds: false });
  });

  it("cash from a CRM office no branch owns breaks the brand partition", async () => {
    // A stored payment in an office no branch owns (as a CRM office added before its branch is).
    await pool.query(
      `insert into crm_payments (crm_payment_id, crm_customer_id, office_id, amount_cents, status, paid_at, source_updated_at, raw_event_id)
       values (9100, 1001, 999999, 2000, 'successful', $1, $1, (select min(id) from raw_events))`,
      [at(10, 23)],
    );
    const brand = BRANCH_BY_ID.get("B05")!.brandId;
    const r = await rollupBrand(pool, marketing, { brandId: brand, period: PERIODS.oct });
    expect(r.invariants.find((i) => i.name === "the brands partition the company (collected cash)")).toMatchObject({ holds: false });
  });
});
