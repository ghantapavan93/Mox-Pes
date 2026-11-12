import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapCampaignToBranch } from "@/lib/actions";
import { ACTIVE_VERSION, mapperFor, referenceContext } from "@/lib/adapters/registry";
import { ingestRecords } from "@/lib/ingest/ingest";
import { replay } from "@/lib/ingest/replay";
import { accountsAwaitingCurrency, authorizeCurrencyRule, proposeCurrencyRule, revokeCurrencyRule } from "@/lib/currency/rules";
import { traceBranchMetric } from "@/lib/lineage/trace";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { ForbiddenError, VIEWERS } from "@/lib/viewer";
import { acquisition, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * Unstated currency is not dollars (held-out investigator IR-8, cases IV-24..IV-26): without an
 * authorized account rule, spend whose feed states no currency is excluded at intake and shown;
 * a rule makes it count, as account_rule_usd; revoking it excludes it again. Customers credited to
 * a campaign whose spend was all held leave the CAC denominator (definition v3), and the trace
 * still reproduces the scorecard exactly.
 */
const NOW = new Date("2026-10-31T13:00:00Z");
const OCT = PERIODS.oct;
const at = (d: number, minute = 0) => new Date(Date.UTC(2026, 9, d, 16, minute));
const ymd = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const { approver, engineer, marketing } = VIEWERS;

function spend(campaignId: string, accountId: string, d: number, dollars: number, extra: Record<string, unknown> = {}): RawRecord {
  return {
    entity: "spend_day",
    payload: { platform: "google_ads", accountId, campaignId, campaignName: `${campaignId} search`, date: ymd(d), costMicros: String(dollars * 1_000_000), clicks: 3, conversions: 1, fetchedAt: `${ymd(d + 1)}T06:00:00Z`, campaignType: "SEARCH", ...extra },
  };
}

let pool: Pool;
beforeEach(async () => {
  pool ??= testPool();
  await freshDb(pool, { currencyRule: false });
}, 60_000);
afterAll(async () => pool?.end());

/** B12: a USD-stated campaign, a campaign with no stated currency, and a CAD one; a customer of each. */
async function world() {
  const ads: RawRecord[] = [];
  for (let d = 1; d <= 5; d++) {
    ads.push(spend("cr-usd", "ACC-USD", d, 60, { currencyCode: "USD" }));
    ads.push(spend("cr-none", "ACC-NONE", d, 40));
    ads.push(spend("cr-cad", "ACC-CAD", d, 25, { currencyCode: "CAD" }));
  }
  await ingest(pool, "ads", ads, { now: NOW });
  const usd = await one<{ id: string }>(pool, "select id from ad_campaigns where external_campaign_id = 'cr-usd'");
  await mapCampaignToBranch(pool, { campaignId: Number(usd.id), branchId: "B12", actor: "setup", reason: "fixture mapping", now: at(1) });
  for (const [n, campaign] of [[1, "cr-usd"], [2, "cr-usd"], [3, "cr-none"], [4, "cr-cad"]] as const) {
    const won = acquisition(n, "B12", `+1480557${String(1000 + n)}`, at(6 + n), { source: "Google Ads" });
    (won.call.payload as Record<string, unknown>).campaign = campaign;
    await ingest(pool, "calls", [won.call], { now: NOW });
    await ingest(pool, "crm", won.crm, { now: NOW });
  }
  await runReconcile(pool, NOW);
}

describe("spend whose currency is not stated", () => {
  it("is excluded at intake and shown, never summed as dollars; another currency is quarantined", async () => {
    await world();
    const stored = await pool.query("select c.external_campaign_id as c, sum(s.cost_cents)::int as cents, min(s.currency_basis) as basis from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id group by 1 order by 1");
    expect(stored.rows).toEqual([{ c: "cr-usd", cents: 30_000, basis: "reported_usd" }]);
    expect(await one(pool, "select status, exclusion_code, count(*)::int as n from raw_events where payload ->> 'campaignId' = 'cr-none' group by 1, 2")).toEqual({ status: "excluded", exclusion_code: "CURRENCY_UNSTATED", n: 5 });
    expect(await one(pool, "select status, error_code, count(*)::int as n from raw_events where payload ->> 'campaignId' = 'cr-cad' group by 1, 2")).toEqual({ status: "quarantined", error_code: "CURRENCY_UNSUPPORTED", n: 5 });
  });

  it("takes the held campaigns' customers out of the CAC denominator, and the trace reproduces and explains it", async () => {
    await world();
    const [row] = await branchRows(pool, { from: OCT.from, to: OCT.to, branchIds: ["B12"] });
    // $300.00 of USD spend over the 2 customers of the USD campaign: $150.00, not $300.00 ÷ 4.
    expect({ spend: row.paidSpendCents, paid: row.paidAcquired, acquired: row.acquired }).toEqual({ spend: 30_000, paid: 2, acquired: 4 });
    const t = await traceBranchMetric(pool, marketing, { branchId: "B12", period: OCT, metric: "paid_cac" });
    expect(t.value.matches).toBe(true);
    expect(t.value.reproduced).toEqual({ paidSpendCents: 30_000, paidAcquired: 2, paidCacCents: 15_000 });
    expect(t.excluded.find((e) => e.code === "CAMPAIGN_SPEND_HELD")).toMatchObject({ count: 2 });
    expect(t.metric.definitionVersion).toMatch(/^v3/);
  });

  it("counts once an engineer proposes and a different approver authorizes the account's rule, and is excluded again when it is revoked", async () => {
    await world();
    expect(await accountsAwaitingCurrency(pool)).toEqual([{ platform: "google_ads", adAccountId: "ACC-NONE", campaignDays: 5, amountCents: 20_000 }]);
    await expect(proposeCurrencyRule(pool, marketing, { platform: "google_ads", adAccountId: "ACC-NONE", reason: "the account reports in USD", now: NOW })).rejects.toThrow(ForbiddenError);
    await expect(proposeCurrencyRule(pool, engineer, { platform: "google_ads", adAccountId: "ACC-NONE", reason: "short", now: NOW })).rejects.toThrow(/at least 10/);

    const { ruleId } = await proposeCurrencyRule(pool, engineer, { platform: "google_ads", adAccountId: "ACC-NONE", reason: "the Google Ads account settings show USD", now: NOW });
    // A proposal alone counts nothing.
    expect(await one(pool, "select count(*)::int as n from raw_events where status = 'excluded' and exclusion_code = 'CURRENCY_UNSTATED'")).toEqual({ n: 5 });
    await expect(proposeCurrencyRule(pool, engineer, { platform: "google_ads", adAccountId: "ACC-NONE", reason: "the Google Ads account settings show USD", now: NOW })).rejects.toThrow(/already proposed or authorized/);
    await expect(authorizeCurrencyRule(pool, engineer, { ruleId, now: NOW })).rejects.toThrow(ForbiddenError);

    const { reprojected } = await authorizeCurrencyRule(pool, approver, { ruleId, now: NOW });
    expect(reprojected).toBe(5);
    expect(await one(pool, "select sum(s.cost_cents)::int as cents, min(s.currency_basis) as basis from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id where c.external_campaign_id = 'cr-none'")).toEqual({ cents: 20_000, basis: "account_rule_usd" });
    expect(await one(pool, "select count(*)::int as n from raw_events where status = 'excluded' and exclusion_code = 'CURRENCY_UNSTATED'")).toEqual({ n: 0 });
    const trail = await pool.query("select actor, action from audit_log where subject = $1 order by id", [`currency_rule:${ruleId}`]);
    expect(trail.rows).toEqual([{ actor: engineer.subject, action: "currency_rule_proposed" }, { actor: approver.subject, action: "currency_rule_authorized" }]);
    await expect(authorizeCurrencyRule(pool, approver, { ruleId, now: NOW })).rejects.toThrow(/already authorized/);
    // The campaign has a row now (its spend counts, unmapped): its customer leaves the held rule.
    const t = await traceBranchMetric(pool, marketing, { branchId: "B12", period: OCT, metric: "paid_cac" });
    expect(t.excluded.find((e) => e.code === "CAMPAIGN_SPEND_HELD")).toMatchObject({ count: 1 });
    expect(t.excluded.find((e) => e.code === "CAMPAIGN_UNMAPPED")).toMatchObject({ count: 1 });

    const { excluded } = await revokeCurrencyRule(pool, engineer, { ruleId, reason: "the account was moved to a CAD billing profile", now: NOW });
    expect(excluded).toBe(5);
    expect(await one(pool, "select count(*)::int as n from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id where c.external_campaign_id = 'cr-none'")).toEqual({ n: 0 });
    expect(await one(pool, "select count(*)::int as n from raw_events where status = 'excluded' and exclusion_code = 'CURRENCY_UNSTATED'")).toEqual({ n: 5 });
    // The campaign row survives the revoke; its customer still leaves the CAC with its spend, as
    // the CAD campaign's does (review 2026-11-12, financial finding 1: the held rule looked for
    // campaigns with no row).
    const [row] = await branchRows(pool, { from: OCT.from, to: OCT.to, branchIds: ["B12"] });
    expect({ paid: row.paidAcquired, held: row.heldCampaignAcquired }).toEqual({ paid: 2, held: 2 });
  });

  it("a replay keeps a gate-held record excluded, and an authorize later counts it (financial finding 2)", async () => {
    await ingest(pool, "ads", [spend("cr-rp", "ACC-RP", 4, 90)], { now: NOW });
    const raw = await one<{ id: string }>(pool, "select id from raw_events where payload ->> 'campaignId' = 'cr-rp'");
    // As if it had failed projection once: quarantined, then replayed.
    await pool.query("update raw_events set status = 'quarantined', error_code = 'PROJECTION_FAILED', exclusion_code = null where id = $1", [raw.id]);
    await replay(pool, { source: "ads", rawEventIds: [Number(raw.id)], mapperVersion: ACTIVE_VERSION.ads, actor: "engineer", idempotencyKey: "rp-1", dryRun: false, now: NOW, scope: { ...OCT, branchIds: null } });
    expect(await one(pool, "select status, exclusion_code from raw_events where id = $1", [raw.id])).toEqual({ status: "excluded", exclusion_code: "CURRENCY_UNSTATED" });
    const { ruleId } = await proposeCurrencyRule(pool, engineer, { platform: "google_ads", adAccountId: "ACC-RP", reason: "the account settings show USD billing", now: NOW });
    expect((await authorizeCurrencyRule(pool, approver, { ruleId, now: NOW })).reprojected).toBe(1);
  });

  it("an older version is never counted once a newer one was held, in one batch or two (financial finding 3)", async () => {
    const older = spend("cr-old", "ACC-OLD", 5, 900, { currencyCode: "USD", fetchedAt: "2026-10-06T06:00:00Z" });
    const newer = spend("cr-old", "ACC-OLD", 5, 500, { fetchedAt: "2026-10-07T06:00:00Z" });
    await ingest(pool, "ads", [older, newer], { now: NOW });
    expect(await one(pool, "select count(*)::int as n from ad_spend_daily")).toEqual({ n: 0 });
    await freshDb(pool, { currencyRule: false });
    await ingest(pool, "ads", [newer], { now: NOW });
    await ingest(pool, "ads", [older], { now: new Date(NOW.getTime() + 60_000) });
    expect(await one(pool, "select count(*)::int as n from ad_spend_daily")).toEqual({ n: 0 });
  });

  it("customers of a campaign with some days held stay in the CAC and are flagged (financial finding 4)", async () => {
    const ads: RawRecord[] = [];
    for (let d = 1; d <= 6; d++) ads.push(spend("cr-part", "ACC-PART", d, 50, d <= 3 ? { currencyCode: "USD" } : {}));
    await ingest(pool, "ads", ads, { now: NOW });
    const c = await one<{ id: string }>(pool, "select id from ad_campaigns where external_campaign_id = 'cr-part'");
    await mapCampaignToBranch(pool, { campaignId: Number(c.id), branchId: "B12", actor: "setup", reason: "fixture mapping", now: at(1) });
    const won = acquisition(1, "B12", "+14805571001", at(8), { source: "Google Ads" });
    (won.call.payload as Record<string, unknown>).campaign = "cr-part";
    await ingest(pool, "calls", [won.call], { now: NOW });
    await ingest(pool, "crm", won.crm, { now: NOW });
    await runReconcile(pool, NOW);
    const [row] = await branchRows(pool, { from: OCT.from, to: OCT.to, branchIds: ["B12"] });
    expect({ spend: row.paidSpendCents, paid: row.paidAcquired, held: row.heldCampaignAcquired, partly: row.partlyHeldAcquired }).toEqual({ spend: 15_000, paid: 1, held: 0, partly: 1 });
  });

  it("counts held spend once per campaign-day at its newest version, and not at all once a version counts (financial finding 6)", async () => {
    for (const [i, fetched] of ["2026-10-06T06:00:00Z", "2026-10-07T06:00:00Z", "2026-10-08T06:00:00Z"].entries()) {
      await ingest(pool, "ads", [spend("cr-3x", "ACC-3X", 5, 100 + i, { fetchedAt: fetched })], { now: new Date(NOW.getTime() + i * 60_000) });
    }
    expect(await accountsAwaitingCurrency(pool)).toEqual([{ platform: "google_ads", adAccountId: "ACC-3X", campaignDays: 1, amountCents: 10_200 }]);
    await ingest(pool, "ads", [spend("cr-3x", "ACC-3X", 5, 103, { currencyCode: "USD", fetchedAt: "2026-10-09T06:00:00Z" })], { now: new Date(NOW.getTime() + 5 * 60_000) });
    expect(await accountsAwaitingCurrency(pool)).toEqual([]);
  });

  it("a revoke excludes what the rule's own account counted, by the record's payload (financial finding 11)", async () => {
    await ingest(pool, "ads", [spend("cr-acct", "ACC-A", 2, 10, { currencyCode: "USD" })], { now: NOW });
    const { ruleId } = await proposeCurrencyRule(pool, engineer, { platform: "google_ads", adAccountId: "ACC-B", reason: "the account settings show USD billing", now: NOW });
    await authorizeCurrencyRule(pool, approver, { ruleId, now: NOW });
    // The campaign was first seen under ACC-A; this day reports under ACC-B, unstated.
    await ingest(pool, "ads", [spend("cr-acct", "ACC-B", 3, 20)], { now: NOW });
    expect(await one(pool, "select count(*)::int as n from ad_spend_daily where currency_basis = 'account_rule_usd'")).toEqual({ n: 1 });
    expect((await revokeCurrencyRule(pool, engineer, { ruleId, reason: "the account bills in CAD after all", now: NOW })).excluded).toBe(1);
    expect(await one(pool, "select count(*)::int as n from ad_spend_daily where currency_basis = 'account_rule_usd'")).toEqual({ n: 0 });
  });

  it("a revoke waits for an ads ingest in flight, so no spend stays counted under a revoked rule (authorization finding 1)", async () => {
    const { ruleId } = await proposeCurrencyRule(pool, engineer, { platform: "google_ads", adAccountId: "ACC-RACE", reason: "the account settings show USD billing", now: NOW });
    await authorizeCurrencyRule(pool, approver, { ruleId, now: NOW });
    const c1 = await pool.connect();
    try {
      await c1.query("begin");
      await ingestRecords(c1, { source: "ads", records: [spend("cr-race", "ACC-RACE", 6, 30)], mapper: mapperFor("ads"), ctx: referenceContext, runId: null, now: NOW });
      const revoking = revokeCurrencyRule(pool, engineer, { ruleId, reason: "the account was moved to CAD billing", now: NOW });
      // The revoke is blocked on the ingest's shared lock; the ingest commits first.
      await new Promise((r) => setTimeout(r, 300));
      await c1.query("commit");
      expect((await revoking).excluded).toBe(1);
    } finally {
      c1.release();
    }
    expect(await one(pool, "select count(*)::int as n from ad_spend_daily where currency_basis = 'account_rule_usd'")).toEqual({ n: 0 });
  });

  it("a newer revision of a campaign-day that drops the currency takes the older counted row out: the newest observation decides", async () => {
    await ingest(pool, "ads", [spend("cr-rev", "ACC-REV", 3, 70, { currencyCode: "USD" })], { now: NOW });
    expect(await one(pool, "select count(*)::int as n from ad_spend_daily")).toEqual({ n: 1 });
    await ingest(pool, "ads", [spend("cr-rev", "ACC-REV", 3, 70, { fetchedAt: "2026-10-05T06:00:00Z" })], { now: new Date(NOW.getTime() + 60_000) });
    expect(await one(pool, "select count(*)::int as n from ad_spend_daily")).toEqual({ n: 0 });
    expect(await one(pool, "select count(*)::int as n from raw_events where exclusion_code = 'CURRENCY_UNSTATED'")).toEqual({ n: 1 });
  });
});
