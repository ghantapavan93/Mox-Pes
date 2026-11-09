import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { InMemorySourceClient } from "@/lib/sim/clients";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { runStream } from "@/lib/ingest/ingest";
import { branchRows, totals } from "@/lib/metrics/scorecard";
import { overrideLeadBranch } from "@/lib/actions";
import { ForbiddenError, VIEWERS, resolveScope } from "@/lib/viewer";
import { T0, acquisition, call, crm, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

const pool: Pool = testPool();
beforeEach(async () => freshDb(pool));
afterAll(async () => pool.end());

const OCT = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z"), branchIds: null };
const day = (n: number) => new Date(T0.getTime() + n * 86_400_000);

describe("exactly-once ingestion", () => {
  it("delivering the same batch three times changes nothing after the first", async () => {
    const a = acquisition(1, "B01", "+12125550101", day(0));
    for (let i = 0; i < 3; i++) {
      await ingest(pool, "calls", [a.call]);
      await ingest(pool, "crm", a.crm);
    }
    const counts = await one(pool, `select (select count(*) from leads) leads, (select count(*) from crm_payments) payments,
      (select count(*) from raw_events) raw, (select max(delivery_count) from raw_events) max_deliveries`);
    expect(counts).toMatchObject({ leads: "1", payments: "1", raw: "7", max_deliveries: 3 });
    const t = await totals(pool, OCT);
    expect(t.acquired).toBe(1);
    expect(t.newCustomerCollectedCents).toBe(14_900);
  });

  it("a retried payment never creates a second financial outcome", async () => {
    const a = acquisition(2, "B01", "+12125550102", day(0));
    await ingest(pool, "crm", a.crm);
    const payment = a.crm[5];
    await ingest(pool, "crm", [payment, payment, payment]);
    const { collected } = await one<{ collected: string }>(pool, "select sum(amount_cents) collected from crm_payments");
    expect(Number(collected)).toBe(14_900);
  });

  it("same version, different content → payload_conflict exception, first version kept", async () => {
    const ticket = crm.ticket(10, 1, 2, "B01", "149.00", day(0));
    const altered = crm.ticket(10, 1, 2, "B01", "174.00", day(0));
    await ingest(pool, "crm", [ticket]);
    const stats = await ingest(pool, "crm", [altered]);
    expect(stats.conflicts).toBe(1);
    expect((await one(pool, "select total_cents from crm_tickets")).total_cents).toBe("14900");
    expect((await one(pool, "select count(*) n from exceptions where kind = 'payload_conflict' and status = 'open'")).n).toBe("1");
  });
});

describe("validation and quarantine", () => {
  it("invalid records are quarantined, never projected, and stored without raw PII", async () => {
    const bad = call("CAL-X", "B20", "+12125550103", day(0));
    delete (bad.payload as Record<string, unknown>).customer_phone_number;
    (bad.payload as Record<string, unknown>).caller = { number: "(212) 555-0103" };
    const stats = await ingest(pool, "calls", [bad], { mapper: mapperFor("calls", "1.0") });
    expect(stats).toMatchObject({ inserted: 1, quarantined: 1, projected: 0 });
    expect((await one(pool, "select count(*) n from leads")).n).toBe("0");
    const raw = await one<{ status: string; error_code: string; payload: unknown }>(pool, "select status, error_code, payload from raw_events");
    expect(raw).toMatchObject({ status: "quarantined", error_code: "MISSING_FIELD" });
    expect(JSON.stringify(raw.payload)).not.toContain("555-0103");
  });

  it("a missing reference is an explicit exception, and it clears itself when the reference arrives (out of order)", async () => {
    const a = acquisition(3, "B01", "+12125550104", day(0));
    const [customer, sub, apptPending, apptDone, ticket, payment] = a.crm;
    await ingest(pool, "crm", [customer, sub, apptPending, apptDone, payment]); // ticket missing
    await runReconcile(pool, day(3));
    const open = await one(pool, "select kind, status, amount_cents from exceptions where kind = 'payment_without_ticket'");
    expect(open).toMatchObject({ status: "open", amount_cents: "14900" });
    await ingest(pool, "crm", [ticket]);
    await runReconcile(pool, day(4));
    expect((await one(pool, "select status, resolution from exceptions where kind = 'payment_without_ticket'"))).toMatchObject({ status: "resolved", resolution: "Condition no longer detected" });
  });

  it("an older version delivered late never overwrites a newer one", async () => {
    const a = acquisition(4, "B01", "+12125550105", day(0));
    const [, , apptPending, apptDone] = a.crm;
    await ingest(pool, "crm", [apptDone]);
    await ingest(pool, "crm", [apptPending]);
    expect((await one(pool, "select status from crm_appointments")).status).toBe("completed");
  });

  it("reconciliation is idempotent: running it twice yields the same exceptions", async () => {
    const a = acquisition(5, "B01", "+12125550106", day(0));
    await ingest(pool, "crm", a.crm.filter((r) => r.entity !== "ticket"));
    await runReconcile(pool);
    const first = await one(pool, "select count(*) n from exceptions");
    await runReconcile(pool);
    expect(await one(pool, "select count(*) n from exceptions")).toEqual(first);
  });
});

describe("partial failure is recoverable", () => {
  it("a failed run does not advance the cursor; the next run re-reads the missed window", async () => {
    const records = [{ stream: "calls", entity: "call", visibleAt: day(0).getTime(), payload: call("CAL-R", "B01", "+12125550107", day(0)).payload as Record<string, unknown> }];
    let fail = true;
    const client = new InMemorySourceClient("calls", "calls", records, () => (fail ? "HTTP 503" : null));
    const base = { client, mapper: mapperFor("calls"), ctx: referenceContext, overlapMs: 0, initialCursor: day(-1) };
    const r1 = await runStream(pool, { ...base, now: day(1), windowEnd: day(1) });
    expect(r1.status).toBe("failed");
    expect((await one(pool, "select count(*) n from source_cursors")).n).toBe("0");
    fail = false;
    const r2 = await runStream(pool, { ...base, now: day(2), windowEnd: day(2) });
    expect(r2).toMatchObject({ status: "succeeded", stats: { inserted: 1, projected: 1 } });
    expect((await one(pool, "select count(*) n from leads")).n).toBe("1");
  });
});

describe("attribution rules", () => {
  it("unknown attribution stays unknown — a Direct call is never credited to paid media", async () => {
    const a = acquisition(6, "B01", "+12125550108", day(0), { source: "Direct" });
    await ingest(pool, "calls", [a.call]);
    await ingest(pool, "crm", a.crm);
    const acq = await one(pool, "select channel_code, attribution_basis from v_acquisitions");
    expect(acq).toMatchObject({ channel_code: "unknown", attribution_basis: "lead_without_evidence" });
    expect((await totals(pool, OCT)).paidAcquired).toBe(0);
  });

  it("an existing customer adding a service is not a new acquisition", async () => {
    const a = acquisition(7, "B01", "+12125550109", day(0));
    await ingest(pool, "crm", a.crm);
    await ingest(pool, "crm", [crm.subscription(9007, a.customerId, "B01", day(10))]);
    expect((await totals(pool, OCT)).acquired).toBe(1);
  });

  it("revenue = successful payments minus refunds; failed payments never count", async () => {
    const a = acquisition(8, "B01", "+12125550110", day(0));
    await ingest(pool, "crm", a.crm);
    await ingest(pool, "crm", [
      crm.payment(6001, a.customerId, a.ticketId, "B01", "50.00", day(3), "0"), // failed
      crm.payment(6002, a.customerId, a.ticketId, "B01", "-49.00", day(5), "1", "5008"), // partial refund
    ]);
    const t = await totals(pool, OCT);
    expect(t.collectedCents).toBe(14_900 - 4_900);
    expect(t.refundsCents).toBe(4_900);
  });

  it("branch mismatch → exception; a recorded override resolves it and moves lead credit", async () => {
    const a = acquisition(9, "B07", "+12125550111", day(0));
    (a.call.payload as Record<string, unknown>).branch_tag = "B06"; // captured under the wrong branch
    await ingest(pool, "calls", [a.call]);
    await ingest(pool, "crm", a.crm);
    await runReconcile(pool);
    const ex = await one<{ status: string; evidence: Record<string, unknown> }>(pool, "select status, evidence from exceptions where kind = 'branch_mismatch'");
    expect(ex.status).toBe("open");
    await overrideLeadBranch(pool, { leadId: Number(ex.evidence.leadId), branchId: "B07", actor: "test", reason: "territory realignment", now: day(5) });
    expect((await one(pool, "select status from exceptions where kind = 'branch_mismatch'")).status).toBe("resolved");
    expect((await one(pool, "select count(*) n from audit_log where action = 'override_lead_branch'")).n).toBe("1");
  });
});

describe("branch scoping", () => {
  it("a scoped query returns only that branch's rows", async () => {
    for (const [n, b] of [[11, "B01"], [12, "B02"], [13, "B20"]] as const) {
      const a = acquisition(n, b, `+1212555011${n - 10}`, day(0));
      await ingest(pool, "calls", [a.call]);
      await ingest(pool, "crm", a.crm);
    }
    const rows = await branchRows(pool, { ...OCT, branchIds: ["B20"] });
    expect(rows.map((r) => r.branchId)).toEqual(["B20"]);
    const t = await totals(pool, { ...OCT, branchIds: ["B20"] });
    expect(t.acquired).toBe(1);
    expect(t.prospects).toBe(1);
  });

  it("a branch partner asking for another branch is refused, not silently filtered", () => {
    expect(() => resolveScope(VIEWERS.partner, "B01")).toThrow(ForbiddenError);
    expect(resolveScope(VIEWERS.partner, null)).toEqual(["B20"]);
    expect(resolveScope(VIEWERS.marketing, null)).toBeNull();
  });
});
