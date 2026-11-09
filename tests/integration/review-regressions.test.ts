import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { mapperFor } from "@/lib/adapters/registry";
import { acknowledgeException, overrideLeadBranch } from "@/lib/actions";
import { isRecordLevelError } from "@/lib/ingest/ingest";
import { quarantineGroupIds, replay } from "@/lib/ingest/replay";
import { branchRows, totals } from "@/lib/metrics/scorecard";
import { VIEWERS, viewerFromRole } from "@/lib/viewer";
import { T0, acquisition, call, crm, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * One test per finding in docs/review-senior-engineer.md, each reproducing the reviewer's
 * failing input. The finding id is in the test name.
 */
const pool: Pool = testPool();
beforeEach(async () => freshDb(pool));
afterAll(async () => pool.end());

const OCT = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-10-31T00:00:00Z"), branchIds: null };
const at = (h: number) => new Date(T0.getTime() + h * 3_600_000);

describe("review regressions", () => {
  it("F1: a record naming an unknown branch is quarantined and reconciliation keeps working", async () => {
    await ingest(pool, "calls", [call("CAL-B99", "B99", "+12125550120", T0)]);
    await expect(runReconcile(pool)).resolves.toBeDefined();
    const ex = await one(pool, "select branch_id, status from exceptions where kind = 'quarantined_source_records'");
    expect(ex).toMatchObject({ branch_id: null, status: "open" });
    // and later work still flows
    const a = acquisition(1, "B01", "+12125550121", T0);
    await ingest(pool, "crm", a.crm);
    await expect(runReconcile(pool)).resolves.toBeDefined();
  });

  it("F2: payment status void → successful → void ends voided; an amount correction is applied", async () => {
    const a = acquisition(2, "B01", "+12125550122", T0);
    await ingest(pool, "crm", a.crm.slice(0, 5));
    const pay = (status: "0" | "1", amount = "149.00") => {
      const r = crm.payment(7001, a.customerId, a.ticketId, "B01", amount, at(60), status === "0" ? "0" : "1");
      if (status === "0") (r.payload as Record<string, unknown>).status = "2"; // voided
      return r;
    };
    await ingest(pool, "crm", [pay("0")], { now: at(70) });
    await ingest(pool, "crm", [pay("1")], { now: at(71) });
    await ingest(pool, "crm", [pay("0")], { now: at(72) }); // same content as the first delivery
    expect((await one(pool, "select status from crm_payments where crm_payment_id = 7001")).status).toBe("voided");

    await ingest(pool, "crm", [pay("1", "99.00")], { now: at(73) });
    expect(await one(pool, "select status, amount_cents from crm_payments where crm_payment_id = 7001")).toMatchObject({ status: "successful", amount_cents: "9900" });
    expect((await one(pool, "select count(*) n from exceptions where kind = 'payload_conflict'")).n).toBe("0");
  });

  it("F3: spend totals do not depend on the database session time zone", async () => {
    const spend = (date: string, micros: string) => ({
      entity: "spend_day",
      payload: { platform: "google_ads", accountId: "GA-1", campaignId: "gs-B01", campaignName: "B01 | Search", date, costMicros: micros, clicks: 10, conversions: 1, fetchedAt: `${date}T23:00:00Z` },
    });
    await ingest(pool, "ads", [spend("2026-09-30", "100000000"), spend("2026-10-01", "200000000"), spend("2026-10-30", "300000000")]);
    await pool.query("insert into campaign_branch_map select id, 'B01', 'test', now() from ad_campaigns");
    const utc = await branchRows(pool, OCT);
    const client = await pool.connect();
    try {
      await client.query("set time zone 'America/Chicago'");
      const chicago = await branchRows(client, OCT);
      await client.query("set time zone 'Pacific/Kiritimati'");
      const plus14 = await branchRows(client, OCT);
      const b01 = (rows: typeof utc) => rows.find((r) => r.branchId === "B01")!.paidSpendCents;
      expect(b01(utc)).toBe(50_000);
      expect(b01(chicago)).toBe(50_000);
      expect(b01(plus14)).toBe(50_000);
    } finally {
      client.release();
    }
  });

  it("F4: a 10-digit costMicros is money, not a phone number; free-text contact details are removed", async () => {
    const stats = await ingest(pool, "ads", [{
      entity: "spend_day",
      payload: { platform: "google_ads", accountId: "GA-1", campaignId: "gs-B01", campaignName: "B01 | Search", date: "2026-10-02", costMicros: "2500000000", clicks: 10, conversions: 1, fetchedAt: "2026-10-03T06:00:00Z" },
    }]);
    expect(stats).toMatchObject({ projected: 1, quarantined: 0 });
    expect((await one(pool, "select cost_cents from ad_spend_daily")).cost_cents).toBe("250000");

    const noted = call("CAL-NOTE", "B01", "+12125550123", T0, "Direct", { agent_note: "call me back at (212) 555-0199 or jo@example.com" });
    await ingest(pool, "calls", [noted]);
    const stored = JSON.stringify((await one(pool, "select payload from raw_events where source = 'calls'")).payload);
    const lead = await one<{ heard_about_text: string }>(pool, "select heard_about_text from leads");
    expect(stored).not.toMatch(/555-0199|jo@example/);
    expect(lead.heard_about_text).toBe("call me back at [phone] or [email]");
  });

  it("F5: one out-of-range record is quarantined; the rest of its batch is projected", async () => {
    const a = acquisition(3, "B01", "+12125550124", T0);
    const huge = crm.customer(1, "B01", "+12125550125", T0);
    (huge.payload as Record<string, unknown>).customerID = "99999999999999999999";
    const stats = await ingest(pool, "crm", [huge, ...a.crm]);
    expect(stats.quarantined).toBe(1);
    expect(stats.projected).toBe(a.crm.length);
  });

  it("F6: no role cookie means a read-only guest, not a role that can act", () => {
    const v = viewerFromRole(undefined);
    expect(v.role).toBe("guest");
    // Every permission, including the ones the Action Center, connectors and identity review
    // added to the Permissions type, is false for a guest.
    expect(v.can).toEqual({
      replay: false, decide: false, closeConflicts: false,
      investigate: false, propose: false, dryRun: false, approve: false, sync: false, reviewIdentity: false,
    });
    expect(viewerFromRole("toString").role).toBe("guest"); // prototype keys are not roles
    expect(viewerFromRole("engineer")).toBe(VIEWERS.engineer);
  });

  it("F7: revenue at risk counts a customer once across exception kinds, and company-wide exceptions count", async () => {
    // B07 customer, lead captured by B06, signed by a D2D rep after a paid touch → two exceptions, one customer
    const a = acquisition(4, "B07", "+12125550126", at(0));
    (a.call.payload as Record<string, unknown>).branch_tag = "B06";
    await ingest(pool, "calls", [a.call]);
    await ingest(pool, "d2d", [{ entity: "sale", payload: { saleId: "S-1", repId: "rep-1", branchId: "B07", signedAt: at(0.5).toISOString(), customer: { phone: "+12125550126", email: null, zip: "10001" } } }]);
    await ingest(pool, "crm", a.crm);
    await ingest(pool, "ads", [{ entity: "spend_day", payload: { platform: "google_lsa", accountId: "X", campaignId: "lsa-x", campaignName: "unmapped", date: "2026-10-02", costMicros: "5000000000", clicks: 1, conversions: 0, fetchedAt: "2026-10-03T06:00:00Z" } }]);
    await runReconcile(pool);
    const kinds = (await pool.query("select kind from exceptions where status = 'open' order by kind")).rows.map((r) => r.kind);
    expect(kinds).toEqual(["branch_mismatch", "channel_conflict", "unmapped_spend"]);
    const t = await totals(pool, OCT);
    expect(t.openExceptions).toBe(3);
    expect(t.atRiskCents).toBe(14_900); // the customer's revenue, once
  });

  it("F8: an idempotency key reused for a different replay request is refused", async () => {
    const bad = call("CAL-F8", "B20", "+12125550127", T0);
    const p = bad.payload as Record<string, unknown>;
    p.caller = { number: p.customer_phone_number };
    delete p.customer_phone_number;
    await ingest(pool, "calls", [bad], { mapper: mapperFor("calls", "1.0") });
    const ids = await quarantineGroupIds(pool, { source: "calls", errorCode: "MISSING_FIELD", branchId: "B20" });
    const base = { source: "calls" as const, rawEventIds: ids, actor: "t", idempotencyKey: "key-f8-0001", dryRun: false, now: T0, scope: { ...OCT, branchIds: ["B20"] } };
    await replay(pool, { ...base, mapperVersion: "1.1", exceptionId: 1 });
    await expect(replay(pool, { ...base, mapperVersion: "1.0", exceptionId: 1 })).rejects.toThrow(/different replay request/);
    await expect(replay(pool, { ...base, mapperVersion: "1.1", exceptionId: 1 })).resolves.toMatchObject({ alreadyProcessed: true });
  });

  it("F9: a call updated after the fact (attribution added) is a new version, not a conflict", async () => {
    const first = call("CAL-F9", "B01", "+12125550128", T0, "Direct");
    const updated = call("CAL-F9", "B01", "+12125550128", T0, "Google Ads", { gclid: "Cj0K123" });
    await ingest(pool, "calls", [first], { now: at(1) });
    const stats = await ingest(pool, "calls", [updated], { now: at(2) });
    expect(stats.conflicts).toBe(0);
    expect(await one(pool, "select channel_code, attribution_evidence from leads")).toMatchObject({ channel_code: "google_search", attribution_evidence: "click_id" });
  });

  it("F10: two different payloads for one version in the same batch raise a payload_conflict", async () => {
    const t1 = crm.ticket(9, 1, 2, "B01", "149.00", T0);
    const t2 = crm.ticket(9, 1, 2, "B01", "174.00", T0);
    const stats = await ingest(pool, "crm", [t1, t2]);
    expect(stats.conflicts).toBe(1);
    expect((await one(pool, "select count(*) n from exceptions where kind = 'payload_conflict'")).n).toBe("1");
  });

  it("F11: an acknowledged channel conflict stays acknowledged and stops counting as open", async () => {
    const a = acquisition(5, "B01", "+12125550129", at(0));
    await ingest(pool, "calls", [a.call]);
    await ingest(pool, "d2d", [{ entity: "sale", payload: { saleId: "S-2", repId: "rep-2", branchId: "B01", signedAt: at(0.5).toISOString(), customer: { phone: "+12125550129", email: null, zip: "10001" } } }]);
    await ingest(pool, "crm", a.crm);
    await runReconcile(pool);
    const { id } = await one<{ id: string }>(pool, "select id from exceptions where kind = 'channel_conflict'");
    await acknowledgeException(pool, { exceptionId: Number(id), actor: "t", reason: "commission reviewed", now: T0 });
    await runReconcile(pool);
    expect((await one(pool, "select status from exceptions where id = $1", [id])).status).toBe("acknowledged");
    expect((await totals(pool, OCT)).openExceptions).toBe(0);
  });

  // ── Round 2 (docs/review-senior-engineer-round2.md) ──────────────────────────

  it("R2-H1: inside one batch, a re-delivered old version never beats the new one", async () => {
    const a = acquisition(6, "B01", "+12125550130", T0);
    await ingest(pool, "crm", a.crm.slice(0, 5));
    const successful = crm.payment(7101, a.customerId, a.ticketId, "B01", "149.00", at(60), "1");
    const voided = crm.payment(7101, a.customerId, a.ticketId, "B01", "149.00", at(60), "1");
    (voided.payload as Record<string, unknown>).status = "2";
    await ingest(pool, "crm", [successful], { now: at(70) });
    await ingest(pool, "crm", [successful, voided], { now: at(71) }); // old (seen) first, new second
    expect((await one(pool, "select status from crm_payments where crm_payment_id = 7101")).status).toBe("voided");
  });

  it("R2-H2: replay keeps original receipt order — a later held version wins, an earlier one does not", async () => {
    const drifted = (id: string, source: string, gclid: string | null) => {
      const r = call(id, "B01", "+12125550131", T0, source, { gclid });
      const p = r.payload as Record<string, unknown>;
      p.caller = { number: p.customer_phone_number };
      delete p.customer_phone_number;
      return r;
    };
    // later held version should win
    await ingest(pool, "calls", [call("CAL-L", "B01", "+12125550131", T0, "Direct")], { mapper: mapperFor("calls", "1.0"), now: at(1) });
    await ingest(pool, "calls", [drifted("CAL-L", "Google Ads", "Cj0Kwin")], { mapper: mapperFor("calls", "1.0"), now: at(2) });
    let ids = await quarantineGroupIds(pool, { source: "calls", errorCode: "MISSING_FIELD", branchId: "B01" });
    let r = await replay(pool, { source: "calls", rawEventIds: ids, mapperVersion: "1.1", actor: "t", idempotencyKey: "r2-h2-later", dryRun: false, now: at(10), scope: { ...OCT, branchIds: ["B01"] } });
    expect(r.projected).toBe(1);
    expect((await one(pool, "select channel_code from leads where source_lead_id = 'CAL-L'")).channel_code).toBe("google_search");

    // earlier held version must not regress a newer live one
    await ingest(pool, "calls", [drifted("CAL-E", "Google Ads", "Cj0Kold")], { mapper: mapperFor("calls", "1.0"), now: at(3) });
    await ingest(pool, "calls", [call("CAL-E", "B01", "+12125550132", T0, "Direct")], { mapper: mapperFor("calls", "1.0"), now: at(4) });
    ids = await quarantineGroupIds(pool, { source: "calls", errorCode: "MISSING_FIELD", branchId: "B01" });
    r = await replay(pool, { source: "calls", rawEventIds: ids, mapperVersion: "1.1", actor: "t", idempotencyKey: "r2-h2-earlier", dryRun: false, now: at(11), scope: { ...OCT, branchIds: ["B01"] } });
    expect(r.claimed).toBe(1);
    expect((await one(pool, "select channel_code from leads where source_lead_id = 'CAL-E'")).channel_code).toBe("unknown");
  });

  it("R2-F5: NUL bytes and year-0 timestamps never block a batch", async () => {
    const a = acquisition(7, "B01", "+12125550133", T0);
    const nul = crm.customer(42, "B01", "+12125550134", T0, { source: "Goo\u0000gle" });
    const year0 = crm.customer(43, "B01", "+12125550135", T0, { dateUpdated: "0000-01-01 00:00:00" });
    const stats = await ingest(pool, "crm", [nul, year0, ...a.crm]);
    expect(stats.projected).toBe(a.crm.length + 1); // NUL stripped, record kept
    expect(stats.quarantined).toBe(1); // year 0 held as INVALID_TIMESTAMP
    expect((await one(pool, "select source_label from crm_customers where crm_customer_id = 42")).source_label).toBe("Google");
  });

  it("R2-F4: unseparated numbers in notes are removed; id-shaped values are never hashed", async () => {
    await ingest(pool, "calls", [call("CAL-N2", "B01", "+12125550136", T0, "Direct", { agent_note: "cb +12125550177 asap" })]);
    expect((await one(pool, "select heard_about_text from leads")).heard_about_text).toBe("cb [phone] asap");
    await ingest(pool, "ads", [{ entity: "spend_day", payload: { platform: "google_ads", accountId: "123-456-7890", campaignId: "gs-B01", campaignName: "B01 | Search", date: "2026-10-02", costMicros: "1000000", clicks: 1, conversions: 0, fetchedAt: "2026-10-03T06:00:00Z" } }]);
    expect((await one(pool, "select ad_account_id from ad_campaigns")).ad_account_id).toBe("123-456-7890");
  });

  it("R2-M2: only data errors quarantine a record; transient database errors fail the run", () => {
    expect(isRecordLevelError({ code: "22003" })).toBe(true); // numeric out of range
    expect(isRecordLevelError({ code: "23505" })).toBe(true); // unique violation
    for (const transient of ["40P01", "40001", "55P03", "57014", "08006", undefined]) {
      expect(isRecordLevelError({ code: transient })).toBe(false);
    }
  });

  it("R2-M1: decisions racing reconciliation never deadlock", async () => {
    const a = acquisition(8, "B07", "+12125550137", T0);
    (a.call.payload as Record<string, unknown>).branch_tag = "B06";
    await ingest(pool, "calls", [a.call]);
    await ingest(pool, "crm", a.crm);
    await runReconcile(pool);
    const { evidence } = await one<{ evidence: Record<string, unknown> }>(pool, "select evidence from exceptions where kind = 'branch_mismatch'");
    const jobs = [
      overrideLeadBranch(pool, { leadId: Number(evidence.leadId), branchId: "B07", actor: "t", reason: "race test", now: T0 }),
      ...Array.from({ length: 5 }, () => runReconcile(pool)),
    ];
    await expect(Promise.all(jobs)).resolves.toBeDefined();
    expect((await one(pool, "select status from exceptions where kind = 'branch_mismatch'")).status).toBe("resolved");
  });
});
