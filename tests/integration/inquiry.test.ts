import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapCampaignToBranch } from "@/lib/actions";
import { mapperFor } from "@/lib/adapters/registry";
import { addInquiryNote, getInquiry, listInquiries, openCacInquiry, retestInquiry } from "@/lib/inquiry/store";
import { ForbiddenError, VIEWERS } from "@/lib/viewer";
import { acquisition, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * "Why did B09's paid CAC increase?" as six hypotheses tested against worlds built for each
 * verdict (lib/inquiry/cac-change.ts), and the workspace that keeps them (lib/inquiry/store.ts).
 */
const NOW = new Date("2026-10-31T13:00:00Z");
const at = (m: number, d: number, minute = 0) => new Date(Date.UTC(2026, m - 1, d, 16, minute));
const ymd = (m: number, d: number) => `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const { marketing, partner, guest } = VIEWERS;
const STREAMS: Array<[string, string]> = [["ads", "ads"], ["calls", "calls"], ["web", "web"], ["d2d", "d2d"], ["crm.customer", "crm"], ["crm.subscription", "crm"], ["crm.appointment", "crm"], ["crm.ticket", "crm"], ["crm.payment", "crm"]];

let pool: Pool;
beforeEach(async () => {
  pool ??= testPool();
  await freshDb(pool);
}, 60_000);
afterAll(async () => pool?.end());

function spend(m: number, d: number, dollars: number, campaignId = "inq-gs"): RawRecord {
  return { entity: "spend_day", payload: { platform: "google_ads", accountId: "ACC-INQ", campaignId, campaignName: `${campaignId} search`, date: ymd(m, d), costMicros: String(dollars * 1_000_000), clicks: 4, conversions: 1, fetchedAt: `${ymd(m, d)}T23:00:00Z`, campaignType: "SEARCH", currencyCode: "USD" } };
}

/**
 * B09: September $1,000 of spend and 10 paid customers ($100.00); October $1,500 and 6 paid
 * customers ($250.00). Every feed fresh. `octSpendStopsDay`: the campaign's October spend ends that day.
 */
async function world(opts: { octSpendStopsDay?: number; octCustomers?: number; freshFeeds?: boolean } = {}) {
  const ads: RawRecord[] = [];
  for (let d = 1; d <= 10; d++) ads.push(spend(9, d, 100));
  const lastOct = opts.octSpendStopsDay ?? 30;
  const days = lastOct; // spread $1,500 over the October days that have spend
  for (let d = 1; d <= days; d++) ads.push(spend(10, d, Math.round(1500 / days)));
  await ingest(pool, "ads", ads, { mapper: mapperFor("ads", "1.2"), now: NOW });
  const c = await one<{ id: string }>(pool, "select id from ad_campaigns where external_campaign_id = 'inq-gs'");
  await mapCampaignToBranch(pool, { campaignId: Number(c.id), branchId: "B09", actor: "setup", reason: "fixture mapping", now: at(9, 1) });
  let n = 0;
  const customer = async (m: number, d: number) => {
    n += 1;
    const won = acquisition(n, "B09", `+1480554${String(1000 + n)}`, at(m, d), { source: "Google Ads" });
    (won.call.payload as Record<string, unknown>).campaign = "inq-gs";
    await ingest(pool, "calls", [won.call], { now: NOW });
    await ingest(pool, "crm", won.crm, { now: NOW });
  };
  // Sales spread over days 1–28: the first service is 48 h later, still inside the month.
  const spread = (i: number, count: number) => 1 + Math.floor((i * 27) / Math.max(1, count - 1));
  for (let i = 0; i < 10; i++) await customer(9, spread(i, 10));
  const octCount = opts.octCustomers ?? 6;
  for (let i = 0; i < octCount; i++) await customer(10, spread(i, octCount));
  if (opts.freshFeeds !== false) {
    for (const [stream, source] of STREAMS) {
      await pool.query("insert into ingestion_runs (source, stream, adapter_version, started_at, finished_at, status) values ($1, $2, 'test', $3, $3, 'succeeded')", [source, stream, new Date(NOW.getTime() - 3_600_000)]);
    }
  }
  await runReconcile(pool, NOW);
}

describe("why did paid CAC increase: six hypotheses", () => {
  it("supports spend up and fewer paid customers, contradicts misclassification, missing data and a definition change", async () => {
    await world();
    const id = await openCacInquiry(pool, marketing, { branchId: "B09", now: NOW });
    const w = (await getInquiry(pool, marketing, id))!;
    const r = w.result;
    expect(r.premise).toMatchObject({ holds: true, sepCacCents: 10_000 });
    const status = Object.fromEntries(r.hypotheses.map((h) => [h.code, h.status]));
    expect(status).toMatchObject({ H1: "SUPPORTED", H2: "SUPPORTED", H3: "CONTRADICTED", H4: "CONTRADICTED", H5: "CONTRADICTED" });
    expect(["SUPPORTED", "CONTRADICTED", "UNRESOLVED", "NOT_TESTABLE"]).toContain(status.H6);
    expect(r.conclusion.drivers).toEqual(expect.arrayContaining(["H1", "H2"]));
    expect(r.decomposition!.spendShare + r.decomposition!.customerShare).toBeCloseTo(1, 6);
    // Every hypothesis says how it was tested and what would change it.
    for (const h of r.hypotheses) {
      expect(h.test.length).toBeGreaterThan(20);
      expect(h.wouldChange.length).toBeGreaterThan(10);
    }
    expect(r.reads).toBeLessThanOrEqual(12);
  });

  it("supports missing data only in the direction that raises CAC: stale customer feeds; stopped spend points the other way", async () => {
    await world({ octSpendStopsDay: 18, freshFeeds: false });
    const id = await openCacInquiry(pool, marketing, { branchId: "B09", now: NOW });
    const h4 = (await getInquiry(pool, marketing, id))!.result.hypotheses.find((h) => h.code === "H4")!;
    expect(h4.status).toBe("SUPPORTED");
    expect(h4.evidence.map((e) => e.label)).toEqual(expect.arrayContaining(["Feed calls", "Feed crm.payment"]));
    // Stopped October spend and a stale ads feed would LOWER October CAC (review 2026-11-12, financial 8).
    expect(h4.counterevidence.map((e) => e.label)).toEqual(expect.arrayContaining(["Campaign inq-gs", "Feed ads"]));
  });

  it("a campaign that only stopped spending does not support H4 (financial 8)", async () => {
    await world({ octSpendStopsDay: 18 });
    const id = await openCacInquiry(pool, marketing, { branchId: "B09", now: NOW });
    const h4 = (await getInquiry(pool, marketing, id))!.result.hypotheses.find((h) => h.code === "H4")!;
    expect(h4.status).toBe("CONTRADICTED");
    expect(h4.counterevidence.map((e) => e.label)).toContain("Campaign inq-gs");
  });

  it("the decomposition's two parts add to 100%, unclamped (financial 12)", async () => {
    await world();
    const id = await openCacInquiry(pool, marketing, { branchId: "B09", now: NOW });
    const d = (await getInquiry(pool, marketing, id))!.result.decomposition!;
    expect(d.spendShare + d.customerShare).toBeCloseTo(1, 12);
  });

  it("answers that there is nothing to explain when CAC did not increase", async () => {
    await world({ octCustomers: 15 });
    const id = await openCacInquiry(pool, marketing, { branchId: "B09", now: NOW });
    const r = (await getInquiry(pool, marketing, id))!.result;
    expect(r.premise.holds).toBe(false);
    expect(r.conclusion.status).toBe("premise_false");
    expect(r.hypotheses.find((h) => h.code === "H2")!.status).toBe("CONTRADICTED");
  });
});

describe("the workspace", () => {
  it("keeps every version, shows what changed, takes notes, and is scoped like its branch", async () => {
    await world();
    const id = await openCacInquiry(pool, marketing, { branchId: "B09", now: NOW });
    // New October paid customers arrive: H2 no longer holds on a re-test.
    let n = 100;
    for (let i = 0; i < 10; i++) {
      n += 1;
      const won = acquisition(n, "B09", `+1480553${String(1000 + n)}`, at(10, 3 + i), { source: "Google Ads" });
      (won.call.payload as Record<string, unknown>).campaign = "inq-gs";
      await ingest(pool, "calls", [won.call], { now: NOW });
      await ingest(pool, "crm", won.crm, { now: NOW });
    }
    expect(await retestInquiry(pool, marketing, { id, now: NOW })).toBe(2);
    const w = (await getInquiry(pool, marketing, id))!;
    expect(w.version).toBe(2);
    expect(w.previous?.find((p) => p.code === "H2")?.status).toBe("SUPPORTED");
    expect(w.result.hypotheses.find((h) => h.code === "H2")?.status).toBe("CONTRADICTED");
    await addInquiryNote(pool, marketing, { id, text: "Checked the October call feed by hand.", now: NOW });
    expect((await getInquiry(pool, marketing, id))!.notes.map((x) => x.text)).toEqual(["Checked the October call feed by hand."]);
    expect((await listInquiries(pool, marketing)).map((x) => x.id)).toContain(id);
    // Out of scope: not found, not listed, not openable; a guest cannot investigate at all.
    expect(await getInquiry(pool, partner, id)).toBeNull();
    expect((await listInquiries(pool, partner)).map((x) => x.id)).not.toContain(id);
    await expect(openCacInquiry(pool, partner, { branchId: "B09", now: NOW })).rejects.toThrow(ForbiddenError);
    await expect(openCacInquiry(pool, guest, { branchId: "B09", now: NOW })).rejects.toThrow(ForbiddenError);
    // Re-testing or annotating another branch's investigation answers as a missing one does: the
    // id must not reveal that it exists (review 2026-11-12, A-3).
    await expect(retestInquiry(pool, partner, { id, now: NOW })).rejects.toMatchObject({ status: 404, message: "Investigation not found" });
    await expect(addInquiryNote(pool, partner, { id, text: "probing another branch", now: NOW })).rejects.toMatchObject({ status: 404, message: "Investigation not found" });
    await expect(retestInquiry(pool, partner, { id: id + 999, now: NOW })).rejects.toMatchObject({ status: 404, message: "Investigation not found" });
    expect(await one(pool, "select count(*)::int as n from audit_log where subject = $1", [`inquiry:${id}`])).toEqual({ n: 2 });
  });
});
