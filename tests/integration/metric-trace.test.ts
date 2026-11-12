import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapCampaignToBranch } from "@/lib/actions";
import type { Queryable } from "@/lib/db";
import { compareTraces, traceBranchMetric } from "@/lib/lineage/trace";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { ForbiddenError, VIEWERS } from "@/lib/viewer";
import { acquisition, call, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * Metric trace (lib/lineage/trace.ts): a number can be challenged without trusting anyone.
 * The fixture is built through intake, so every record the trace cites was produced by the
 * real pipeline.
 *
 *   gs-B12     Google Search, mapped to B12: 5 Oct days × $80 + 2 Sep days × $50; 2 paid
 *              customers in October credited to it (one with stated USD spend days).
 *   gs-B13     mapped to B13: spend that must NOT appear in B12's trace.
 *   lsa-new    unmapped, 3 leads at B12 and one customer credited to it: spend counts nowhere,
 *              and that customer leaves the denominator.
 *   a spam call at B12 (excluded at intake) and a malformed call at B12 (quarantined).
 */
const NOW = new Date("2026-10-31T13:00:00Z");
const { marketing, partner, guest } = VIEWERS;
const OCT = PERIODS.oct;
const SEP = PERIODS.sep;
const at = (m: number, d: number, minute = 0) => new Date(Date.UTC(2026, m - 1, d, 16, minute));
const ymd = (m: number, d: number) => `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;

function spend(campaignId: string, platform: string, m: number, d: number, dollars: number, extra: Record<string, unknown> = {}): RawRecord {
  return {
    entity: "spend_day",
    payload: { platform, accountId: "ACC-TR", campaignId, campaignName: `${campaignId} name`, date: ymd(m, d), costMicros: String(dollars * 1_000_000), clicks: 3, conversions: 1, fetchedAt: `${ymd(m, d + 1)}T06:00:00Z`, campaignType: platform === "google_lsa" ? "LOCAL_SERVICES" : "SEARCH", ...extra },
  };
}

let pool: Pool;
beforeAll(async () => {
  pool = testPool();
  await freshDb(pool);
  const ads: RawRecord[] = [];
  for (let d = 1; d <= 5; d++) ads.push(spend("gs-B12", "google_ads", 10, d, 80, d <= 2 ? { currencyCode: "USD" } : {}));
  for (let d = 10; d <= 11; d++) ads.push(spend("gs-B12", "google_ads", 9, d, 50));
  ads.push(spend("gs-B13", "google_ads", 10, 3, 999));
  for (let d = 2; d <= 4; d++) ads.push(spend("lsa-new", "google_lsa", 10, d, 40));
  await ingest(pool, "ads", ads, { now: NOW });
  const id = async (ext: string) => Number((await one<{ id: string }>(pool, "select id from ad_campaigns where external_campaign_id = $1", [ext])).id);
  await mapCampaignToBranch(pool, { campaignId: await id("gs-B12"), branchId: "B12", actor: "setup", reason: "fixture", now: at(9, 1) });
  await mapCampaignToBranch(pool, { campaignId: await id("gs-B13"), branchId: "B13", actor: "setup", reason: "fixture", now: at(9, 1) });

  const calls: RawRecord[] = [];
  for (let i = 0; i < 3; i++) calls.push(call(`TR-LSA-${i}`, "B12", `+1480558${String(1000 + i)}`, at(10, 3, i), "Google LSA", { campaign: "lsa-new" }));
  calls.push(call("TR-SPAM", "B12", "+14805589990", at(10, 4), "Google Ads", { campaign: "gs-B12", spam: true }));
  calls.push({ entity: "call", payload: { id: "TR-BAD", branch_tag: "B12", start_time: at(10, 4).toISOString(), source: "Google Ads" } });
  await ingest(pool, "calls", calls, { now: NOW });

  const customers = [
    { n: 1, campaign: "gs-B12", source: "Google Ads", day: 6 },
    { n: 2, campaign: "gs-B12", source: "Google Ads", day: 8 },
    { n: 3, campaign: "lsa-new", source: "Google LSA", day: 7 },
  ];
  for (const k of customers) {
    const won = acquisition(k.n, "B12", `+1480559${String(1000 + k.n)}`, at(10, k.day), { source: k.source });
    (won.call.payload as Record<string, unknown>).campaign = k.campaign;
    await ingest(pool, "calls", [won.call], { now: NOW });
    await ingest(pool, "crm", won.crm, { now: NOW });
  }
  await runReconcile(pool, NOW);
}, 120_000);
afterAll(async () => pool?.end());

describe("metric trace · paid CAC for one branch", () => {
  it("reproduces the scorecard's number exactly from the records it lists", async () => {
    const t = await traceBranchMetric(pool, marketing, { branchId: "B12", period: OCT, metric: "paid_cac" });
    const [row] = await branchRows(pool, { from: OCT.from, to: OCT.to, branchIds: ["B12"] });
    expect(t.value.matches).toBe(true);
    expect(t.value.reproduced).toEqual(t.value.scorecard);
    expect(t.value.scorecard).toMatchObject({ paidSpendCents: row.paidSpendCents, paidAcquired: row.paidAcquired });
    expect(t.value.reproduced).toEqual({ paidSpendCents: 40_000, paidAcquired: 2, paidCacCents: 20_000 });
    expect(t.metric.definitionVersion).toMatch(/^v2/);
  });

  it("names each campaign's mapping, the mapper versions and raw events behind its spend, and the currency basis", async () => {
    const t = await traceBranchMetric(pool, marketing, { branchId: "B12", period: OCT, metric: "paid_cac" });
    expect(t.numerator.campaigns.map((c) => c.externalCampaignId)).toEqual(["gs-B12"]); // gs-B13 is another branch's
    const c = t.numerator.campaigns[0];
    expect(c).toMatchObject({ spendCents: 40_000, spendDays: 5, firstDay: "2026-10-01", lastDay: "2026-10-05", assumedCurrencyCents: 24_000, mapping: { branchId: "B12", mappedBy: "setup" } });
    expect(c.mapperVersions).toEqual({ "ads@1.2": 5 });
    expect(c.sampleRawEventIds).toHaveLength(3);
    for (const ref of c.sampleRawEventIds) {
      const raw = await one<{ source: string; status: string }>(pool, "select source, status from raw_events where id = $1", [Number(ref.split(":")[1])]);
      expect(raw).toEqual({ source: "ads", status: "projected" });
    }
    expect(t.limitations.some((l) => l.includes("$240.00") && l.includes("taken as USD"))).toBe(true);
  });

  it("lists each counted customer with the lead that credits them, and what the definition leaves out", async () => {
    const t = await traceBranchMetric(pool, marketing, { branchId: "B12", period: OCT, metric: "paid_cac" });
    expect(t.denominator.count).toBe(2);
    for (const k of t.denominator.customers) {
      expect(k).toMatchObject({ channelCode: "google_search", campaignExternalId: "gs-B12", attributionBasis: "lead_evidence" });
      expect(k.leadEvidenceId).toMatch(/^lead:\d+$/);
      expect(k.leadRawEventId).toMatch(/^raw_event:\d+$/);
    }
    expect(t.excluded).toEqual([expect.objectContaining({ code: "CAMPAIGN_UNMAPPED", count: 1, evidenceIds: ["customer:1003"] })]);
  });

  it("shows records excluded or held at intake, and the evidence the number cannot see", async () => {
    const t = await traceBranchMetric(pool, marketing, { branchId: "B12", period: OCT, metric: "paid_cac" });
    expect(t.sourceRecords).toEqual(expect.arrayContaining([
      expect.objectContaining({ source: "calls", status: "excluded", code: "SPAM_CALL", count: 1 }),
      expect.objectContaining({ source: "calls", status: "quarantined", count: 1 }),
    ]));
    const unmapped = t.missing.find((m) => m.kind === "unmapped_campaign");
    expect(unmapped?.detail).toContain("lsa-new has 4 lead(s) at B12");
    expect(unmapped?.detail).toContain("$120.00");
    expect(t.missing.some((m) => m.kind === "quarantined_records")).toBe(true);
  });

  it("carries no phone number or contact hash", async () => {
    const t = await traceBranchMetric(pool, marketing, { branchId: "B12", period: OCT, metric: "paid_cac" });
    const text = JSON.stringify(t);
    expect(text).not.toMatch(/\+1\d{10}/);
    const hash = await one<{ phone_hash: string }>(pool, "select phone_hash from leads where phone_hash is not null limit 1");
    expect(text).not.toContain(hash.phone_hash);
  });

  it("refuses a branch outside the viewer's scope", async () => {
    await expect(traceBranchMetric(pool, partner, { branchId: "B12", period: OCT, metric: "paid_cac" })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(traceBranchMetric(pool, guest, { branchId: "B12", period: OCT, metric: "paid_cac" })).resolves.toBeTruthy(); // read-only roles may read in scope
  });

  it("reports a discrepancy instead of hiding it when the scorecard and the records disagree (negative control)", async () => {
    // The scorecard query is the first one the trace runs; return a doctored value from it.
    let first = true;
    const doctored: Queryable = {
      query: (async (text: string, values?: unknown[]) => {
        const r = await pool.query(text, values);
        if (first && text.includes("with p as") && text.includes("leadagg")) {
          first = false;
          r.rows = r.rows.map((row) => ({ ...row, cost: String(Number(row.cost) + 1) }));
        }
        return r;
      }) as Queryable["query"],
    } as Queryable;
    const t = await traceBranchMetric(doctored, marketing, { branchId: "B12", period: OCT, metric: "paid_cac" });
    expect(t.value.matches).toBe(false);
    expect(t.value.discrepancies[0]).toContain("40001");
  });

  it("counts an unmapped campaign's leads in the period only (independent review F7)", async () => {
    const sep = await traceBranchMetric(pool, marketing, { branchId: "B12", period: SEP, metric: "paid_cac" });
    expect(sep.missing.some((m) => m.kind === "unmapped_campaign")).toBe(false); // lsa-new's leads are all in October
  });

  it("explains what changed between two periods, campaign by campaign", async () => {
    const sep = await traceBranchMetric(pool, marketing, { branchId: "B12", period: SEP, metric: "paid_cac" });
    const oct = await traceBranchMetric(pool, marketing, { branchId: "B12", period: OCT, metric: "paid_cac" });
    const diff = compareTraces(sep, oct);
    expect(diff).toMatchObject({ spendDeltaCents: 30_000, customersDelta: 2 });
    expect(diff.campaigns).toEqual([expect.objectContaining({ externalCampaignId: "gs-B12", beforeCents: 10_000, afterCents: 40_000, deltaCents: 30_000 })]);
  });

  // Last: it adds a held record to the shared fixture.
  it("shows spend held at intake for a campaign mapped to the branch (independent review F6)", async () => {
    await ingest(pool, "ads", [spend("gs-B12", "google_ads", 10, 6, 500, { currencyCode: "CAD" })], { now: NOW });
    const t = await traceBranchMetric(pool, marketing, { branchId: "B12", period: OCT, metric: "paid_cac" });
    expect(t.sourceRecords).toEqual(expect.arrayContaining([expect.objectContaining({ source: "ads", status: "quarantined", code: "CURRENCY_UNSUPPORTED", count: 1 })]));
    expect(t.missing.some((m) => m.kind === "quarantined_records")).toBe(true);
    expect(t.value.reproduced.paidSpendCents).toBe(40_000); // never summed
  });
});
