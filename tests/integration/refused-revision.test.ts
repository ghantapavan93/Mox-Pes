import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { decisionVerdicts } from "@/lib/decision/verdicts";
import { dispatchEvents } from "@/lib/events/consumers";
import { runStream } from "@/lib/ingest/ingest";
import { budgetSignal, decisionHolds } from "@/lib/metrics/decision";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { correctionsOf, revisionsOf } from "@/lib/reconcile/refused-revisions";
import { InMemorySourceClient } from "@/lib/sim/clients";
import { VIEWERS } from "@/lib/viewer";
import { freshDb, ingest, runReconcile, testPool } from "../helpers";

/**
 * A newer spend revision the active mapper refuses (docs/agent-work/HOLD-TO-DECISION.md §1;
 * REMAINING-RISKS.md R-54, case 2). The expected outcomes were written first (§1.3, §1.4) and are
 * computed here from the records below, never from a product query:
 *
 *   pmax-lsa-B09  Performance Max, Local Services  B09  account LSA-B09  Oct 1–30   20,000 + 37·d cents
 *   gs-B09        Search                           B09  account GA-SW    Sep 1–Oct 30  30,000 cents
 *   gs-B10        Search                           B10  account GA-SW    Oct 1–30   25,000 cents
 *
 * GA-SW is shared by B09 and B10: sharing an account says nothing about which branch a record
 * holds. Every record is first fetched the next day at 06:00Z; a refused revision of a campaign-day
 * is fetched later on Oct 31, so the source clock says it is newer.
 */

const OCT = PERIODS.oct;
const SEP = PERIODS.sep;
const SEEDED = new Date("2026-10-31T08:00:00Z");
const at = (hhmm: string) => new Date(`2026-10-31T${hhmm}:00Z`);
const date = (month: 9 | 10, d: number) => `2026-${String(month).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);

const CAMPAIGN = {
  pmax: { platform: "google_ads", accountId: "LSA-B09", campaignId: "pmax-lsa-B09", campaignName: "B09 | Local Services (PMax, pay-per-lead)", campaignType: "PERFORMANCE_MAX", localServicesEnabled: true },
  search: { platform: "google_ads", accountId: "GA-SW", campaignId: "gs-B09", campaignName: "B09 | Search", campaignType: "SEARCH" },
  b10: { platform: "google_ads", accountId: "GA-SW", campaignId: "gs-B10", campaignName: "B10 | Search", campaignType: "SEARCH" },
} as const;
type Campaign = keyof typeof CAMPAIGN;
const CENTS: Record<Campaign, (d: number) => number> = { pmax: (d) => 20_000 + 37 * d, search: () => 30_000, b10: () => 25_000 };

function spend(campaign: Campaign, iso: string, opts: { fetchedAt?: string; cents?: number; extra?: Record<string, unknown> } = {}): RawRecord {
  const d = Number(iso.slice(8, 10));
  const original = new Date(new Date(`${iso}T00:00:00Z`).getTime() + 30 * 3_600_000).toISOString();
  const cents = opts.cents ?? CENTS[campaign](d);
  return { entity: "spend_day", payload: { ...CAMPAIGN[campaign], date: iso, costMicros: String(cents * 10_000), clicks: 10, conversions: 3, fetchedAt: opts.fetchedAt ?? original, ...(opts.extra ?? {}) } };
}

/** The refusals the active mapper (ads@1.2) makes, one per code. */
const REFUSALS = {
  FRACTIONAL_CONVERSIONS: { conversions: 2.5 },
  CURRENCY_UNSUPPORTED: { currencyCode: "CAD" },
  AMBIGUOUS_CAMPAIGN_TYPE: { campaignType: undefined },
} as const;

let pool: Pool;
beforeAll(() => {
  pool = testPool();
});
afterAll(async () => pool.end());

/** One polling run of the ads feed (the worker's path), then the intake's consumers (reconciliation). */
async function deliverAds(records: RawRecord[], when: Date) {
  await pool.query("update app_clock set now = $1", [when]);
  const versions = records.map((r) => ({ stream: "ads", entity: r.entity, visibleAt: when.getTime() - 60_000, payload: r.payload as Record<string, unknown> }));
  const run = await runStream(pool, { client: new InMemorySourceClient("ads", "ads", versions), mapper: mapperFor("ads"), ctx: referenceContext, now: when, windowEnd: when, overlapMs: 0, initialCursor: new Date(when.getTime() - 24 * 3_600_000) });
  expect(run.status).toBe("succeeded");
  await dispatchEvents(pool);
  return Number(run.runId);
}

async function seed() {
  await freshDb(pool);
  await ingest(
    pool,
    "ads",
    [
      ...range(1, 30).map((d) => spend("pmax", date(10, d))),
      ...range(1, 30).map((d) => spend("search", date(9, d))),
      ...range(1, 30).map((d) => spend("search", date(10, d))),
      ...range(1, 30).map((d) => spend("b10", date(10, d))),
    ],
    { now: SEEDED },
  );
  await pool.query(
    `insert into campaign_branch_map (campaign_id, branch_id, mapped_by, mapped_at)
     select id, case when external_campaign_id = 'gs-B10' then 'B10' else 'B09' end, 'marketing-ops', $1 from ad_campaigns`,
    [SEEDED],
  );
  await runReconcile(pool, SEEDED);
}

/** What the ledger counts for one campaign-day. */
const counted = async (campaign: Campaign, iso: string) =>
  (
    await pool.query<{ cost_cents: string; channel_code: string }>(
      "select s.cost_cents, s.channel_code from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id where c.external_campaign_id = $1 and s.spend_date = $2",
      [CAMPAIGN[campaign].campaignId, iso],
    )
  ).rows.map((r) => ({ cents: Number(r.cost_cents), channel: r.channel_code }))[0] ?? null;

const holds = async () =>
  (
    await pool.query<{ id: string; branch_id: string | null; status: string; summary: string; evidence: Record<string, unknown>; resolution: string | null }>(
      "select id, branch_id, status, summary, evidence, resolution from exceptions where kind = 'quarantined_source_records' and evidence ->> 'source' = 'ads' order by id",
    )
  ).rows.map((r) => ({ id: Number(r.id), branchId: r.branch_id, status: r.status, summary: r.summary, evidence: r.evidence, resolution: r.resolution }));

/** Decision Lab's verdicts without the clock, to compare a decision before and after a delivery. */
const verdictsOf = async (branchId: string, period = OCT) => {
  const v = await decisionVerdicts(pool, VIEWERS.marketing, { branchId, period });
  return JSON.stringify({ ...v, asOf: undefined });
};

describe("a newer spend revision the mapper refuses (R-54, case 2)", () => {
  it.each(Object.entries(REFUSALS))("%s: the counted amount stands and the branch's October decision is held, for that channel's integrity", async (code, extra) => {
    await seed();
    const before = { oct20: await counted("pmax", date(10, 20)), paid: (await branchRows(pool, { from: OCT.from, to: OCT.to, branchIds: ["B09"] }))[0].paidSpendCents };
    expect((await budgetSignal(pool, "B09", OCT)).trustworthy).toBe(true);

    const run = await deliverAds([spend("pmax", date(10, 20), { fetchedAt: "2026-10-31T12:00:00Z", cents: 40_000, extra })], at("12:05"));

    // Accepted ledger value: unchanged, still Local Services, never the refused 40,000 and never 0.
    expect(await counted("pmax", date(10, 20))).toEqual({ cents: CENTS.pmax(20), channel: "google_lsa" });
    expect(before.oct20).toEqual({ cents: CENTS.pmax(20), channel: "google_lsa" });
    expect((await branchRows(pool, { from: OCT.from, to: OCT.to, branchIds: ["B09"] }))[0].paidSpendCents).toBe(before.paid);

    // Decision readiness: held at B09, by an incident that names the date, the refusal and what still counts.
    const signal = await budgetSignal(pool, "B09", OCT);
    expect(signal.trustworthy).toBe(false);
    expect(signal.blockers).toHaveLength(1);
    const [b] = signal.blockers;
    expect(b.kind).toBe("quarantined_source_records");
    expect(b.revisions).toMatchObject([{ date: "2026-10-20", channel: "google_lsa", acceptedCents: CENTS.pmax(20), refusedCents: 40_000, refusedRunId: run }]);
    const [h] = await holds();
    expect(h).toMatchObject({ branchId: "B09", status: "open" });
    expect(h.summary).toBe(`A newer revision of pmax-lsa-B09's spend on Oct 20 was refused (${code}); the earlier $207.40 still counts`);
    expect(h.summary).not.toMatch(/\$0\.00|\$400\.00/);
    expect(await decisionHolds(pool, ["B09"], 8, OCT)).toMatchObject([{ exceptionId: h.id, branchId: "B09" }]);

    // Decision Lab: Local Services' integrity fails on this refusal; no other channel's does.
    const v = await decisionVerdicts(pool, VIEWERS.marketing, { branchId: "B09", period: OCT });
    for (const c of v.channels) {
      const refused = c.integrity.reasons.filter((r) => r.code === "refused_revision");
      if (c.channelCode === "google_lsa") {
        expect(refused).toHaveLength(1);
        expect(refused[0].text).toContain("The ledger still counts the earlier $207.40, so Oct 20 is not confirmed.");
        expect(refused[0].href).toBe(`/exceptions/${h.id}`);
      } else expect(refused).toEqual([]);
      expect(c.readiness.status).toBe("not_ready");
      expect(c.readiness.blockers.map((r) => r.text)).toContainEqual(expect.stringContaining(`Blocking incident #${h.id}: A newer revision of Oct 20's Google Local Services spend (pmax-lsa-B09) was refused`));
    }
  });

  it("the period's first and last dates hold it; a refusal dated in September holds September and leaves October as it was", async () => {
    await seed();
    await deliverAds([spend("pmax", date(10, 1), { fetchedAt: "2026-10-31T12:00:00Z", extra: REFUSALS.FRACTIONAL_CONVERSIONS }), spend("pmax", date(10, 30), { fetchedAt: "2026-10-31T12:00:00Z", extra: REFUSALS.FRACTIONAL_CONVERSIONS })], at("12:05"));
    expect((await budgetSignal(pool, "B09", OCT)).blockers[0].revisions.map((r) => r.date)).toEqual(["2026-10-01", "2026-10-30"]);
    expect((await budgetSignal(pool, "B09", SEP)).trustworthy).toBe(true);

    await seed();
    const october = await verdictsOf("B09");
    await deliverAds([spend("search", date(9, 20), { fetchedAt: "2026-10-31T12:00:00Z", extra: REFUSALS.FRACTIONAL_CONVERSIONS })], at("12:05"));
    const sep = await budgetSignal(pool, "B09", SEP);
    expect(sep.trustworthy).toBe(false);
    expect(sep.blockers[0].revisions).toMatchObject([{ date: "2026-09-20", channel: "google_search" }]);
    expect(await budgetSignal(pool, "B09", OCT)).toMatchObject({ trustworthy: true, blockers: [] });
    expect(await verdictsOf("B09")).toBe(october);
    expect(await decisionHolds(pool, ["B09"], 8, OCT)).toEqual([]);
    expect(await decisionHolds(pool, ["B09"], 8, SEP)).toHaveLength(1);
  });

  it("another branch's campaign in the shared ad account holds that branch, never B09; nor does a name that says B09", async () => {
    await seed();
    const b09 = await verdictsOf("B09");
    await deliverAds([spend("b10", date(10, 20), { fetchedAt: "2026-10-31T12:00:00Z", extra: { ...REFUSALS.FRACTIONAL_CONVERSIONS, campaignName: "B09 | Search" } })], at("12:05"));
    expect(await budgetSignal(pool, "B10", OCT)).toMatchObject({ trustworthy: false });
    expect((await budgetSignal(pool, "B10", OCT)).blockers[0].revisions).toMatchObject([{ externalCampaignId: "gs-B10", date: "2026-10-20" }]);
    expect(await budgetSignal(pool, "B09", OCT)).toMatchObject({ trustworthy: true, blockers: [] });
    expect(await verdictsOf("B09")).toBe(b09);
    expect((await holds()).map((h) => h.branchId)).toEqual(["B10"]);
  });

  it("an exact duplicate, an older revision and a re-send of the counted one change nothing and clear nothing", async () => {
    await seed();
    const refused = spend("pmax", date(10, 20), { fetchedAt: "2026-10-31T12:00:00Z", cents: 40_000, extra: REFUSALS.FRACTIONAL_CONVERSIONS });
    await deliverAds([refused], at("12:05"));
    const [first] = await holds();
    const decision = await verdictsOf("B09");

    await deliverAds([refused], at("12:10")); // byte for byte
    await deliverAds([spend("pmax", date(10, 20), { fetchedAt: "2026-10-21T05:00:00Z", cents: 25_000 })], at("12:15")); // older than the counted 06:00Z revision
    await deliverAds([spend("pmax", date(10, 20))], at("12:20")); // the counted revision again

    expect(await counted("pmax", date(10, 20))).toEqual({ cents: CENTS.pmax(20), channel: "google_lsa" });
    const after = await holds();
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ id: first.id, status: "open", branchId: "B09", summary: first.summary });
    expect(revisionsOf(after[0].evidence)).toHaveLength(1);
    expect(await verdictsOf("B09")).toBe(decision);
  });

  it("an accepted revision between the counted one and the refused one moves the amount but keeps the hold", async () => {
    await seed();
    await deliverAds([spend("pmax", date(10, 20), { fetchedAt: "2026-10-31T12:00:00Z", cents: 40_000, extra: REFUSALS.FRACTIONAL_CONVERSIONS })], at("12:05"));
    await deliverAds([spend("pmax", date(10, 20), { fetchedAt: "2026-10-31T11:00:00Z", cents: 21_000 })], at("12:10"));
    expect(await counted("pmax", date(10, 20))).toEqual({ cents: 21_000, channel: "google_lsa" });
    const signal = await budgetSignal(pool, "B09", OCT);
    expect(signal.trustworthy).toBe(false);
    expect(signal.blockers[0].revisions).toMatchObject([{ acceptedCents: 21_000, refusedCents: 40_000 }]);
  });

  it("an accepted newer revision lifts only its own hold and names the delivery; another stays", async () => {
    await seed();
    await deliverAds([spend("pmax", date(10, 20), { fetchedAt: "2026-10-31T12:00:00Z", cents: 40_000, extra: REFUSALS.FRACTIONAL_CONVERSIONS })], at("12:05"));
    await deliverAds([spend("pmax", date(10, 22), { fetchedAt: "2026-10-31T12:00:00Z", extra: REFUSALS.CURRENCY_UNSUPPORTED })], at("12:06"));
    const [fractional, currency] = await holds();
    expect([fractional.branchId, currency.branchId]).toEqual(["B09", "B09"]);

    const correction = await deliverAds([spend("pmax", date(10, 20), { fetchedAt: "2026-10-31T13:00:00Z", cents: 40_000 })], at("13:05"));
    expect(await counted("pmax", date(10, 20))).toEqual({ cents: 40_000, channel: "google_lsa" });
    const [f, c] = await holds();
    expect(f).toMatchObject({ id: fractional.id, status: "resolved" });
    expect(f.resolution).toBe(`Corrected. Oct 20: ingestion run #${correction} accepted a newer revision (fetched Oct 31, 1:00 PM UTC): $207.40 became $400.00.`);
    expect(correctionsOf(f.evidence)).toMatchObject([{ date: "2026-10-20", correction: { how: "newer_accepted", runId: correction, cents: 40_000 } }]);
    expect(c).toMatchObject({ id: currency.id, status: "open" });
    const signal = await budgetSignal(pool, "B09", OCT);
    expect(signal.blockers.map((b) => b.exceptionId)).toEqual([currency.id]);
  });

  it("within one incident, a corrected campaign-day is kept with its delivery while the other still holds", async () => {
    await seed();
    await deliverAds(
      [20, 21].map((d) => spend("pmax", date(10, d), { fetchedAt: "2026-10-31T12:00:00Z", extra: REFUSALS.FRACTIONAL_CONVERSIONS })),
      at("12:05"),
    );
    const [h] = await holds();
    expect(h.summary).toBe("Newer revisions of 2 campaign-days of spend were refused (FRACTIONAL_CONVERSIONS); the earlier accepted amounts still count");
    const correction = await deliverAds([spend("pmax", date(10, 20), { fetchedAt: "2026-10-31T13:00:00Z" })], at("13:05"));
    const [after] = await holds();
    expect(after).toMatchObject({ id: h.id, status: "open" });
    expect(revisionsOf(after.evidence).map((r) => r.date)).toEqual(["2026-10-21"]);
    expect(correctionsOf(after.evidence)).toMatchObject([{ date: "2026-10-20", correction: { how: "newer_accepted", runId: correction, cents: CENTS.pmax(20) } }]);
    expect((await budgetSignal(pool, "B09", OCT)).blockers[0].revisions.map((r) => r.date)).toEqual(["2026-10-21"]);
  });

  it("a refused record naming no campaign the ledger maps, or no campaign at all, holds no branch", async () => {
    await seed();
    const b09 = await verdictsOf("B09");
    const noId = { ...(spend("pmax", date(10, 20), { fetchedAt: "2026-10-31T12:00:00Z", extra: REFUSALS.FRACTIONAL_CONVERSIONS }).payload as Record<string, unknown>) };
    delete noId.campaignId;
    await deliverAds(
      [
        // An id the ledger has never counted, named like B09's campaign, in B09's ad account.
        spend("pmax", date(10, 20), { fetchedAt: "2026-10-31T12:00:00Z", extra: { ...REFUSALS.FRACTIONAL_CONVERSIONS, campaignId: "pmax-lsa-B09-2" } }),
        { entity: "spend_day", payload: noId },
      ],
      at("12:05"),
    );
    expect(await budgetSignal(pool, "B09", OCT)).toMatchObject({ trustworthy: true, blockers: [] });
    expect(await verdictsOf("B09")).toBe(b09);
    const company = await holds();
    expect(company.map((h) => h.branchId)).toEqual([null, null]);
    expect(company.every((h) => revisionsOf(h.evidence).length === 0)).toBe(true);
  });

  it("a refused revision older than the counted one holds nothing; one at the same instant is not newer", async () => {
    await seed();
    // Older than the counted Oct 21 06:00Z revision: superseded the moment it arrives.
    await deliverAds([spend("pmax", date(10, 20), { fetchedAt: "2026-10-21T05:00:00Z", extra: REFUSALS.FRACTIONAL_CONVERSIONS })], at("12:05"));
    expect(await holds()).toEqual([]);
    // The counted instant, written another way, with other content: not newer, so no branch's hold.
    await deliverAds([spend("pmax", date(10, 21), { fetchedAt: "2026-10-22T06:00:00Z", extra: REFUSALS.FRACTIONAL_CONVERSIONS })], at("12:10"));
    expect((await holds()).map((h) => h.branchId)).toEqual([null]);
    expect(await budgetSignal(pool, "B09", OCT)).toMatchObject({ trustworthy: true });
  });
});
