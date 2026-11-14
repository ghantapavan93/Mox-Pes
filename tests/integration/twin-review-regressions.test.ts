import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { mapCampaignToBranch } from "@/lib/actions";
import type { MapContext, RawRecord, SourceMapper } from "@/lib/adapters/contract";
import { mapperFor } from "@/lib/adapters/registry";
import { NewChangeSchema } from "@/lib/changeguard/model";
import { createChange } from "@/lib/changeguard/service";
import { createPool } from "@/lib/db";
import { decideIdentityConflict, resolveIdentities } from "@/lib/identity";
import { replay } from "@/lib/ingest/replay";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { attributionChanges, evaluateGates, takeSnapshot } from "@/lib/twin/gates";
import { referenceState } from "@/lib/twin/oracle";
import { LeaseLost, runEvaluation } from "@/lib/twin/runner";
import { abandonEvaluation, createEvaluation, getEvaluation, reopenEvaluation } from "@/lib/twin/store";
import { codeFingerprint, databaseUrl, dropWorld } from "@/lib/twin/world";
import { VIEWERS } from "@/lib/viewer";
import { TEST_DATABASE_URL, acquisition, call, crm, freshDb, ingest, one, testPool } from "../helpers";

/**
 * Independent review of the Reliability Twin, 2026-11-12: every confirmed counterexample, kept as
 * a regression test. First contact: docs/agent-work/twin/REVIEW-FIRST-CONTACT.md. Two were
 * pre-existing attribution rules both the product and the reference applied, pinned with
 * `it.fails`: R-39 still is (REMAINING-RISKS); R-46 was fixed on 2026-11-13 and now passes.
 */
const pool: Pool = testPool();
afterAll(async () => pool.end());
beforeEach(async () => freshDb(pool), 60_000);

const NOW = new Date("2026-10-31T13:00:00Z");
const at = (d: number, h = 16) => new Date(Date.UTC(2026, 9, d, h));
const T = (minute: number) => new Date(Date.UTC(2026, 9, 20, 15, minute));
const SCOPE = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z"), branchIds: ["B12"] };
const ids = async (where = "true") => (await pool.query<{ id: string }>(`select id from raw_events where source = 'calls' and ${where} order by id`)).rows.map((r) => Number(r.id));

describe("data 1 · a quarantine replay never puts voided cash back", () => {
  const ACQ = acquisition(1, "B01", "+12125550171", new Date("2026-10-05T15:00:00Z"));
  const pay = (status: "1" | "2"): RawRecord => {
    const r = crm.payment(7201, ACQ.customerId, ACQ.ticketId, "B01", "149.00", new Date("2026-10-07T17:00:00Z"));
    (r.payload as Record<string, unknown>).status = status;
    return r;
  };
  const real = mapperFor("crm");
  /** crm@1.0 deployed with a bug that refuses successful payments; fixed later, then replayed. */
  const buggy: SourceMapper = {
    source: "crm", version: "1.0",
    identify: (r: RawRecord, ctx: MapContext) => real.identify(r, ctx),
    map: (r: RawRecord, ctx: MapContext) => (r.entity === "payment" && (r.payload as Record<string, unknown>).status === "1" ? { ok: false, code: "MAPPER_ERROR", detail: "simulated mapper bug" } : real.map(r, ctx)),
  };

  it("an earlier version, unreadable when a stale copy re-serves it after the void, stays behind the void when replayed", async () => {
    await ingest(pool, "crm", ACQ.crm.slice(0, 5), { now: at(10, 15) });
    await ingest(pool, "crm", [pay("1")], { mapper: buggy, now: at(10, 16) }); // quarantined
    await ingest(pool, "crm", [pay("2")], { mapper: buggy, now: at(10, 17) }); // the void, live
    await ingest(pool, "crm", [pay("1")], { mapper: buggy, now: at(10, 18) }); // stale copy, still unreadable
    const held = Number((await one<{ id: string }>(pool, "select id from raw_events where entity = 'payment' and payload ->> 'status' = '1'")).id);
    const r = await replay(pool, { source: "crm", rawEventIds: [held], mapperVersion: "1.0", mode: "quarantined", actor: "test", idempotencyKey: "rv-1", dryRun: false, now: at(11), scope: { ...PERIODS.oct, branchIds: ["B01"] } });
    expect(r.projected).toBe(1);
    expect(await one(pool, "select status from crm_payments where crm_payment_id = 7201")).toEqual({ status: "voided" });
    expect((await branchRows(pool, { ...PERIODS.oct, branchIds: ["B01"] }))[0].collectedCents).toBe(0);
  });
});

describe("data 2 · call versions: the latest observation decides on every path", () => {
  const base = call("CAL-RV-1", "B12", "+14805551234", new Date("2026-10-19T15:00:00Z"));
  const basePayload = base.payload as Record<string, unknown>;
  const withFields = (extra: Record<string, unknown>): RawRecord => ({ entity: "call", payload: { ...basePayload, ...extra } });
  /** The same call marked spam, in the caller.number shape calls@1.0 cannot read. */
  const spamNewShape: RawRecord = (() => {
    const p: Record<string, unknown> = { ...basePayload, spam: true, caller: { number: "+14805551234" } };
    delete p.customer_phone_number;
    return { entity: "call", payload: p };
  })();
  const lead = () => pool.query<{ counted: boolean; channel_code: string; source_updated_at: Date }>("select excluded_code is null as counted, channel_code, source_updated_at from leads where source_lead_id = 'CAL-RV-1'").then((r) => r.rows[0] ?? null);

  it("2a · a held revision replayed later does not beat the good version delivered after it", async () => {
    const mapper = mapperFor("calls", "1.0");
    await ingest(pool, "calls", [spamNewShape], { mapper, now: T(0) });
    await ingest(pool, "calls", [base], { mapper, now: T(10) });
    await ingest(pool, "calls", [spamNewShape], { mapper, now: T(20) });
    await ingest(pool, "calls", [base], { mapper, now: T(30) }); // the latest observation: the good version
    await replay(pool, { source: "calls", rawEventIds: await ids("status = 'quarantined'"), mapperVersion: "1.2", mode: "quarantined", actor: "test", idempotencyKey: "rv-2a", dryRun: false, now: T(40), scope: SCOPE });
    expect((await lead())!.counted).toBe(true);
  });

  it("2b · a stored record calls@1.2 cannot read is reported by re-projection and left as calls@1.1 read it", async () => {
    await ingest(pool, "calls", [withFields({ spam: null, source: "Facebook" })], { mapper: mapperFor("calls", "1.1"), now: T(0) });
    const r = await replay(pool, { source: "calls", rawEventIds: await ids(), mapperVersion: "1.2", fromVersion: "1.1", mode: "reproject", actor: "test", idempotencyKey: "rv-2b", dryRun: false, now: T(10), scope: SCOPE });
    // Never silently: the twin's gate B fails a stage with any (lib/twin/gates.ts).
    expect(r.errors).toHaveLength(1);
    expect((await lead())!.counted).toBe(true);
  });

  it("2b · the twin's rollback (re-projection, then re-reading what calls@1.2 held) restores calls@1.1's answer", async () => {
    const v12 = mapperFor("calls", "1.2");
    await ingest(pool, "calls", [base], { mapper: v12, now: T(0) });
    await ingest(pool, "calls", [withFields({ spam: null, source: "Facebook" })], { mapper: v12, now: T(10) }); // held under 1.2
    await replay(pool, { source: "calls", rawEventIds: await ids("status <> 'quarantined'"), mapperVersion: "1.1", fromVersion: "1.2", mode: "reproject", actor: "test", idempotencyKey: "rb", dryRun: false, now: T(20), scope: SCOPE });
    await replay(pool, { source: "calls", rawEventIds: await ids("status = 'quarantined'"), mapperVersion: "1.1", mode: "quarantined", actor: "test", idempotencyKey: "rb-held", dryRun: false, now: T(21), scope: SCOPE });
    expect((await lead())!.channel_code).toBe("meta"); // what calls@1.1 gives: the later (Facebook) version
  });

  it("2c · forward to calls@1.2 and back leaves the lead exactly as calls@1.1 had it, clock included", async () => {
    const mapper = mapperFor("calls", "1.1");
    const spam = withFields({ spam: true });
    await ingest(pool, "calls", [spam], { mapper, now: T(5) });
    await ingest(pool, "calls", [spam], { mapper, now: T(6) }); // delivered again: the lead's clock moves with it
    const before = await lead();
    expect(before!.source_updated_at).toEqual(T(6));
    await replay(pool, { source: "calls", rawEventIds: await ids(), mapperVersion: "1.2", fromVersion: "1.1", mode: "reproject", actor: "test", idempotencyKey: "f", dryRun: false, now: T(10), scope: SCOPE });
    expect((await lead())!.counted).toBe(false);
    await replay(pool, { source: "calls", rawEventIds: await ids(), mapperVersion: "1.1", fromVersion: "1.2", mode: "reproject", actor: "test", idempotencyKey: "b", dryRun: false, now: T(20), scope: SCOPE });
    expect(await lead()).toEqual(before);
  });
});

describe("financial 2 · a later identity decision overrides an earlier one", () => {
  it("rejected, re-opened, accepted: the lead credits the customer, in the product and in the reference", async () => {
    const SHARED = "+14805557001";
    const a = acquisition(1, "B12", SHARED, at(10));
    const b = acquisition(2, "B12", SHARED, at(12));
    await ingest(pool, "calls", [a.call], { now: NOW });
    await ingest(pool, "crm", [...a.crm, ...b.crm], { now: NOW });
    await resolveIdentities(pool, NOW);
    const leadId = Number((await one<{ id: string }>(pool, "select id from leads where source_lead_id = 'CAL-1'")).id);
    const first = await one<{ id: string }>(pool, "select id from identity_conflicts where lead_id = $1 and crm_customer_id = $2 and status = 'pending'", [leadId, a.customerId]);
    await decideIdentityConflict(pool, { conflictId: Number(first.id), decision: "reject", reason: "Not this customer (first look)", actor: "test:reviewer", now: NOW });
    await ingest(pool, "crm", acquisition(3, "B12", SHARED, at(20)).crm, { now: NOW });
    await resolveIdentities(pool, NOW);
    const reopened = await one<{ id: string }>(pool, "select id from identity_conflicts where lead_id = $1 and crm_customer_id = $2 and status = 'pending'", [leadId, a.customerId]);
    await decideIdentityConflict(pool, { conflictId: Number(reopened.id), decision: "accept", reason: "Customer A confirmed the call", actor: "test:reviewer", now: NOW });
    const product = await one<{ lead_id: string | null }>(pool, "select lead_id from v_acquisitions where crm_customer_id = $1", [a.customerId]);
    const ref = await referenceState(pool, { onNewVersion: [], period: PERIODS.all });
    expect(Number(product.lead_id)).toBe(leadId);
    expect(ref.credit.get(a.customerId)).toBe(leadId);
  });
});

describe("financial 6 · held spend with an unreadable date", () => {
  const spend = (campaignId: string, date: string): RawRecord => ({
    entity: "spend_day",
    payload: { platform: "google_ads", accountId: "ACC-1", campaignId, campaignName: `${campaignId} search`, date, costMicros: "50000000", clicks: 3, conversions: 1, fetchedAt: "2026-10-06T06:00:00Z", campaignType: "SEARCH" },
  });
  const ALL = { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: ["B12"] };

  it("an impossible calendar date (2026-02-30) held at intake does not take the scorecard down", async () => {
    await ingest(pool, "ads", [spend("cr-bad-day", "2026-02-30")], { now: NOW });
    const won = acquisition(9, "B12", "+14805558009", at(10), { source: "Google Ads" });
    await ingest(pool, "calls", [won.call], { now: NOW });
    await ingest(pool, "crm", won.crm, { now: NOW });
    await expect(branchRows(pool, ALL)).resolves.toHaveLength(1);
  });

  it("a campaign whose only spend is held, whatever its date reads, leaves its customers out of paid CAC (product = reference)", async () => {
    await ingest(pool, "ads", [spend("cr-held", "10/05/2026")], { now: NOW });
    const won = acquisition(1, "B12", "+14805558001", at(10), { source: "Google Ads" });
    (won.call.payload as Record<string, unknown>).campaign = "cr-held";
    await ingest(pool, "calls", [won.call], { now: NOW });
    await ingest(pool, "crm", won.crm, { now: NOW });
    const [row] = await branchRows(pool, ALL);
    const ref = await referenceState(pool, { onNewVersion: [], period: PERIODS.all });
    expect({ product: row.paidAcquired, held: row.heldCampaignAcquired }).toEqual({ product: 0, held: 1 });
    expect(ref.branches.get("B12")?.paidAcquired ?? 0).toBe(0);
  });
});

describe("financial 3 · gate I sees a customer outside the stage whose credit moved, even when totals did not", () => {
  it("a B05 customer's first touch is a B20 call marked spam; stage [B20] fails I", async () => {
    const P = "+14805557101";
    const x = acquisition(1, "B05", P, at(15));
    await ingest(pool, "calls", [call("S-1", "B20", P, at(10), "Google Ads", { spam: true }), call("F-1", "B05", P, at(12), "Facebook")], { now: NOW, mapper: mapperFor("calls", "1.1") });
    await ingest(pool, "crm", x.crm, { now: NOW });
    const stage = { key: "A" as const, label: "1 branch", branchIds: ["B20"], newBranchIds: ["B20"] };
    const before = await takeSnapshot(pool);
    const prev = await referenceState(pool, { onNewVersion: [], period: PERIODS.all });
    await replay(pool, { source: "calls", rawEventIds: await ids("payload_branch(payload) = 'B20'"), mapperVersion: "1.2", fromVersion: "1.1", mode: "reproject", actor: "test", idempotencyKey: "fin3", dryRun: false, now: NOW, scope: { ...PERIODS.all, branchIds: ["B20"] } });
    const after = await takeSnapshot(pool);
    const cur = await referenceState(pool, { onNewVersion: ["B20"], period: PERIODS.all });
    const attribution = attributionChanges(prev, cur, stage);
    expect(attribution.outsideStage).toBe(1);
    const gates = await evaluateGates({ twin: pool, stage, before, after, oracle: cur, attribution, deliver: null, backfill: null, resumed: null });
    const i = gates.find((g) => g.id === "I")!;
    expect(i.status).toBe("fail");
    expect(i.detail).toMatch(/B05 \(brand moxie: a customer's credited channel moved/);
  });
});

describe("pre-existing attribution rules both the product and the reference applied (R-39 open and pinned; R-46 fixed)", () => {
  it.fails("R-39 · two customers on one phone, each called before the first sale: the second keeps her own call", async () => {
    const SHARED = "+14805557201";
    const a = acquisition(1, "B12", SHARED, at(10));
    const b = acquisition(2, "B12", SHARED, at(12));
    await ingest(pool, "calls", [call("CAL-A", "B12", SHARED, at(1), "Google Ads"), call("CAL-B", "B12", SHARED, at(5), "Facebook")], { now: NOW });
    await ingest(pool, "crm", [...a.crm, ...b.crm], { now: NOW });
    expect((await one<{ channel_code: string }>(pool, "select channel_code from v_acquisitions where crm_customer_id = $1", [b.customerId])).channel_code).toBe("meta");
  });

  // Fixed 2026-11-13: the call names "Google Ads", so its id is matched on Google Ads only; the
  // Meta campaign with the same id is another campaign (v_lead_campaigns; campaign-platform-match.test.ts).
  it("R-46 · a mapped Google campaign keeps its paid customer when a Meta campaign shares its id", async () => {
    const spend = (platform: string): RawRecord => ({
      entity: "spend_day",
      payload: { platform, accountId: "ACC-1", campaignId: "123", campaignName: `${platform} 123`, date: "2026-10-03", costMicros: "50000000", clicks: 3, conversions: 1, fetchedAt: "2026-10-04T06:00:00Z", ...(platform === "google_ads" ? { campaignType: "SEARCH" } : {}) },
    });
    await ingest(pool, "ads", [spend("google_ads"), spend("meta")], { now: NOW });
    const g = await one<{ id: string }>(pool, "select id from ad_campaigns where platform = 'google_ads' and external_campaign_id = '123'");
    await mapCampaignToBranch(pool, { campaignId: Number(g.id), branchId: "B12", actor: "setup", reason: "fixture mapping", now: at(1) });
    const won = acquisition(1, "B12", "+14805558101", at(10), { source: "Google Ads" });
    (won.call.payload as Record<string, unknown>).campaign = "123";
    await ingest(pool, "calls", [won.call], { now: NOW });
    await ingest(pool, "crm", won.crm, { now: NOW });
    expect((await branchRows(pool, { ...PERIODS.all, branchIds: ["B12"] }))[0].paidAcquired).toBe(1);
  });
});

describe("the twin's control plane", () => {
  const change = () =>
    createChange(pool, VIEWERS.marketing, NewChangeSchema.parse({
      kind: "source_contract", reason: "Roll out calls@1.2 (control-plane test)",
      payload: { source: "calls", entity: "call", samples: [{ id: "S-1", branch_tag: "B12", start_time: "2026-10-20T15:00:00Z", tracking_phone_number: "+18885550100", source: "Google Ads", gclid: null, campaign: null, agent_note: null, customer_phone_number: "+14805551000" }] },
    }));
  const start = async (changeId: number, controlDatabase = "revenue_signal_test") => createEvaluation(pool, VIEWERS.engineer, { changeId, variant: "standard", controlDatabase, now: new Date() });

  it("financial 7 · two control databases never name the same twin", async () => {
    const c = await change();
    const names: string[] = [];
    for (const db of ["revenue-signal", "revenue_signal", "revenue_signal_review_worker_10", "revenue_signal_review_worker_11"]) {
      const id = await start(c.id, db);
      names.push((await getEvaluation(pool, id))!.twinDatabase);
      await pool.query("update rollout_evaluations set status = 'ERROR', finished_at = now() where id = $1", [id]);
    }
    expect(new Set(names.map((n) => n.replace(/_\d+$/, ""))).size).toBe(4);
  });

  it("SRE H2 · a second runner is refused while the first holds a fresh lease, and writes nothing", async () => {
    const c = await change();
    const id = await start(c.id);
    await pool.query("update rollout_evaluations set runner_id = 'another-process', heartbeat_at = now() where id = $1", [id]);
    const before = await getEvaluation(pool, id);
    await expect(runEvaluation(pool, id, { mainUrl: TEST_DATABASE_URL, runnerId: "this-process" })).rejects.toBeInstanceOf(LeaseLost);
    expect(await getEvaluation(pool, id)).toEqual(before);
  });

  it("SRE H1/H3 · abandoning a stuck evaluation ends it with no verdict, marks the stage stopped mid-way, and a re-open lets it resume", async () => {
    const c = await change();
    const id = await start(c.id);
    await pool.query("update rollout_evaluations set runner_id = 'stuck', code_fingerprint = $2, summary = jsonb_build_object('world', jsonb_build_object('at', now())) where id = $1", [id, codeFingerprint()]);
    await pool.query("update rollout_stages set status = 'RUNNING', steps = '{\"reproject\":{\"at\":\"x\",\"result\":[]}}' where evaluation_id = $1 and ordinal = 1", [id]);
    await expect(abandonEvaluation(pool, VIEWERS.partner, { changeId: c.id, evaluationId: id, now: new Date() })).rejects.toThrow(/cannot abandon/);
    await abandonEvaluation(pool, VIEWERS.engineer, { changeId: c.id, evaluationId: id, now: new Date() });
    const ev = (await getEvaluation(pool, id))!;
    expect({ status: ev.status, runner: ev.runnerId, stages: ev.stages.map((s) => s.status) }).toEqual({ status: "ERROR", runner: null, stages: ["INTERRUPTED", "PENDING", "PENDING"] });
    expect(ev.error).toMatch(/Abandoned by demo:engineer/);
    // The stuck runner's next write is refused: its lease is gone.
    await expect(runEvaluation(pool, id, { mainUrl: TEST_DATABASE_URL, runnerId: "stuck" })).resolves.toMatchObject({ status: "ERROR" });
    await expect(reopenEvaluation(pool, VIEWERS.engineer, { changeId: c.id, evaluationId: id, currentCode: "another-code", now: new Date() })).rejects.toThrow(/code has changed/);
    await reopenEvaluation(pool, VIEWERS.engineer, { changeId: c.id, evaluationId: id, currentCode: codeFingerprint(), now: new Date() });
    expect((await getEvaluation(pool, id))!.status).toBe("RUNNING");
  });

  it("data 4 · a runner lost between a failed gate and its rollback: the next runner rolls the stage back", async () => {
    const twinName = "rso_twin_review_failed_rollback";
    const admin = createPool(databaseUrl(TEST_DATABASE_URL, "postgres"));
    await admin.query(`drop database if exists ${twinName} with (force)`);
    await admin.query(`create database ${twinName}`);
    await admin.end();
    const twin = createPool(databaseUrl(TEST_DATABASE_URL, twinName));
    try {
      await freshDb(twin);
      await twin.query("create table twin_inputs (variant text not null, overlay jsonb not null)");
      await twin.query("insert into twin_inputs values ('standard', $1)", [JSON.stringify({ preRollout: [], inflight: { A: [], B: [], C: [] }, crm: [], notes: [] })]);
      // Stage A's branch read one call with calls@1.2 and excluded it, then a gate failed.
      await ingest(twin, "calls", [call("CAL-F-1", "B12", "+14805559001", at(5), "Google Ads", { spam: true })], { mapper: mapperFor("calls", "1.2"), now: NOW });
      const before = await takeSnapshot(twin);
      const c = await change();
      const id = await start(c.id);
      await pool.query("update rollout_evaluations set twin_database = $2, code_fingerprint = $3, summary = jsonb_build_object('world', jsonb_build_object('at', now())) where id = $1", [id, twinName, codeFingerprint()]);
      await pool.query(
        `update rollout_stages set status = 'FAILED', attempts = 1, started_at = now(), completed_at = now(), violated = '{F1}',
           gates = '[{"id":"F1","label":"backfill","status":"fail","detail":"unfinished"}]', evidence = jsonb_build_object('before', $2::jsonb)
         where evaluation_id = $1 and ordinal = 1`,
        [id, JSON.stringify(before)],
      );
      const ev = await runEvaluation(pool, id, { mainUrl: TEST_DATABASE_URL });
      expect(ev.stages.map((s) => s.status)).toEqual(["RECOVERED", "BLOCKED", "BLOCKED"]);
      expect(ev.stages[0].recovery).toMatchObject({ kind: "rollback", restoredBusinessState: { verified: true } });
      expect(await one(twin, "select count(*)::int as n from replays where idempotency_key = $1", [`twin:${id}:A:rollback`])).toEqual({ n: 1 });
      expect(await one(twin, "select excluded_code from leads where source_lead_id = 'CAL-F-1'")).toEqual({ excluded_code: null });
    } finally {
      await twin.end();
      await dropWorld(TEST_DATABASE_URL, twinName);
    }
  }, 120_000);
});
