import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor } from "@/lib/adapters/registry";
import { resolveIdentities } from "@/lib/identity";
import { replay } from "@/lib/ingest/replay";
import { PERIODS } from "@/lib/period";
import { acquisition, call, freshDb, ingest, one, testPool } from "../helpers";

/**
 * Source semantics at LIVE intake (held-out HO-24 / HO-25, R-17). The ChangeGuard preview
 * warned about these shapes, but the deployed mappers still let them into trusted tables:
 * an outbound or spam call became a lead, and spend in another currency was summed as
 * dollars. These tests go through the default (active) mapper, as a real feed does.
 */
const NOW = new Date("2026-10-31T13:00:00Z");
const at = (d: number, minute = 0) => new Date(Date.UTC(2026, 9, d, 16, minute));

let pool: Pool;
beforeEach(async () => {
  pool ??= testPool();
  await freshDb(pool);
});
afterAll(async () => pool?.end());

const leadCount = async (sourceLeadId: string) =>
  Number((await one<{ n: string }>(pool, "select count(*) as n from v_leads where source = 'calls' and source_lead_id = $1", [sourceLeadId])).n);
const rawOf = (sourceLeadId: string) =>
  pool.query<{ status: string; exclusion_code: string | null; error_code: string | null }>(
    "select status, exclusion_code, error_code from raw_events where source = 'calls' and payload ->> 'id' = $1 order by id",
    [sourceLeadId],
  ).then((r) => r.rows);

describe("calls: only inbound, qualified calls become leads", () => {
  const callWith = (id: string, extra: Record<string, unknown>, minute = 0) => call(id, "B03", `+1480557${String(1000 + minute)}`, at(10, minute), "Google Ads", { campaign: "c-sem", ...extra });

  it("outbound, spam and not-a-lead calls are kept as excluded evidence, not leads, and open no exception", async () => {
    await ingest(pool, "calls", [
      callWith("SEM-IN", { direction: "inbound", spam: false, lead_status: "good_lead" }, 1),
      callWith("SEM-OUT", { direction: "outbound" }, 2),
      callWith("SEM-SPAM", { spam: true }, 3),
      callWith("SEM-NAL", { lead_status: "not_a_lead" }, 4),
      callWith("SEM-PLAIN", {}, 5),
    ], { now: NOW });
    expect(await leadCount("SEM-IN")).toBe(1);
    expect(await leadCount("SEM-PLAIN")).toBe(1);
    for (const [id, code] of [["SEM-OUT", "NOT_INBOUND"], ["SEM-SPAM", "SPAM_CALL"], ["SEM-NAL", "NOT_A_LEAD"]] as const) {
      expect(await leadCount(id)).toBe(0);
      expect(await rawOf(id)).toEqual([{ status: "excluded", exclusion_code: code, error_code: null }]);
    }
    expect(await one(pool, "select count(*)::int as n from raw_events where status = 'quarantined'")).toEqual({ n: 0 });
  });

  it("a later revision marking a lead as spam takes it out of every lead metric; un-marking restores it", async () => {
    await ingest(pool, "calls", [callWith("SEM-REV", { spam: false }, 6)], { now: NOW });
    expect(await leadCount("SEM-REV")).toBe(1);
    await ingest(pool, "calls", [callWith("SEM-REV", { spam: true }, 6)], { now: new Date(NOW.getTime() + 60_000) });
    expect(await leadCount("SEM-REV")).toBe(0);
    expect((await rawOf("SEM-REV")).map((r) => r.status)).toEqual(["projected", "excluded"]);
    // The lead row and its history are kept; only its eligibility changed.
    expect(await one(pool, "select excluded_code from leads where source_lead_id = 'SEM-REV'")).toEqual({ excluded_code: "SPAM_CALL" });
    await ingest(pool, "calls", [callWith("SEM-REV", { spam: false, lead_status: "previously_marked_good_lead" }, 6)], { now: new Date(NOW.getTime() + 120_000) });
    expect(await leadCount("SEM-REV")).toBe(1);
  });
});

describe("exclusions hold across mapper versions, replays and old rows (independent review F1–F3)", () => {
  const callWith = (id: string, extra: Record<string, unknown>, minute = 0) => call(id, "B03", `+1480557${String(2000 + minute)}`, at(11, minute), "Google Ads", { campaign: "c-sem", ...extra });
  const later = (ms: number) => new Date(NOW.getTime() + ms);
  /** The caller under `caller.number`: a shape calls@1.0 cannot read, so it is held. */
  const callerShape = (record: RawRecord): RawRecord => {
    const p = { ...(record.payload as Record<string, unknown>) };
    p.caller = { number: p.customer_phone_number };
    delete p.customer_phone_number;
    return { entity: record.entity, payload: p };
  };

  it("F1: a spam call stored under calls@1.1 leaves the lead metrics when it is observed again", async () => {
    const spam = callWith("SEM-OLD", { spam: true }, 7);
    await ingest(pool, "calls", [spam], { now: NOW, mapper: mapperFor("calls", "1.1") });
    expect(await leadCount("SEM-OLD")).toBe(1); // the old mapper counted it
    await ingest(pool, "calls", [callWith("SEM-OLD", { spam: false }, 7)], { now: later(60_000) });
    await ingest(pool, "calls", [spam], { now: later(120_000) });
    expect(await leadCount("SEM-OLD")).toBe(0);
  });

  it("F1: the 0019 backfill excludes leads whose stored version the source marked, and withdraws non-USD spend", async () => {
    await ingest(pool, "calls", [callWith("SEM-BF-SPAM", { spam: true }, 8), callWith("SEM-BF-OK", {}, 9)], { now: NOW, mapper: mapperFor("calls", "1.1") });
    const cad: RawRecord = { entity: "spend_day", payload: { platform: "google_ads", accountId: "ACC-BF", campaignId: "bf-cad", campaignName: "bf", date: "2026-10-12", costMicros: "71500000", clicks: 1, conversions: 1, fetchedAt: "2026-10-13T06:00:00Z", campaignType: "SEARCH", currencyCode: "CAD" } };
    const usd: RawRecord = { entity: "spend_day", payload: { ...(cad.payload as Record<string, unknown>), campaignId: "bf-usd", currencyCode: "USD" } };
    await ingest(pool, "ads", [cad, usd], { now: NOW, mapper: mapperFor("ads", "1.1") });
    expect(await one(pool, "select count(*)::int as n from ad_spend_daily")).toEqual({ n: 2 }); // summed as dollars before 0019
    await pool.query(readFileSync(path.join(__dirname, "../../database/migrations/0019_source_semantics_backfill.sql"), "utf8"));
    expect(await leadCount("SEM-BF-SPAM")).toBe(0);
    expect(await leadCount("SEM-BF-OK")).toBe(1);
    const spend = await pool.query("select c.external_campaign_id as c, s.currency_basis as basis from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id");
    expect(spend.rows).toEqual([{ c: "bf-usd", basis: "reported_usd" }]);
    expect(await one(pool, "select status, error_code from raw_events where payload ->> 'campaignId' = 'bf-cad'")).toEqual({ status: "quarantined", error_code: "CURRENCY_UNSUPPORTED" });
  });

  it("F2: replaying a held spam revision takes the earlier lead out of the metrics", async () => {
    const v10 = mapperFor("calls", "1.0");
    await ingest(pool, "calls", [callWith("SEM-RP", {}, 10)], { now: NOW, mapper: v10 });
    await ingest(pool, "calls", [callerShape(callWith("SEM-RP", { spam: true }, 10))], { now: later(60_000), mapper: v10 });
    const held = await one<{ id: string }>(pool, "select id from raw_events where status = 'quarantined' and payload ->> 'id' = 'SEM-RP'");
    await replay(pool, { source: "calls", rawEventIds: [Number(held.id)], mapperVersion: "1.2", actor: "test", idempotencyKey: "sem-rp", dryRun: false, now: later(120_000), scope: { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: ["B03"] } });
    expect(await leadCount("SEM-RP")).toBe(0);
    expect(await one(pool, "select status, exclusion_code from raw_events where id = $1", [Number(held.id)])).toEqual({ status: "excluded", exclusion_code: "SPAM_CALL" });
  });

  it("F4: an excluded lead loses its identity link on the next resolution", async () => {
    const won = acquisition(77, "B03", "+14805573077", at(9));
    await ingest(pool, "calls", [won.call], { now: NOW });
    await ingest(pool, "crm", won.crm, { now: NOW });
    await resolveIdentities(pool, NOW);
    const links = "select count(*)::int as n from identity_links where source = 'calls' and source_record_id = 'CAL-77'";
    expect(await one(pool, links)).toEqual({ n: 1 });
    await ingest(pool, "calls", [{ entity: "call", payload: { ...(won.call.payload as Record<string, unknown>), spam: true } }], { now: later(60_000) });
    await resolveIdentities(pool, later(120_000));
    expect(await one(pool, links)).toEqual({ n: 0 });
  });

  it("F3: a held original replayed after the source marked the call spam does not count", async () => {
    const v10 = mapperFor("calls", "1.0");
    await ingest(pool, "calls", [callerShape(callWith("SEM-TS", {}, 11))], { now: NOW, mapper: v10 }); // A, held
    await ingest(pool, "calls", [callWith("SEM-TS", { spam: true }, 11)], { now: later(60_000) }); // B, excluded; no lead yet
    const held = await one<{ id: string }>(pool, "select id from raw_events where status = 'quarantined' and payload ->> 'id' = 'SEM-TS'");
    await replay(pool, { source: "calls", rawEventIds: [Number(held.id)], mapperVersion: "1.2", actor: "test", idempotencyKey: "sem-ts", dryRun: false, now: later(120_000), scope: { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: ["B03"] } });
    expect(await leadCount("SEM-TS")).toBe(0);
  });
});

describe("ad spend: money is never converted or assumed silently", () => {
  const spendDay = (campaignId: string, extra: Record<string, unknown>): RawRecord => ({
    entity: "spend_day",
    payload: { platform: "google_ads", accountId: "ACC-SEM", campaignId, campaignName: `${campaignId} search`, date: "2026-10-12", costMicros: "71500000", clicks: 3, conversions: 1, fetchedAt: "2026-10-13T06:00:00Z", campaignType: "SEARCH", ...extra },
  });

  it("spend in another currency is quarantined with its code and never summed", async () => {
    await ingest(pool, "ads", [spendDay("sem-cad", { currencyCode: "CAD" })], { now: NOW });
    expect(await one(pool, "select count(*)::int as n from ad_spend_daily")).toEqual({ n: 0 });
    expect(await one(pool, "select status, error_code from raw_events where source = 'ads'")).toEqual({ status: "quarantined", error_code: "CURRENCY_UNSUPPORTED" });
  });

  it("a stated USD amount is recorded as reported; an unstated one counts only under an authorized rule, and says so", async () => {
    // freshDb's fixture rule says every account reports in USD (tests/helpers.ts).
    await ingest(pool, "ads", [spendDay("sem-usd", { currencyCode: "USD" }), spendDay("sem-none", {})], { now: NOW });
    const rows = await pool.query("select c.external_campaign_id, s.cost_cents, s.currency_basis from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id order by 1");
    expect(rows.rows).toEqual([
      { external_campaign_id: "sem-none", cost_cents: "7150", currency_basis: "account_rule_usd" },
      { external_campaign_id: "sem-usd", cost_cents: "7150", currency_basis: "reported_usd" },
    ]);
  });
});
