import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapCampaignToBranch } from "@/lib/actions";
import { budgetSignal } from "@/lib/metrics/decision";
import { getCustomerJourney } from "@/lib/identity/journey";
import { traceAttribution, traceCash } from "@/lib/lineage/cash";
import { traceBranchMetric } from "@/lib/lineage/trace";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { referenceState } from "@/lib/twin/oracle";
import { ForbiddenError, VIEWERS } from "@/lib/viewer";
import { acquisition, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * R-46: a bare campaign id does not identify an ad campaign. Leads carry a campaign id without
 * an ad platform, and two platforms can use the same id. A lead's campaign is the campaign with
 * that id on the platform the lead's OWN record names (the call-tracking source label, a Google
 * click id, a paid utm_source), and nothing else: not "the only campaign with this id today".
 * When the record names no platform, or two, the campaign stays unresolved and the customer is
 * counted as a customer whose lead carries no campaign is. Nothing is dropped and no amount moves.
 *
 * The fixture: three ids, each used by a Google Ads and a Meta campaign in different accounts.
 *
 *   id   Google Ads campaign (account)             Meta campaign (account)
 *   123  "G 123 search" (ACC-G) → B12, $100.00     "M 123 prospecting" (ACC-M) → no branch, $30.00
 *   456  "G 456 search" (ACC-G2) → B13, $40.00     "M 456 prospecting" (ACC-M) → B20, $60.00
 *   789  "G 789 search" (ACC-G) → B13, $25.00      "M 789 prospecting" (ACC-M2): all spend held (CAD), $70.00
 *
 * Seven October customers, $149.00 collected from each. Each customer's only lead:
 *
 *   c1  B12  call "Google Ads", gclid, id 123             names Google Ads      → "G 123 search"
 *   c2  B12  web form, gclid AND utm facebook/paid_social names Google Ads + Meta → unresolved (conflicting)
 *   c3  B12  call "Direct", id 123                        names no platform     → unresolved (no platform)
 *   c4  B12  call "Facebook", id 123                      names Meta            → "M 123 prospecting"
 *   c5  B13  call "Google Ads", id 456                    names Google Ads      → "G 456 search"
 *   c6  B20  call "Facebook", id 456                      names Meta            → "M 456 prospecting"
 *   c7  B13  call "Google Ads", id 789                    names Google Ads      → "G 789 search"
 *
 * EXPECTED, written by hand from the table above on 2026-11-13, before the change, and not
 * computed by any product query or by the twin's reference:
 *
 *   Branch  paid spend  acquired  paid customers                 unknown  collected  paid CAC
 *   B12     $100.00     4         2 (c1; c2 unresolved)          1 (c3)   $596.00    $50.00
 *   B13     $65.00      2         2 (c5, c7)                     0        $298.00    $32.50
 *   B20     $60.00      1         1 (c6)                         0        $149.00    $60.00
 *
 *   - c4 is left out of B12's paid customers: its campaign (M 123) is mapped to no branch, so its
 *     cost is unallocated ($30.00). c2's and c3's campaigns are unresolved, so no campaign's
 *     mapping or held status is applied to them: c2 is counted (paid channel), c3 is not paid.
 *   - c7 is counted: its campaign G 789 is mapped and none of its spend is held. The held spend
 *     is M 789's, on another platform.
 *   - Spend: $100 + $30 + $40 + $60 + $25 = $255.00 counted; M 789's $70.00 is held and counts
 *     nowhere. Branch paid spend ($225.00) + unallocated ($30.00) = $255.00.
 *   - The B12 trace lists c1 and c2, leaves out c4 as "campaign mapped to no branch", names
 *     M 123 as an unmapped campaign with one lead at B12, and explains the two unresolved ids.
 *   - The unmapped M 123 holds B12's budget signal only.
 *   - A viewer scoped to B20 sees c6 credited to "M 456 prospecting", and no Google campaign,
 *     account or other branch anywhere in B20's journey or trace.
 *
 * With the id alone (before this change): B12 counted 0 paid customers (c1, c2, c4 all fell to
 * the unmapped M 123) and B13 counted 1 (c7 fell to M 789's held spend); c2's, c3's and c6's
 * journeys showed a Google campaign (the lowest id among those sharing the id): c6, a B20
 * customer, was shown B13's "G 456 search".
 */
const pool: Pool = testPool();
afterAll(async () => pool.end());

const NOW = new Date("2026-10-31T13:00:00Z");
const OCT = PERIODS.oct;
const at = (day: number) => new Date(Date.UTC(2026, 9, day, 16));
const { marketing, partner } = VIEWERS;

const spend = (platform: "google_ads" | "meta", account: string, id: string, name: string, date: string, dollars: number, currency = "USD"): RawRecord => ({
  entity: "spend_day",
  payload: {
    platform, accountId: account, campaignId: id, campaignName: name, date, costMicros: String(dollars * 1_000_000), clicks: 3, conversions: 1,
    fetchedAt: `${date}T23:00:00Z`, currencyCode: currency, ...(platform === "google_ads" ? { campaignType: "SEARCH" } : {}),
  },
});

const phone = (n: number) => `+1480556${String(1000 + n)}`;
const SALE = { 1: 10, 2: 11, 3: 12, 4: 13, 5: 14, 6: 15, 7: 16 } as const;

beforeAll(async () => {
  await freshDb(pool);
  // Google first, so the Google campaigns get the lower ids (the old lookup took the lowest).
  await ingest(pool, "ads", [
    spend("google_ads", "ACC-G", "123", "G 123 search", "2026-10-03", 50),
    spend("google_ads", "ACC-G", "123", "G 123 search", "2026-10-04", 50),
    spend("google_ads", "ACC-G2", "456", "G 456 search", "2026-10-05", 40),
    spend("google_ads", "ACC-G", "789", "G 789 search", "2026-10-06", 25),
  ], { now: NOW });
  await ingest(pool, "ads", [
    spend("meta", "ACC-M", "123", "M 123 prospecting", "2026-10-03", 30),
    spend("meta", "ACC-M", "456", "M 456 prospecting", "2026-10-05", 60),
    spend("meta", "ACC-M2", "789", "M 789 prospecting", "2026-10-06", 70, "CAD"),
  ], { now: NOW });
  const campaign = async (platform: string, id: string) => Number((await one<{ id: string }>(pool, "select id from ad_campaigns where platform = $1 and external_campaign_id = $2", [platform, id])).id);
  for (const [platform, id, branchId] of [["google_ads", "123", "B12"], ["google_ads", "456", "B13"], ["meta", "456", "B20"], ["google_ads", "789", "B13"]] as const) {
    await mapCampaignToBranch(pool, { campaignId: await campaign(platform, id), branchId, actor: "setup", reason: "fixture mapping", now: at(1) });
  }

  const c = (n: keyof typeof SALE, branchId: string, source: string, extra: Record<string, unknown>) => {
    const won = acquisition(n, branchId, phone(n), at(SALE[n]), { source });
    Object.assign(won.call.payload as Record<string, unknown>, extra);
    return won;
  };
  const calls = [
    c(1, "B12", "Google Ads", { campaign: "123", gclid: "gclid-c1" }),
    c(3, "B12", "Direct", { campaign: "123" }),
    c(4, "B12", "Facebook", { campaign: "123" }),
    c(5, "B13", "Google Ads", { campaign: "456" }),
    c(6, "B20", "Facebook", { campaign: "456" }),
    c(7, "B13", "Google Ads", { campaign: "789" }),
  ];
  const c2 = acquisition(2, "B12", phone(2), at(SALE[2]));
  await ingest(pool, "calls", calls.map((w) => w.call), { now: NOW });
  await ingest(pool, "web", [{
    entity: "lead",
    payload: {
      messageId: "W-C2", timestamp: new Date(at(SALE[2]).getTime() - 3_600_000).toISOString(),
      properties: { form: "quote", branch_id: "B12", zip: "10001", phone: phone(2), email: null, utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "123", gclid: "gclid-c2", message: null },
    },
  }], { now: NOW });
  await ingest(pool, "crm", [...calls.flatMap((w) => w.crm), ...c2.crm], { now: NOW });
  await runReconcile(pool, NOW);
}, 120_000);

const row = async (branchId: string) => (await branchRows(pool, { from: OCT.from, to: OCT.to, branchIds: [branchId] }))[0];
const journey = async (n: number, scope: string[] | null = null) => (await getCustomerJourney(pool, 1000 + n, scope))!.attribution!;

describe("campaign attribution: the platform the lead's own record names, then the id", () => {
  it("matches a lead to the campaign on its named platform, and leaves a missing or conflicting platform unresolved", async () => {
    const got = Object.fromEntries(
      await Promise.all([1, 2, 3, 4, 5, 6, 7].map(async (n) => {
        const a = await journey(n);
        return [`c${n}`, { id: a.campaignExternalId, name: a.campaignName, platform: a.campaignPlatform, match: a.campaignMatch }];
      })),
    );
    expect(got).toEqual({
      c1: { id: "123", name: "G 123 search", platform: "google_ads", match: "matched" },
      c2: { id: "123", name: null, platform: null, match: "conflicting_platforms" },
      c3: { id: "123", name: null, platform: null, match: "no_platform" },
      c4: { id: "123", name: "M 123 prospecting", platform: "meta", match: "matched" },
      c5: { id: "456", name: "G 456 search", platform: "google_ads", match: "matched" },
      c6: { id: "456", name: "M 456 prospecting", platform: "meta", match: "matched" },
      c7: { id: "789", name: "G 789 search", platform: "google_ads", match: "matched" },
    });
  });
});

describe("the scorecard and its trace agree with the expectations", () => {
  it("counts the paid customers the expectations count", async () => {
    const pick = async (b: string) => {
      const r = await row(b);
      return { spend: r.paidSpendCents, acquired: r.acquired, paid: r.paidAcquired, held: r.heldCampaignAcquired, partlyHeld: r.partlyHeldAcquired, unknown: r.unknownAcquired, collected: r.collectedCents };
    };
    expect(await pick("B12")).toEqual({ spend: 10_000, acquired: 4, paid: 2, held: 0, partlyHeld: 0, unknown: 1, collected: 59_600 });
    expect(await pick("B13")).toEqual({ spend: 6_500, acquired: 2, paid: 2, held: 0, partlyHeld: 0, unknown: 0, collected: 29_800 });
    expect(await pick("B20")).toEqual({ spend: 6_000, acquired: 1, paid: 1, held: 0, partlyHeld: 0, unknown: 0, collected: 14_900 });
  });

  it("the trace lists the same customers, leaves out c4 for its unmapped campaign, and explains both unresolved ids", async () => {
    const t = await traceBranchMetric(pool, marketing, { branchId: "B12", period: OCT, metric: "paid_cac" });
    expect(t.value.matches).toBe(true);
    expect(t.value.reproduced).toEqual({ paidSpendCents: 10_000, paidAcquired: 2, paidCacCents: 5_000 });
    expect(t.denominator.customers.map((k) => k.crmCustomerId).sort()).toEqual([1001, 1002]);
    expect(t.excluded.map((e) => [e.code, e.count])).toEqual([["CAMPAIGN_UNMAPPED", 1]]);
    expect(t.excluded[0].evidenceIds).toEqual(["customer:1004"]);
    const campaigns = t.missing.filter((m) => m.kind === "unmapped_campaign" || m.kind === "campaign_unresolved");
    expect(campaigns.map((m) => ({ kind: m.kind, id: m.campaignExternalId, leads: m.leads, spend: m.spendCents, reason: m.reason, customers: m.customers }))).toEqual([
      { kind: "unmapped_campaign", id: "123", leads: 1, spend: 3_000, reason: undefined, customers: undefined },
      { kind: "campaign_unresolved", id: "123", leads: 1, spend: undefined, reason: "conflicting_platforms", customers: 1 },
      { kind: "campaign_unresolved", id: "123", leads: 1, spend: undefined, reason: "no_platform", customers: 0 },
    ]);
    // The unmapped campaign is the Meta one (its record), not the mapped Google one with the same id.
    const m123 = await one<{ id: string }>(pool, "select id from ad_campaigns where platform = 'meta' and external_campaign_id = '123'");
    expect(campaigns[0].evidenceIds).toEqual([`campaign:${m123.id}`]);

    const b13 = await traceBranchMetric(pool, marketing, { branchId: "B13", period: OCT, metric: "paid_cac" });
    expect([b13.value.matches, b13.denominator.customers.map((k) => k.crmCustomerId).sort(), b13.excluded]).toEqual([true, [1005, 1007], []]);
  });

  it("source spend and cash reconcile: nothing moved, nothing became zero", async () => {
    const counted = await one<{ cents: string }>(pool, "select sum(cost_cents) as cents from ad_spend_daily");
    expect(Number(counted.cents)).toBe(25_500);
    const unallocated = await one<{ cents: string }>(pool, "select sum(s.cost_cents) as cents from ad_spend_daily s where not exists (select 1 from campaign_branch_map m where m.campaign_id = s.campaign_id)");
    const branches = (await row("B12")).paidSpendCents + (await row("B13")).paidSpendCents + (await row("B20")).paidSpendCents;
    expect(branches + Number(unallocated.cents)).toBe(25_500);
    const held = await one<{ n: string }>(pool, "select count(*) as n from raw_events where source = 'ads' and status in ('quarantined', 'excluded') and payload ->> 'campaignId' = '789' and payload ->> 'platform' = 'meta'");
    expect(Number(held.n)).toBe(1);
    for (const [b, cents] of [["B12", 59_600], ["B13", 29_800], ["B20", 14_900]] as const) {
      const cash = await traceCash(pool, marketing, { branchId: b, period: OCT });
      expect([b, cash.value.matches, cash.value.reproduced.collectedCents]).toEqual([b, true, cents]);
      expect((await traceAttribution(pool, marketing, { branchId: b, period: OCT })).value.matches).toBe(true);
    }
  });

  it("the twin's reference counts the same paid customers", async () => {
    const ref = await referenceState(pool, { onNewVersion: [], period: OCT });
    const pick = (b: string) => ({ acquired: ref.branches.get(b)?.acquired, paid: ref.branches.get(b)?.paidAcquired, unknown: ref.branches.get(b)?.unknownAcquired });
    expect([pick("B12"), pick("B13"), pick("B20")]).toEqual([
      { acquired: 4, paid: 2, unknown: 1 },
      { acquired: 2, paid: 2, unknown: 0 },
      { acquired: 1, paid: 1, unknown: 0 },
    ]);
  });

  it("the unmapped Meta campaign holds B12's budget signal, and no other branch's", async () => {
    const unmapped = await one<{ id: string }>(pool, "select id from exceptions where kind = 'unmapped_spend' and status = 'open' and evidence ->> 'externalCampaignId' = '123'");
    const holds = async (b: string) => (await budgetSignal(pool, b, { from: OCT.from, to: OCT.to })).blockers.some((x) => x.exceptionId === Number(unmapped.id));
    expect([await holds("B12"), await holds("B13"), await holds("B20")]).toEqual([true, false, false]);
  });
});

describe("a viewer scoped to B20 sees its own campaign and nothing of another scope", () => {
  const OTHER = ["G 123", "G 456", "G 789", "ACC-G", "B12", "B13"];
  const leaks = (value: unknown) => OTHER.filter((s) => JSON.stringify(value).includes(s));

  it("c6's journey names B20's Meta campaign, not B13's Google campaign with the same id", async () => {
    const full = await getCustomerJourney(pool, 1006, partner.branchIds);
    expect(full!.attribution).toMatchObject({ campaignExternalId: "456", campaignName: "M 456 prospecting", campaignPlatform: "meta", campaignMatch: "matched" });
    expect(leaks(full)).toEqual([]);
  });

  it("B20's trace names nothing outside B20, and the other branches' traces are refused", async () => {
    const t = await traceBranchMetric(pool, partner, { branchId: "B20", period: OCT, metric: "paid_cac" });
    expect([t.value.matches, t.denominator.customers.map((k) => k.crmCustomerId)]).toEqual([true, [1006]]);
    expect(leaks(t)).toEqual([]);
    await expect(traceBranchMetric(pool, partner, { branchId: "B12", period: OCT, metric: "paid_cac" })).rejects.toBeInstanceOf(ForbiddenError);
    expect(await getCustomerJourney(pool, 1005, partner.branchIds)).toBeNull();
  });
});
