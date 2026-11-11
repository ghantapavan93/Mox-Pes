import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { withTransaction } from "@/lib/db";
import { projectAll, type ProjectionItem } from "@/lib/ingest/project";
import { hashPhone } from "@/lib/primitives";
import { BRANCHES } from "@/lib/reference";
import { T0, crm, freshDb, ingest, one, testPool } from "../helpers";

/**
 * Model-based tests of the ledger lifecycle (Stage 1).
 *
 * For random delivery histories (out of order, duplicated, flipping between versions, split
 * into random batches), three things must agree:
 *   1. the incremental projection the intake builds,
 *   2. a pure reference model of the source semantics:
 *        CRM records with a version clock (dateUpdated): the newest version wins;
 *        payments (no version clock): the most recently OBSERVED content wins;
 *   3. a full rebuild from the raw ledger alone (projections emptied and re-derived).
 * A negative control shows the rebuild needs each version's last observation time: rebuilt
 * from first receipt alone, a flipped payment would come back wrong.
 */
const pool: Pool = testPool();
beforeEach(async () => freshDb(pool));
afterAll(async () => pool.end());

/** Small deterministic PRNG (mulberry32): the same seed always gives the same history. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (n: number) => Math.floor(next() * n), pick: <T,>(xs: T[]) => xs[Math.floor(next() * xs.length)] };
}

const hours = (h: number) => new Date(T0.getTime() + h * 3_600_000);

interface PaymentVersion {
  id: number;
  amount: string;
  status: "0" | "1" | "2";
  original: string;
}

/** Possible states of each payment: a void, an amount correction, a partial refund changing. */
const PAYMENTS: PaymentVersion[][] = [
  [{ id: 7001, amount: "149.00", status: "1", original: "0" }, { id: 7001, amount: "149.00", status: "2", original: "0" }, { id: 7001, amount: "139.00", status: "1", original: "0" }],
  [{ id: 7002, amount: "89.00", status: "1", original: "0" }, { id: 7002, amount: "89.00", status: "0", original: "0" }],
  [{ id: 7003, amount: "-50.00", status: "1", original: "7001" }, { id: 7003, amount: "-40.00", status: "1", original: "7001" }],
];
const CUSTOMERS = [1001, 1002];

/** The helper types successful and failed only; a voided version sets the CRM status "2" itself. */
function paymentRecord(v: PaymentVersion): RawRecord {
  const record = crm.payment(v.id, 1001, 4001, "B01", v.amount, hours(1), "1", v.original);
  (record.payload as Record<string, unknown>).status = v.status;
  return record;
}

function history(seed: number) {
  const r = rng(seed);
  const deliveries: Array<{ record: RawRecord; kind: "payment"; version: PaymentVersion } | { record: RawRecord; kind: "customer"; id: number; updated: number; phone: string }> = [];
  for (let i = 0; i < 14; i++) {
    if (r.next() < 0.7) {
      const v = r.pick(r.pick(PAYMENTS));
      deliveries.push({ kind: "payment", version: v, record: paymentRecord(v) });
    } else {
      const id = r.pick(CUSTOMERS);
      const updated = r.int(5); // five possible versions per customer, delivered in any order
      const phone = `+1212555${String(100 + id - 1000).slice(-2)}${updated}0`.slice(0, 12);
      deliveries.push({ kind: "customer", id, updated, phone, record: crm.customer(id, "B01", phone, hours(updated)) });
    }
  }
  const batches: Array<typeof deliveries> = [];
  for (let i = 0; i < deliveries.length; ) {
    const size = 1 + r.int(4);
    batches.push(deliveries.slice(i, i + size));
    i += size;
  }
  return { deliveries, batches };
}

/** The source semantics, as a fold over the deliveries in order. */
function model(deliveries: ReturnType<typeof history>["deliveries"]) {
  const payments = new Map<number, PaymentVersion>();
  const customers = new Map<number, { updated: number; phone: string }>();
  for (const d of deliveries) {
    if (d.kind === "payment") payments.set(d.version.id, d.version);
    else {
      const cur = customers.get(d.id);
      if (!cur || d.updated > cur.updated) customers.set(d.id, { updated: d.updated, phone: d.phone });
    }
  }
  return { payments, customers };
}

const STATUS = { "1": "successful", "0": "failed", "2": "voided" } as const;
const cents = (amount: string) => Math.round(Number(amount) * 100);

async function projectionState() {
  const payments = (await pool.query<{ id: string; amount_cents: string; status: string; raw_event_id: string }>("select crm_payment_id as id, amount_cents, status, raw_event_id from crm_payments order by 1")).rows;
  const customers = (await pool.query<{ id: string; phone_hash: string; source_updated_at: Date; raw_event_id: string }>("select crm_customer_id as id, phone_hash, source_updated_at, raw_event_id from crm_customers order by 1")).rows;
  return JSON.stringify({ payments, customers });
}

/** Empties the projections and re-derives them from the raw ledger, ordered by `clock`. */
async function rebuild(clock: "last_delivered_at" | "received_at") {
  await withTransaction(pool, async (tx) => {
    await tx.query("delete from crm_payments");
    await tx.query("delete from crm_customers");
    const raw = await tx.query<{ id: string; entity: string; payload: unknown; at: Date }>(
      `select id, entity, payload, ${clock} as at from raw_events where source = 'crm' and status = 'projected' order by ${clock}, id`,
    );
    const mapper = mapperFor("crm");
    const items: ProjectionItem[] = [];
    for (const row of raw.rows) {
      const m = mapper.map({ entity: row.entity, payload: row.payload }, { ...referenceContext, receivedAt: row.at });
      if (m.ok) items.push({ projection: m.projection, rawEventId: Number(row.id) });
    }
    await projectAll(tx, items);
  });
}

describe("ledger lifecycle · model-based", () => {
  const SEEDS = Array.from({ length: 24 }, (_, i) => i + 1);
  const controlDiffered: number[] = [];

  it.each(SEEDS)("seed %i: incremental projection = reference model = rebuild from the ledger", async (seed) => {
    const h = history(seed);
    for (const [b, batch] of h.batches.entries()) await ingest(pool, "crm", batch.map((d) => d.record), { now: hours(10 + b) });

    const expected = model(h.deliveries);
    for (const [id, v] of expected.payments) {
      const row = await one<{ amount_cents: string; status: string }>(pool, "select amount_cents, status from crm_payments where crm_payment_id = $1", [id]);
      expect({ id, amount: Number(row.amount_cents), status: row.status }).toEqual({ id, amount: cents(v.amount), status: STATUS[v.status] });
    }
    for (const [id, v] of expected.customers) {
      const row = await one<{ phone_hash: string; source_updated_at: Date }>(pool, "select phone_hash, source_updated_at from crm_customers where crm_customer_id = $1", [id]);
      expect({ id, phone: row.phone_hash }).toEqual({ id, phone: hashPhone(v.phone) });
    }
    expect(await one(pool, "select count(*)::int as n from crm_payments")).toEqual({ n: expected.payments.size });

    const incremental = await projectionState();
    await rebuild("last_delivered_at");
    expect(await projectionState()).toBe(incremental);

    await rebuild("received_at"); // negative control: first receipt alone is not enough
    if ((await projectionState()) !== incremental) controlDiffered.push(seed);
  });

  it("the negative control differs for some history (the observation clock is load-bearing)", () => {
    expect(controlDiffered.length).toBeGreaterThan(0);
  });
});

describe("ledger lifecycle · targeted cases", () => {
  it("an in-batch flip A, B, A of a payment ends on A, as it does across batches", async () => {
    const a = crm.payment(7101, 1001, 4001, "B01", "149.00", hours(1));
    const b = crm.payment(7101, 1001, 4001, "B01", "149.00", hours(1), "1");
    (b.payload as Record<string, unknown>).status = "2"; // voided
    await ingest(pool, "crm", [a, b, a]);
    expect(await one(pool, "select status from crm_payments where crm_payment_id = 7101")).toEqual({ status: "successful" });
    expect(await one(pool, "select delivery_count::int as n from raw_events where entity_id = '7101' and payload->>'status' = '1'")).toEqual({ n: 2 });
  });

  it("a CRM id arriving from another brand's office is quarantined instead of moving the customer", async () => {
    const home = BRANCHES.find((b) => b.id === "B01")!;
    const otherBrand = BRANCHES.find((b) => b.brandId !== home.brandId)!;
    const sameBrand = BRANCHES.find((b) => b.brandId === home.brandId && b.id !== home.id)!;
    await ingest(pool, "crm", [crm.customer(9001, home.id, "+12125550190", hours(1))]);
    // Same brand, another office: a reassignment, applied.
    await ingest(pool, "crm", [crm.customer(9001, sameBrand.id, "+12125550190", hours(2))]);
    expect(await one(pool, "select office_id from crm_customers where crm_customer_id = 9001")).toEqual({ office_id: sameBrand.crmOfficeId });
    // Another brand: refused, kept, explained; the customer stays where it was.
    await ingest(pool, "crm", [crm.customer(9001, otherBrand.id, "+12125550191", hours(3))]);
    expect(await one(pool, "select office_id from crm_customers where crm_customer_id = 9001")).toEqual({ office_id: sameBrand.crmOfficeId });
    const held = await one<{ status: string; error_code: string; error_detail: string }>(pool, "select status, error_code, error_detail from raw_events order by id desc limit 1");
    expect(held).toMatchObject({ status: "quarantined", error_code: "PROJECTION_FAILED" });
    expect(held.error_detail).toMatch(/two CRM accounts|cross-brand/);
  });
});
