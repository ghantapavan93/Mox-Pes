import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { withTransaction } from "@/lib/db";
import { ingestRecords } from "@/lib/ingest/ingest";
import { projectAll, type ProjectionItem } from "@/lib/ingest/project";
import { traceCash } from "@/lib/lineage/cash";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { VIEWERS } from "@/lib/viewer";
import { acquisition, crm, freshDb, ingest, one, testPool } from "../helpers";

/**
 * R-37: payment versions and cash.
 *
 * FieldRoutes payments carry no `dateUpdated` (the verified legacy contract; the current docs are
 * said to add one, unconfirmed on a real tenant), so a payment version is identified by its
 * content and ordered by when it was observed. A poll returns the vendor's current state, so a
 * later observation of a NEW version is authoritative and applies, including a correction after a
 * void. What the ledger cannot tell apart is a stale replica re-serving an EARLIER version (the
 * mock's `out_of_order` fault) from a real reversal. The rule: an earlier version observed again
 * after a later one never adds cash back silently. It is logged as a delivery, the later state
 * stays, and a conflict is raised for a person. One that removes cash (a void seen again) applies.
 */

const pool: Pool = testPool();
afterAll(async () => pool.end());

const T = (h: number) => new Date(Date.UTC(2026, 9, 10, 15) + h * 3_600_000);
const ACQ = acquisition(1, "B01", "+12125550171", new Date("2026-10-05T15:00:00Z"));
const PAY = 7201;

/** A version of payment 7201 on the acquisition's ticket. "2" is the CRM's voided status. */
function pay(status: "1" | "0" | "2", amount = "149.00"): RawRecord {
  const r = crm.payment(PAY, ACQ.customerId, ACQ.ticketId, "B01", amount, new Date("2026-10-07T17:00:00Z"));
  (r.payload as Record<string, unknown>).status = status;
  return r;
}
function refund(id: number, amount: string): RawRecord {
  return crm.payment(id, ACQ.customerId, ACQ.ticketId, "B01", amount, new Date("2026-10-08T17:00:00Z"), "1", String(PAY));
}

const live = (id = PAY) => one<{ status: string; amount_cents: string }>(pool, "select status, amount_cents from crm_payments where crm_payment_id = $1", [id]);
const collected = async () => (await branchRows(pool, { ...PERIODS.oct, branchIds: null })).find((r) => r.branchId === "B01")!.collectedCents;
const conflicts = async () => (await pool.query<{ summary: string; evidence: Record<string, unknown> }>("select summary, evidence from exceptions where kind = 'payload_conflict' order by id")).rows;

/** One delivery in its own transaction, as one poll writes it. */
const deliver = (r: RawRecord, now: Date) =>
  withTransaction(pool, (tx) => ingestRecords(tx, { source: "crm", records: [r], mapper: mapperFor("crm"), ctx: referenceContext, runId: null, now }));

/** Resolves once a backend in this database waits on a row lock, read from Postgres's own wait state. */
async function waitingOnRowLock(): Promise<void> {
  for (let i = 0; i < 250; i++) {
    const r = await pool.query("select 1 from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock' and wait_event in ('transactionid', 'tuple')");
    if (r.rowCount) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error("no delivery is waiting on the held transaction's row lock");
}

/**
 * Delivers `first` in a transaction held open, starts `second`, and commits `first` only once
 * `second` is shown waiting on its row lock: the order of events is the one the test names, every
 * run. Returns what `second` returned.
 */
async function whileHeldOpen<T>(first: RawRecord, at: Date, second: () => Promise<T>): Promise<T> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    await ingestRecords(client, { source: "crm", records: [first], mapper: mapperFor("crm"), ctx: referenceContext, runId: null, now: at });
    const pending = second();
    pending.catch(() => undefined); // awaited below; not an unhandled rejection while it waits
    await waitingOnRowLock();
    await client.query("commit");
    return await pending;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

beforeEach(async () => {
  await freshDb(pool);
  // The acquisition without its own payment: the tests deliver payment 7201's versions.
  await ingest(pool, "crm", ACQ.crm.slice(0, 5), { now: T(0) });
});

describe("R-37 · payment versions never resurrect cash", () => {
  it("a valid payment counts; its void removes it", async () => {
    await ingest(pool, "crm", [pay("1")], { now: T(1) });
    expect(await collected()).toBe(14_900);
    await ingest(pool, "crm", [pay("2")], { now: T(2) });
    expect(await live()).toMatchObject({ status: "voided" });
    expect(await collected()).toBe(0);
  });

  it("an earlier successful copy delivered after the void does not count as cash again", async () => {
    await ingest(pool, "crm", [pay("1")], { now: T(1) });
    await ingest(pool, "crm", [pay("2")], { now: T(2) });
    const stats = await ingest(pool, "crm", [pay("1")], { now: T(3) }); // a stale replica re-serves the first version
    expect(stats).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(await live()).toMatchObject({ status: "voided" });
    expect(await collected()).toBe(0);
    // Logged, not dropped: the delivery is counted and a person sees the conflict.
    expect(await one(pool, "select delivery_count::int as n from raw_events where entity_id = $1 and payload->>'status' = '1'", [String(PAY)])).toEqual({ n: 2 });
    const [c] = await conflicts();
    expect(c.summary).toMatch(/earlier version of payment 7201 .* would add \$149\.00 of cash back/);
    expect(c.evidence).toMatchObject({ conflict: "earlier_version_after_later", liveStatus: "voided", incomingStatus: "successful", cashCentsHeld: 14_900 });
  });

  it("the same rule inside one batch: successful, void, successful again ends voided", async () => {
    await ingest(pool, "crm", [pay("1"), pay("2"), pay("1")], { now: T(1) });
    expect(await live()).toMatchObject({ status: "voided" });
    expect(await collected()).toBe(0);
    expect(await conflicts()).toHaveLength(1);
  });

  it("a duplicate void is one void: counted twice, no conflict", async () => {
    await ingest(pool, "crm", [pay("1")], { now: T(1) });
    await ingest(pool, "crm", [pay("2")], { now: T(2) });
    await ingest(pool, "crm", [pay("2")], { now: T(3) });
    expect(await live()).toMatchObject({ status: "voided" });
    expect(await one(pool, "select delivery_count::int as n from raw_events where entity_id = $1 and payload->>'status' = '2'", [String(PAY)])).toEqual({ n: 2 });
    expect(await conflicts()).toHaveLength(0);
  });

  it("a pre-void version the ledger never saw, re-served after the void, is held too", async () => {
    // The first poll saw the payment already voided; a stale replica then serves the version
    // before the void: the same payment with only its status put back.
    await ingest(pool, "crm", [pay("2")], { now: T(1) });
    await ingest(pool, "crm", [pay("1")], { now: T(2) });
    expect(await live()).toMatchObject({ status: "voided" });
    expect(await collected()).toBe(0);
    expect((await conflicts())[0].evidence).toMatchObject({ conflict: "earlier_version_after_later", liveStatus: "voided", incomingStatus: "successful" });
  });

  it("an earlier void seen again after a correction removes the cash: lowering cash is never held", async () => {
    await ingest(pool, "crm", [pay("2")], { now: T(1) });
    await ingest(pool, "crm", [pay("1", "139.00")], { now: T(2) }); // a correction: the amount changed too
    expect(await collected()).toBe(13_900);
    await ingest(pool, "crm", [pay("2")], { now: T(3) });
    expect(await live()).toMatchObject({ status: "voided" });
    expect(await conflicts()).toHaveLength(0);
  });

  it("out-of-order amount revisions: an earlier, larger amount re-served after a correction is held", async () => {
    await ingest(pool, "crm", [pay("1", "149.00")], { now: T(1) });
    await ingest(pool, "crm", [pay("1", "139.00")], { now: T(2) });
    await ingest(pool, "crm", [pay("1", "149.00")], { now: T(3) });
    expect(await live()).toMatchObject({ status: "successful", amount_cents: "13900" });
    expect(await conflicts()).toHaveLength(1);
  });

  it("a correction after a void is a new version from the source and applies", async () => {
    await ingest(pool, "crm", [pay("1")], { now: T(1) });
    await ingest(pool, "crm", [pay("2")], { now: T(2) });
    await ingest(pool, "crm", [pay("1", "99.00")], { now: T(3) });
    expect(await live()).toMatchObject({ status: "successful", amount_cents: "9900" });
    expect(await collected()).toBe(9_900);
    expect(await conflicts()).toHaveLength(0);
  });

  it("a refund after the payment nets it; an earlier, smaller refund re-served is held", async () => {
    await ingest(pool, "crm", [pay("1")], { now: T(1) });
    await ingest(pool, "crm", [refund(7202, "-40.00")], { now: T(2) });
    await ingest(pool, "crm", [refund(7202, "-50.00")], { now: T(3) }); // the refund corrected upward
    expect(await collected()).toBe(9_900);
    await ingest(pool, "crm", [refund(7202, "-40.00")], { now: T(4) }); // stale: would add $10 back
    expect(await live(7202)).toMatchObject({ amount_cents: "-5000" });
    expect(await collected()).toBe(9_900);
    expect(await conflicts()).toHaveLength(1);
  });

  it("crash and replay: a committed batch delivered again changes nothing", async () => {
    const batch = [pay("1"), pay("2")];
    await ingest(pool, "crm", batch, { now: T(1) });
    const before = await one(pool, "select status, amount_cents, raw_event_id from crm_payments where crm_payment_id = $1", [PAY]);
    await ingest(pool, "crm", batch, { now: T(2) }); // the run committed, crashed before acknowledging, re-ran
    expect(await one(pool, "select status, amount_cents, raw_event_id from crm_payments where crm_payment_id = $1", [PAY])).toEqual(before);
    expect(await collected()).toBe(0);
    expect(await conflicts()).toHaveLength(1); // the replayed successful copy after the void, once
  });

  it("concurrent deliveries of a stale copy and the void end voided, whatever commits first", async () => {
    await ingest(pool, "crm", [pay("1")], { now: T(1) });
    await Promise.all([deliver(pay("2"), T(2)), deliver(pay("1"), T(3))]);
    await deliver(pay("1"), T(4));
    expect(await live()).toMatchObject({ status: "voided" });
    expect(await collected()).toBe(0);
  });

  // The two orders of the race above, staged so each runs every time.
  it("a stale copy waiting on the void's row lock is held once the void commits", async () => {
    await ingest(pool, "crm", [pay("1")], { now: T(1) });
    const stats = await whileHeldOpen(pay("2"), T(2), () => deliver(pay("1"), T(3)));
    expect(stats).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(await live()).toMatchObject({ status: "voided" });
    expect(await collected()).toBe(0);
    const [c] = await conflicts();
    expect(c?.evidence).toMatchObject({ conflict: "earlier_version_after_later", liveStatus: "voided", incomingStatus: "successful" });
  });

  it("a void waiting on a stale copy's row lock applies once the copy commits", async () => {
    await ingest(pool, "crm", [pay("1")], { now: T(1) });
    await whileHeldOpen(pay("1"), T(2), () => deliver(pay("2"), T(3)));
    expect(await live()).toMatchObject({ status: "voided" });
    expect(await collected()).toBe(0);
    expect(await conflicts()).toHaveLength(0);
  });

  it("full re-projection from the raw ledger, by observation, gives the same payments", async () => {
    await ingest(pool, "crm", [pay("1")], { now: T(1) });
    await ingest(pool, "crm", [pay("2")], { now: T(2) });
    await ingest(pool, "crm", [pay("1")], { now: T(3) });
    const incremental = await one(pool, "select status, amount_cents, raw_event_id from crm_payments where crm_payment_id = $1", [PAY]);
    await withTransaction(pool, async (tx) => {
      await tx.query("delete from crm_payments");
      const raw = await tx.query<{ id: string; entity: string; payload: unknown; at: Date }>(
        "select id, entity, payload, last_delivered_at as at from raw_events where source = 'crm' and entity = 'payment' and status = 'projected' order by last_delivered_at, id",
      );
      const items: ProjectionItem[] = [];
      for (const row of raw.rows) {
        const m = mapperFor("crm").map({ entity: row.entity, payload: row.payload }, { ...referenceContext, receivedAt: row.at });
        if (m.ok) items.push({ projection: m.projection, rawEventId: Number(row.id) });
      }
      await projectAll(tx, items);
    });
    expect(await one(pool, "select status, amount_cents, raw_event_id from crm_payments where crm_payment_id = $1", [PAY])).toEqual(incremental);
  });

  it("the cash trace reproduces the scorecard after a held stale copy", async () => {
    await ingest(pool, "crm", [pay("1")], { now: T(1) });
    await ingest(pool, "crm", [refund(7202, "-40.00")], { now: T(2) });
    await ingest(pool, "crm", [pay("2")], { now: T(3) });
    await ingest(pool, "crm", [pay("1")], { now: T(4) });
    const t = await traceCash(pool, VIEWERS.engineer, { branchId: "B01", period: PERIODS.oct });
    expect(t.value.matches).toBe(true);
    expect(t.value.reproduced.collectedCents).toBe(await collected());
    expect(t.excluded).toEqual(expect.arrayContaining([expect.objectContaining({ code: "NOT_SUCCESSFUL", count: 1, amountCents: 14_900 })]));
  });
});
