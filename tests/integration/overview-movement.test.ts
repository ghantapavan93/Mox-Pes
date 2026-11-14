import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor } from "@/lib/adapters/registry";
import { decisionHolds } from "@/lib/metrics/decision";
import { branchRows } from "@/lib/metrics/scorecard";
import { explainCell, pointTitle, takeaway } from "@/lib/metrics/movement-copy";
import { movement, overviewMovement, spendDays } from "@/lib/metrics/movement";
import { PERIODS } from "@/lib/period";
import { VIEWERS, type Viewer } from "@/lib/viewer";
import { acquisition, call, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * The Overview's "What changed" read model (lib/metrics/movement.ts) against the stored records it
 * summarises, on the ChangeGuard B09 world: Google Local Services migrates to a Performance Max
 * campaign on Oct 13 and ads@1.0 files that as Search, so Local Services spend stops while its
 * calls keep arriving (a coverage-gap incident). B07's Meta campaign reports a week of $0.00 (a
 * real zero) and then nothing (missing).
 *
 * Every number is checked against the records, not against another rendering of itself.
 */

const NOW = new Date("2026-10-31T13:00:00Z");
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const at = (d: number, hour = 15) => new Date(`${day(d)}T${String(hour).padStart(2, "0")}:00:00Z`);
const MIGRATION_DAY = 13;
const OCT = PERIODS.oct;

function spend(campaign: "lsa" | "pmax" | "search" | "meta07" | "ms07", d: number, costDollars: number): RawRecord {
  const base = {
    lsa: { platform: "google_lsa", accountId: "LSA-B09", campaignId: "lsa-B09", campaignName: "B09 | Local Services", campaignType: "LOCAL_SERVICES" },
    pmax: { platform: "google_ads", accountId: "LSA-B09", campaignId: "pmax-lsa-B09", campaignName: "B09 | Local Services (PMax, pay-per-lead)", campaignType: "PERFORMANCE_MAX", localServicesEnabled: true },
    search: { platform: "google_ads", accountId: "GA-SW", campaignId: "gs-B09", campaignName: "B09 | Search", campaignType: "SEARCH" },
    meta07: { platform: "meta", accountId: "META-B07", campaignId: "fb-B07", campaignName: "B07 | Meta | Leads", campaignType: null },
    ms07: { platform: "microsoft_ads", accountId: "MS-B07", campaignId: "ms-B07", campaignName: "B07 | Bing | Search", campaignType: "SEARCH" },
  }[campaign];
  const fetchedAt = new Date(new Date(`${day(d)}T00:00:00Z`).getTime() + 30 * 3_600_000);
  return { entity: "spend_day", payload: { ...base, date: day(d), costMicros: String(costDollars * 1_000_000), clicks: 10, conversions: 3, fetchedAt: fetchedAt.toISOString() } };
}

let pool: Pool;

beforeAll(async () => {
  pool = testPool();
  await freshDb(pool);
  const ads: RawRecord[] = [];
  for (let d = 1; d <= 30; d++) {
    ads.push(spend("search", d, 300));
    ads.push(d < MIGRATION_DAY ? spend("lsa", d, 100) : spend("pmax", d, 100));
    // B07 Meta: $50 a day until Oct 18, a reported $0.00 for Oct 19–25, then no record at all.
    if (d <= 18) ads.push(spend("meta07", d, 50));
    else if (d <= 25) ads.push(spend("meta07", d, 0));
    // B07 Microsoft: $40 a day, except a mixed week: $0.00 reported Oct 12–14, no record Oct 15–18.
    if (d >= 12 && d <= 14) ads.push(spend("ms07", d, 0));
    else if (d < 12 || d > 18) ads.push(spend("ms07", d, 40));
  }
  await ingest(pool, "ads", ads, { mapper: mapperFor("ads", "1.0"), now: NOW });
  await pool.query(
    `insert into campaign_branch_map (campaign_id, branch_id, mapped_by, mapped_at)
     select id, case when external_campaign_id in ('fb-B07', 'ms-B07') then 'B07' else 'B09' end, 'marketing-ops', $1 from ad_campaigns on conflict do nothing`,
    [NOW],
  );
  const calls: RawRecord[] = [];
  const crm: RawRecord[] = [];
  let n = 0;
  for (let d = 1; d <= 30; d++) {
    calls.push(call(`LSA-ONLY-${d}`, "B09", `+1602555${String(1000 + d)}`, at(d, 14), "Google LSA"));
    if (d % 3 === 0 && d <= 25) {
      const a = acquisition(++n, "B09", `+1602556${String(1000 + n)}`, at(d), { source: "Google LSA" });
      calls.push(a.call);
      crm.push(...a.crm);
    }
  }
  await ingest(pool, "calls", calls, { now: NOW });
  await ingest(pool, "crm", crm, { now: NOW });
  await runReconcile(pool, NOW);
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe("what the chart draws is what the records say", () => {
  it("B09: every weekly value equals its stored spend records; the period equals the scorecard", async () => {
    const m = await movement(pool, { branchId: "B09", branchIds: null, period: OCT });
    expect(m.weeks.map((w) => w.start)).toEqual(["2026-08-31", "2026-09-07", "2026-09-14", "2026-09-21", "2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
    expect(m.weeks[0].days).toBe(6); // Sep 1–6
    expect(m.weeks.at(-1)!.days).toBe(5); // Oct 26–30
    expect(m.weeks.filter((w) => w.inPeriod).map((w) => w.start)).toEqual(["2026-09-28", "2026-10-05", "2026-10-12", "2026-10-19", "2026-10-26"]);
    for (const s of m.series) {
      for (const c of s.cells) {
        const days = await spendDays(pool, { branchId: "B09", channel: s.channel, week: c.week });
        const records = days.flatMap((d) => d.records);
        expect(c.cents, `${s.channel} ${c.week}`).toBe(records.length ? records.reduce((t, r) => t + r.cents, 0) : null);
        expect(c.daysWithRecord, `${s.channel} ${c.week}`).toBe(days.filter((d) => d.records.length > 0).length);
      }
    }
    const [row] = await branchRows(pool, { from: OCT.from, to: OCT.to, branchIds: ["B09"] });
    expect(m.totals.periodCents).toBe(row.paidSpendCents);
  });

  it("B09: Local Services stops on Oct 13 — a partial week, then gaps (no record), never $0", async () => {
    const m = await movement(pool, { branchId: "B09", branchIds: null, period: OCT });
    const lsa = m.series.find((s) => s.channel === "google_lsa")!;
    const cell = (w: string) => lsa.cells.find((c) => c.week === w)!;
    expect(cell("2026-10-05")).toMatchObject({ cents: 70_000, daysWithRecord: 7, status: "recorded" });
    expect(cell("2026-10-12")).toMatchObject({ cents: 10_000, daysWithRecord: 1, daysDelivered: 7, status: "partial" });
    expect(cell("2026-10-19")).toMatchObject({ cents: null, daysWithRecord: 0, status: "missing" });
    expect(cell("2026-10-19").leads).toBeGreaterThan(0);
    // The migrated spend is filed as Search: $300 + $100 a day from Oct 13.
    const search = m.series.find((s) => s.channel === "google_search")!;
    expect(search.cells.find((c) => c.week === "2026-10-19")).toMatchObject({ cents: 7 * 40_000, status: "recorded" });
    // The incident's stored date and scope put one marker on the chart.
    expect(m.markers).toHaveLength(1);
    expect(m.markers[0]).toMatchObject({ date: "2026-10-13", week: "2026-10-12", channel: "google_lsa", status: "open" });
    expect(m.markers[0].successors[0]).toMatchObject({ externalCampaignId: "pmax-lsa-B09", classifiedAs: ["Google Search"] });
    expect(m.holds.map((h) => h.kind)).toContain("channel_coverage_gap");

    const t = takeaway(m, "B09");
    expect(t.headline).toBe("Google Local Services spend at B09 stopped after Oct 12 while its leads kept arriving.");
    expect(t.detail).toContain("pmax-lsa-B09, which is filed as Google Search");
    expect(t.trust).toMatchObject({ tone: "review", label: "Investigate before acting" });
    const week = m.weeks.find((w) => w.start === "2026-10-19")!;
    const lines = explainCell(lsa, cell("2026-10-19"), week, m.markers);
    expect(pointTitle(lsa, week, "B09")).toBe("Google Local Services at B09 · Oct 19–Oct 25");
    // Changed 2026-11-13 (B09-RECOVERY.md): it said "nothing was delivered for this channel here",
    // but the feed did deliver these days, filed as Google Search. The records show only that
    // Local Services has none here.
    expect(lines[0]).toBe("No spend record on any of its 7 days. This is not $0: no record here says what this channel spent.");
  });

  it("B07: a recorded $0.00 is a zero; a week with no record is missing", async () => {
    const m = await movement(pool, { branchId: "B07", branchIds: null, period: OCT });
    const meta = m.series.find((s) => s.channel === "meta")!;
    const zero = meta.cells.find((c) => c.week === "2026-10-19")!;
    const missing = meta.cells.find((c) => c.week === "2026-10-26")!;
    expect(zero).toMatchObject({ cents: 0, daysWithRecord: 7, status: "zero" });
    expect(missing).toMatchObject({ cents: null, daysWithRecord: 0, status: "missing" });
    const week = (w: string) => m.weeks.find((x) => x.start === w)!;
    expect(explainCell(meta, zero, week("2026-10-19"), [])[0]).toContain("$0.00, recorded");
    expect(explainCell(meta, missing, week("2026-10-26"), [])[0]).toContain("This is not $0");
    // A mixed week is partial, not zero: three days report $0.00, four have no record at all.
    const ms = m.series.find((s) => s.channel === "microsoft")!;
    const mixed = ms.cells.find((c) => c.week === "2026-10-12")!;
    expect(mixed).toMatchObject({ cents: 0, daysWithRecord: 3, daysDelivered: 7, status: "partial" });
    expect(explainCell(ms, mixed, week("2026-10-12"), [])[0]).toBe("$0.00, recorded on 3 of 7 days: the platform reported zero. The other 4 days have no spend record, which is not the same as zero.");
    const days = await spendDays(pool, { branchId: "B07", channel: "microsoft", week: "2026-10-12" });
    expect(days.map((d) => [d.date, d.records.map((r) => r.cents)])).toEqual([
      ["2026-10-12", [0]],
      ["2026-10-13", [0]],
      ["2026-10-14", [0]],
      ["2026-10-15", []],
      ["2026-10-16", []],
      ["2026-10-17", []],
      ["2026-10-18", []],
    ]);
    // No incident here: nothing to mark, and nothing calls for review.
    expect(m.markers).toEqual([]);
    expect(takeaway(m, "B07").trust.tone).toBe("clear");
  });

  it("all branches in view: the company lines carry no branch's marker; the held branch is offered", async () => {
    const m = await movement(pool, { branchId: null, branchIds: null, period: OCT });
    expect(m.markers).toEqual([]);
    const t = takeaway(m, "the branches in view");
    expect(t.trust.tone).toBe("review");
    expect(t.suggestion).toMatchObject({ branchId: "B09" });
  });
});

describe("scope", () => {
  const b20only: Viewer = VIEWERS.partner;
  it("a branch outside the viewer's scope is refused before any read; an unknown one is named as unknown", async () => {
    expect(await overviewMovement(pool, b20only, { branchParam: "B09", brandBranchIds: null, period: OCT })).toEqual({ kind: "outside_scope", branchId: "B09" });
    expect(await overviewMovement(pool, VIEWERS.marketing, { branchParam: "B99", brandBranchIds: null, period: OCT })).toEqual({ kind: "unknown_branch", branchId: "B99" });
    // The partner's own scope is their branch: no "all branches" line exists for them.
    const own = await overviewMovement(pool, b20only, { branchParam: null, brandBranchIds: null, period: OCT });
    expect(own.kind).toBe("ready");
    if (own.kind === "ready") expect(own.movement.scope.branchId).toBe("B20");
  });

  it("reuses the Overview's own holds for the same scope, and reads a chosen branch's own", async () => {
    const viewer = VIEWERS.marketing;
    const args = { branchParam: null, brandBranchIds: null, period: OCT };
    const pageHolds = await decisionHolds(pool, viewer.branchIds);
    expect(pageHolds.map((h) => h.branchId)).toContain("B09");
    // The same panel whether it reads the holds or is given the page's.
    expect(await overviewMovement(pool, viewer, { ...args, pageHolds })).toEqual(await overviewMovement(pool, viewer, args));
    // A chosen branch ignores the page's list (capped, ranked across all branches) and reads its own.
    const b09 = await overviewMovement(pool, viewer, { ...args, branchParam: "B09", pageHolds: [] });
    expect(b09.kind === "ready" ? b09.movement.holds : null).toEqual(await decisionHolds(pool, ["B09"]));
    expect(b09.kind === "ready" ? b09.movement.holds.length : 0).toBeGreaterThan(0);
  });
});

describe("evidence for one point", () => {
  it("lists every day of the week inside the window, with its records or none", async () => {
    const days = await spendDays(pool, { branchId: "B09", channel: "google_lsa", week: "2026-10-12" });
    expect(days.map((d) => [d.date, d.records.length])).toEqual([
      ["2026-10-12", 1],
      ["2026-10-13", 0],
      ["2026-10-14", 0],
      ["2026-10-15", 0],
      ["2026-10-16", 0],
      ["2026-10-17", 0],
      ["2026-10-18", 0],
    ]);
    expect(days[0].records[0]).toMatchObject({ externalCampaignId: "lsa-B09", cents: 10_000 });
    expect(Number((await one<{ id: string }>(pool, "select raw_event_id as id from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id where c.external_campaign_id = 'lsa-B09' and s.spend_date = '2026-10-12'")).id)).toBe(days[0].records[0].rawEventId);
  });
});
