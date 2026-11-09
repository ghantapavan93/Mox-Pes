import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { mapperFor } from "@/lib/adapters/registry";
import { quarantineGroupIds, replay } from "@/lib/ingest/replay";
import { totals } from "@/lib/metrics/scorecard";
import { T0, acquisition, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

const pool: Pool = testPool();
afterAll(async () => pool.end());

const SCOPE = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z"), branchIds: ["B20"] };
const N = 12;

/** B20 sells N customers who called in; the call feed changed shape, so calls@1.0 quarantined every call. */
async function seedIncident(): Promise<number[]> {
  for (let n = 1; n <= N; n++) {
    const a = acquisition(n, "B20", `+1212555${String(100 + n).padStart(4, "0")}`, new Date(T0.getTime() + n * 3_600_000));
    const p = a.call.payload as Record<string, unknown>;
    p.caller = { number: p.customer_phone_number };
    delete p.customer_phone_number;
    await ingest(pool, "calls", [a.call], { mapper: mapperFor("calls", "1.0") });
    await ingest(pool, "crm", a.crm);
  }
  await runReconcile(pool);
  return quarantineGroupIds(pool, { source: "calls", errorCode: "MISSING_FIELD", branchId: "B20" });
}

const request = (ids: number[], key: string, dryRun = false, exceptionId?: number) =>
  replay(pool, { source: "calls", rawEventIds: ids, mapperVersion: "1.1", actor: "test", idempotencyKey: key, dryRun, now: T0, scope: SCOPE, exceptionId });

describe("replay", () => {
  beforeEach(async () => freshDb(pool));

  it("the incident is visible: customers exist but have no lead record, and an exception says why", async () => {
    const ids = await seedIncident();
    expect(ids).toHaveLength(N);
    const t = await totals(pool, SCOPE);
    expect(t).toMatchObject({ acquired: N, paidAcquired: 0, unknownAcquired: N });
    const ex = await one<{ severity: string; evidence: Record<string, number> }>(pool, "select severity, evidence from exceptions where kind = 'quarantined_source_records'");
    expect(ex.severity).toBe("high");
    expect(ex.evidence.customersWithoutLead).toBe(N);
  });

  it("dry run changes nothing", async () => {
    const ids = await seedIncident();
    const r = await request(ids, "dry-run-key-1", true);
    expect(r).toMatchObject({ dryRun: true, claimed: N, projected: N });
    expect(r.after?.paidAcquired).toBe(N);
    expect((await one(pool, "select count(*) n from raw_events where status = 'quarantined'")).n).toBe(String(N));
    expect((await one(pool, "select count(*) n from replays")).n).toBe("0");
    expect((await totals(pool, SCOPE)).paidAcquired).toBe(0);
  });

  it("replay restores attribution, recomputes metrics, resolves the exception — and leaves spend and revenue untouched", async () => {
    const ids = await seedIncident();
    const before = await totals(pool, SCOPE);
    const { id } = await one<{ id: string }>(pool, "select id from exceptions where kind = 'quarantined_source_records'");
    const r = await request(ids, "replay-key-0001", false, Number(id));
    expect(r).toMatchObject({ claimed: N, projected: N, stillQuarantined: 0, alreadyProcessed: false });
    const after = await totals(pool, SCOPE);
    expect(after).toMatchObject({ paidAcquired: N, unknownAcquired: 0, acquired: before.acquired });
    expect(after.collectedCents).toBe(before.collectedCents);
    expect(after.paidSpendCents).toBe(before.paidSpendCents);
    expect((await one(pool, "select status, resolution from exceptions where kind = 'quarantined_source_records'"))).toMatchObject({
      status: "resolved",
      resolution: expect.stringContaining("calls@1.1"),
    });
  });

  it("the same idempotency key returns the stored result and runs nothing", async () => {
    const ids = await seedIncident();
    await request(ids, "replay-key-0002");
    const again = await request(ids, "replay-key-0002");
    expect(again).toMatchObject({ alreadyProcessed: true, claimed: N });
    expect((await one(pool, "select count(*) n from replays")).n).toBe("1");
    expect((await one(pool, "select count(*) n from leads")).n).toBe(String(N));
  });

  it("a new request after success claims nothing and changes nothing", async () => {
    const ids = await seedIncident();
    await request(ids, "replay-key-0003");
    const snapshot = await totals(pool, SCOPE);
    const second = await request(ids, "replay-key-0004");
    expect(second).toMatchObject({ claimed: 0, projected: 0 });
    expect(await totals(pool, SCOPE)).toEqual(snapshot);
  });

  it("concurrent replays with different keys claim each record exactly once (real Postgres row locks)", async () => {
    const ids = await seedIncident();
    const results = await Promise.all(Array.from({ length: 4 }, (_, i) => request(ids, `race-key-000${i}`)));
    const claimed = results.reduce((a, r) => a + r.claimed, 0);
    expect(claimed).toBe(N);
    expect((await one(pool, "select count(*) n from leads")).n).toBe(String(N));
    expect((await totals(pool, SCOPE)).paidAcquired).toBe(N);
  });

  it("concurrent replays with the SAME key run once", async () => {
    const ids = await seedIncident();
    const results = await Promise.all(Array.from({ length: 4 }, () => request(ids, "same-key-race-01")));
    expect(results.filter((r) => !r.alreadyProcessed)).toHaveLength(1);
    expect((await one(pool, "select count(*) n from replays")).n).toBe("1");
  });

  it("replaying through the old mapper keeps records quarantined", async () => {
    const ids = await seedIncident();
    const r = await replay(pool, { source: "calls", rawEventIds: ids, mapperVersion: "1.0", actor: "test", idempotencyKey: "old-mapper-key", dryRun: false, now: T0, scope: SCOPE });
    expect(r).toMatchObject({ claimed: N, projected: 0, stillQuarantined: N });
    expect((await one(pool, "select count(*) n from raw_events where status = 'quarantined'")).n).toBe(String(N));
  });
});
