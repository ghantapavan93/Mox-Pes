import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawRecord, SourceName } from "@/lib/adapters/contract";
import { mapCampaignToBranch } from "@/lib/actions";
import { branchRows, totals } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { call, crm, freshDb, ingest, runReconcile, testPool } from "../helpers";

/**
 * Property-based and metamorphic checks of the money figures over random synthetic worlds
 * (seeded, so a failure reproduces). The expected figures come from a REFERENCE CALCULATOR
 * written here from the metric definitions (docs/metric-definitions.md), not from production
 * code:
 *
 *   paid spend(branch, month)   Σ counted spend of campaigns mapped to the branch; a day whose feed
 *                               stated no currency (no rule) or another currency is not counted
 *   unallocated(month)          Σ counted spend of campaigns mapped to no branch
 *   new customers               customers whose first service completed in the month, at their branch
 *   paid customers              ... whose call carried a paid campaign that is mapped to a branch and
 *                               has at least one counted day (definition v3)
 *   collected(branch, month)    Σ payments − Σ refunds, each by its own date
 *
 * and the metamorphic relations: delivering everything twice changes nothing; delivering
 * independent units in another order changes nothing; a change at one branch leaves the others
 * as they were; the newest fetch of a restated day wins in any arrival order; a refund lowers
 * collected cash by exactly its amount, in its own month only.
 */

const NOW = new Date("2026-10-31T13:00:00Z");
const BRANCHES = ["B05", "B12", "B30"] as const;
const PLATFORM = { google_ads: "Google Ads", google_lsa: "Google LSA", meta: "Facebook", microsoft_ads: "Bing" } as const;
type Platform = keyof typeof PLATFORM;
const at = (month: number, day: number, hour = 16) => new Date(Date.UTC(2026, month - 1, day, hour));
const ymd = (month: number, day: number) => `2026-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;

/** mulberry32: a small seeded generator, so every world is reproducible from its seed. */
function rng(seed: number) {
  let a = seed >>> 0;
  const next = () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
  return { next, int: (lo: number, hi: number) => lo + Math.floor(next() * (hi - lo + 1)), pick: <T>(xs: readonly T[]) => xs[Math.floor(next() * xs.length)], chance: (p: number) => next() < p };
}

interface SpendDay { month: number; day: number; cents: number; currency: "USD" | "CAD" | null }
interface Campaign { key: string; platform: Platform; mappedTo: string | null; days: SpendDay[] }
interface Customer { n: number; branch: string; campaign: string | null; month: number; day: number; paidCents: number; refund: { cents: number; month: number; day: number } | null }
interface World { seed: number; campaigns: Campaign[]; customers: Customer[] }

function generate(seed: number): World {
  const r = rng(seed);
  const campaigns: Campaign[] = [];
  const count = r.int(2, 4);
  for (let i = 0; i < count; i++) {
    // Whole-campaign currency: mostly USD; sometimes the feed states none, or CAD; and a few
    // single days within a USD campaign state none (a partly held campaign).
    const mode = r.next();
    const whole: SpendDay["currency"] = mode < 0.7 ? "USD" : mode < 0.88 ? null : "CAD";
    const days: SpendDay[] = [];
    for (const month of [9, 10]) {
      const n = r.int(1, 5);
      const used = new Set<number>();
      for (let k = 0; k < n; k++) {
        let day = r.int(1, 30);
        while (used.has(day)) day = (day % 30) + 1;
        used.add(day);
        const currency = whole === "USD" && r.chance(0.15) ? null : whole;
        days.push({ month, day, cents: r.int(1_000, 40_000), currency });
      }
    }
    campaigns.push({ key: `s${seed}-c${i}`, platform: r.pick(Object.keys(PLATFORM) as Platform[]), mappedTo: r.chance(0.8) ? r.pick(BRANCHES) : null, days });
  }
  const customers: Customer[] = [];
  const nCustomers = r.int(4, 9);
  for (let i = 0; i < nCustomers; i++) {
    const month = r.pick([9, 10]);
    const day = r.int(2, 28);
    const paidCents = r.int(5_000, 30_000);
    const refundDay = r.chance(0.35) ? { month: month === 9 && r.chance(0.5) ? 10 : month, day: Math.min(30, day + r.int(1, 10)) } : null;
    customers.push({
      n: i + 1,
      branch: r.pick(BRANCHES),
      campaign: r.chance(0.75) ? r.pick(campaigns).key : null,
      month,
      day,
      paidCents,
      refund: refundDay ? { cents: r.int(100, paidCents), ...refundDay } : null,
    });
  }
  return { seed, campaigns, customers };
}

// ── The reference calculator ─────────────────────────────────────────────────

const counted = (d: SpendDay) => d.currency === "USD";
interface Figures { paidSpend: number; paid: number; acquired: number; collected: number; refunds: number }
function reference(w: World) {
  const by = new Map<string, Figures>();
  const key = (b: string, m: number) => `${b}:${m}`;
  for (const b of BRANCHES) for (const m of [9, 10]) by.set(key(b, m), { paidSpend: 0, paid: 0, acquired: 0, collected: 0, refunds: 0 });
  const unallocated = new Map<number, number>([[9, 0], [10, 0]]);
  for (const c of w.campaigns) {
    for (const d of c.days.filter(counted)) {
      if (c.mappedTo) by.get(key(c.mappedTo, d.month))!.paidSpend += d.cents;
      else unallocated.set(d.month, unallocated.get(d.month)! + d.cents);
    }
  }
  for (const k of w.customers) {
    const f = by.get(key(k.branch, k.month))!;
    f.acquired += 1;
    const c = w.campaigns.find((x) => x.key === k.campaign);
    // Paid: a paid campaign mapped to a branch, with at least one counted day (definition v3).
    if (c && c.mappedTo && c.days.some(counted)) f.paid += 1;
    f.collected += k.paidCents;
    if (k.refund) {
      const g = by.get(key(k.branch, k.refund.month))!;
      g.collected -= k.refund.cents;
      g.refunds += k.refund.cents;
    }
  }
  return { by, unallocated };
}

// ── Delivery as independent units ────────────────────────────────────────────

interface Unit { label: string; batches: Array<{ source: SourceName; records: RawRecord[] }> }

function units(w: World): Unit[] {
  const out: Unit[] = [];
  for (const c of w.campaigns) {
    out.push({
      label: c.key,
      batches: [{
        source: "ads",
        records: c.days.map((d) => ({
          entity: "spend_day",
          payload: {
            platform: c.platform, accountId: `ACC-${c.key}`, campaignId: c.key, campaignName: `${c.key} campaign`, date: ymd(d.month, d.day),
            costMicros: String(d.cents * 10_000), clicks: 3, conversions: 1, fetchedAt: new Date(at(d.month, d.day).getTime() + 14 * 3_600_000).toISOString(),
            ...(c.platform === "google_ads" ? { campaignType: "SEARCH" } : c.platform === "google_lsa" ? { campaignType: "LOCAL_SERVICES" } : {}),
            ...(d.currency ? { currencyCode: d.currency } : {}),
          },
        })),
      }],
    });
  }
  for (const k of w.customers) {
    const id = 7000 + k.n;
    const sold = at(k.month, k.day);
    const done = new Date(sold.getTime() + 3_600_000);
    const phone = `+1480556${String(1000 + k.n + (w.seed % 50) * 20).padStart(4, "0")}`;
    const c = w.campaigns.find((x) => x.key === k.campaign);
    const crmRecords: RawRecord[] = [
      crm.customer(id, k.branch, phone, sold),
      crm.subscription(id + 1000, id, k.branch, sold),
      crm.appointment(id + 2000, id + 1000, id, k.branch, "0", done, sold),
      crm.appointment(id + 2000, id + 1000, id, k.branch, "1", done, done),
      crm.ticket(id + 3000, id, id + 2000, k.branch, (k.paidCents / 100).toFixed(2), new Date(done.getTime() + 3_600_000)),
      crm.payment(id + 4000, id, id + 3000, k.branch, (k.paidCents / 100).toFixed(2), new Date(done.getTime() + 2 * 3_600_000)),
    ];
    if (k.refund) crmRecords.push(crm.payment(id + 5000, id, id + 3000, k.branch, `-${(k.refund.cents / 100).toFixed(2)}`, at(k.refund.month, k.refund.day, 18), "1", String(id + 4000)));
    out.push({
      label: `customer ${k.n}`,
      batches: [
        { source: "calls", records: [call(`MM-${w.seed}-${k.n}`, k.branch, phone, new Date(sold.getTime() - 24 * 3_600_000), c ? PLATFORM[c.platform] : "Direct", { campaign: c?.key ?? null })] },
        { source: "crm", records: crmRecords },
      ],
    });
  }
  return out;
}

async function deliverAll(pool: Pool, us: Unit[]) {
  for (const u of us) for (const b of u.batches) await ingest(pool, b.source, b.records, { now: NOW });
}

async function mapCampaigns(pool: Pool, w: World) {
  for (const c of w.campaigns) {
    if (!c.mappedTo) continue;
    const { rows } = await pool.query<{ id: string }>("select id from ad_campaigns where external_campaign_id = $1", [c.key]);
    // A campaign whose every day was held has no campaign record to map (and its customers are not paid).
    if (rows[0]) await mapCampaignToBranch(pool, { campaignId: Number(rows[0].id), branchId: c.mappedTo, actor: "setup", reason: "property test mapping", now: NOW });
  }
}

async function observe(pool: Pool) {
  const out = new Map<string, Figures>();
  const unallocated = new Map<number, number>();
  for (const [m, p] of [[9, PERIODS.sep], [10, PERIODS.oct]] as const) {
    for (const r of await branchRows(pool, { from: p.from, to: p.to, branchIds: [...BRANCHES] })) {
      out.set(`${r.branchId}:${m}`, { paidSpend: r.paidSpendCents, paid: r.paidAcquired, acquired: r.acquired, collected: r.collectedCents, refunds: r.refundsCents });
    }
    unallocated.set(m, (await totals(pool, { from: p.from, to: p.to, branchIds: null })).unallocatedSpendCents);
  }
  return { by: out, unallocated };
}

const asObject = (x: { by: Map<string, Figures>; unallocated: Map<number, number> }) => ({ by: Object.fromEntries([...x.by].sort()), unallocated: Object.fromEntries(x.unallocated) });

async function build(pool: Pool, w: World, order: (us: Unit[]) => Unit[] = (us) => us) {
  await freshDb(pool, { currencyRule: false });
  // Spend first, so campaign records exist to map; mapping before the customers arrive.
  const us = order(units(w));
  await deliverAll(pool, us.filter((u) => u.batches[0].source === "ads"));
  await mapCampaigns(pool, w);
  await deliverAll(pool, us.filter((u) => u.batches[0].source !== "ads"));
  await runReconcile(pool, NOW);
  return us;
}

const SEEDS = Array.from({ length: 12 }, (_, i) => 101 + i * 37);

let pool: Pool;
beforeAll(() => {
  pool = testPool();
});
afterAll(async () => pool?.end());

describe("money figures over random worlds, against an independent reference calculator", () => {
  it.each(SEEDS)("seed %i: every branch's paid spend, customers, collected and refunds, and unallocated spend, to the cent", async (seed) => {
    const w = generate(seed);
    await build(pool, w);
    expect(asObject(await observe(pool)), JSON.stringify(w)).toEqual(asObject(reference(w)));
  }, 60_000);
});

describe("metamorphic relations", () => {
  it.each(SEEDS.slice(0, 6))("seed %i: delivering everything again changes nothing", async (seed) => {
    const w = generate(seed);
    const us = await build(pool, w);
    const once = asObject(await observe(pool));
    const raw = (await pool.query("select count(*)::int as n from raw_events")).rows[0].n;
    await deliverAll(pool, us);
    await runReconcile(pool, NOW);
    expect(asObject(await observe(pool))).toEqual(once);
    expect((await pool.query("select count(*)::int as n from raw_events")).rows[0].n).toBe(raw);
  }, 60_000);

  it.each(SEEDS.slice(0, 6))("seed %i: independent units delivered in another order give the same figures", async (seed) => {
    const w = generate(seed);
    await build(pool, w);
    const forward = asObject(await observe(pool));
    const r = rng(seed * 7 + 1);
    await build(pool, w, (us) => us.map((u) => ({ u, k: r.next() })).sort((a, b) => a.k - b.k).map((x) => x.u));
    expect(asObject(await observe(pool))).toEqual(forward);
  }, 60_000);

  it.each(SEEDS.slice(0, 4))("seed %i: new spend and customers at B30 leave B05 and B12 as they were", async (seed) => {
    const w = generate(seed);
    await build(pool, w);
    const before = asObject(await observe(pool));
    const extra: World = { seed: seed + 9_000, campaigns: [{ key: `s${seed}-local`, platform: "meta", mappedTo: "B30", days: [{ month: 10, day: 12, cents: 12_345, currency: "USD" }] }], customers: [] };
    extra.customers.push({ n: 90, branch: "B30", campaign: `s${seed}-local`, month: 10, day: 14, paidCents: 20_000, refund: null });
    const us = units(extra);
    await deliverAll(pool, us.filter((u) => u.batches[0].source === "ads"));
    await mapCampaigns(pool, extra);
    await deliverAll(pool, us.filter((u) => u.batches[0].source !== "ads"));
    await runReconcile(pool, NOW);
    const after = asObject(await observe(pool));
    for (const k of Object.keys(before.by).filter((x) => !x.startsWith("B30"))) expect(after.by[k], k).toEqual(before.by[k]);
    expect(after.by["B30:10"].paidSpend - before.by["B30:10"].paidSpend).toBe(12_345);
    expect(after.by["B30:10"].collected - before.by["B30:10"].collected).toBe(20_000);
  }, 60_000);

  it.each([3, 11, 29, 47])("seed %i: the newest fetch of a restated day wins in any arrival order", async (seed) => {
    const r = rng(seed);
    await freshDb(pool, { currencyRule: false });
    const fetches = Array.from({ length: r.int(2, 5) }, (_, i) => ({ fetched: new Date(Date.UTC(2026, 9, 6 + i, 6)), cents: r.int(1_000, 9_000) }));
    const newest = fetches[fetches.length - 1].cents;
    const order = fetches.map((f) => ({ f, k: r.next() })).sort((a, b) => a.k - b.k).map((x) => x.f);
    for (const [i, f] of order.entries()) {
      await ingest(pool, "ads", [{ entity: "spend_day", payload: { platform: "google_ads", accountId: "ACC-R", campaignId: "restated", campaignName: "restated", date: "2026-10-05", costMicros: String(f.cents * 10_000), clicks: 1, conversions: 0, fetchedAt: f.fetched.toISOString(), campaignType: "SEARCH", currencyCode: "USD" } }], { now: new Date(NOW.getTime() + i * 60_000) });
    }
    expect((await pool.query("select sum(cost_cents)::int as c, count(*)::int as n from ad_spend_daily")).rows[0]).toEqual({ c: newest, n: 1 });
  }, 60_000);

  it.each(SEEDS.slice(0, 4))("seed %i: a refund lowers collected cash by exactly its amount, in its own month only", async (seed) => {
    const w = generate(seed);
    await build(pool, w);
    const before = asObject(await observe(pool));
    const k = w.customers[0];
    const id = 7000 + k.n;
    await ingest(pool, "crm", [crm.payment(id + 6000, id, id + 3000, k.branch, "-1.23", at(10, 30, 9), "1", String(id + 4000))], { now: NOW });
    await runReconcile(pool, NOW);
    const after = asObject(await observe(pool));
    for (const key of Object.keys(before.by)) {
      const delta = after.by[key].collected - before.by[key].collected;
      expect(delta, key).toBe(key === `${k.branch}:10` ? -123 : 0);
      expect(after.by[key].refunds - before.by[key].refunds, key).toBe(key === `${k.branch}:10` ? 123 : 0);
    }
  }, 60_000);
});
