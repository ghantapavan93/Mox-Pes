import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { call, freshDb, ingest, one, testPool } from "../helpers";

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

  it("a stated USD amount is recorded as reported; an unstated one is recorded as an assumption", async () => {
    await ingest(pool, "ads", [spendDay("sem-usd", { currencyCode: "USD" }), spendDay("sem-none", {})], { now: NOW });
    const rows = await pool.query("select c.external_campaign_id, s.cost_cents, s.currency_basis from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id order by 1");
    expect(rows.rows).toEqual([
      { external_campaign_id: "sem-none", cost_cents: "7150", currency_basis: "assumed_usd" },
      { external_campaign_id: "sem-usd", cost_cents: "7150", currency_basis: "reported_usd" },
    ]);
  });
});
