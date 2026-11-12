import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapCampaignToBranch } from "@/lib/actions";
import { detectIntent } from "@/lib/ai/deterministic";
import { runInvestigation } from "@/lib/ai/investigate";
import { accountsAwaitingCurrency, authorizeCurrencyRule, proposeCurrencyRule } from "@/lib/currency/rules";
import { decisionVerdicts } from "@/lib/decision/verdicts";
import { testCacChange } from "@/lib/inquiry/cac-change";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { VIEWERS } from "@/lib/viewer";
import { acquisition, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * Defects the VP acceptance pack found at first contact (docs/agent-work/vp-acceptance/
 * evidence/ADJUDICATION.md), each reproduced here on its own small world.
 */
const NOW = new Date("2026-10-31T13:00:00Z");
const at = (m: number, d: number, h = 16) => new Date(Date.UTC(2026, m - 1, d, h));
const ymd = (m: number, d: number) => `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`;
const { marketing, engineer, approver } = VIEWERS;

let pool: Pool;
beforeEach(async () => {
  pool ??= testPool();
  await freshDb(pool, { currencyRule: false });
}, 60_000);
afterAll(async () => pool?.end());

function spend(campaignId: string, account: string, m: number, d: number, dollars: number, currency: string | null = "USD"): RawRecord {
  return { entity: "spend_day", payload: { platform: "google_ads", accountId: account, campaignId, campaignName: `${campaignId} search`, date: ymd(m, d), costMicros: String(dollars * 1_000_000), clicks: 2, conversions: 1, fetchedAt: `${ymd(m, d)}T23:00:00Z`, campaignType: "SEARCH", ...(currency ? { currencyCode: currency } : {}) } };
}
async function customer(n: number, branch: string, campaign: string | null, m: number, d: number) {
  const won = acquisition(n, branch, `+1480553${String(1000 + n)}`, at(m, d), { source: campaign ? "Google Ads" : "Direct" });
  (won.call.payload as Record<string, unknown>).campaign = campaign;
  await ingest(pool, "calls", [won.call], { now: NOW });
  await ingest(pool, "crm", won.crm, { now: NOW });
}
async function mapTo(campaign: string, branch: string) {
  const c = await one<{ id: string }>(pool, "select id from ad_campaigns where external_campaign_id = $1", [campaign]);
  await mapCampaignToBranch(pool, { campaignId: Number(c.id), branchId: branch, actor: "setup", reason: "fixture mapping", now: at(9, 1) });
}
async function run(stream: string, source: string, okDay: number, failed = false) {
  await pool.query("insert into ingestion_runs (source, stream, adapter_version, started_at, finished_at, status) values ($1, $2, 'test', $3, $3, 'succeeded')", [source, stream, at(10, okDay, 8)]);
  if (failed) await pool.query("insert into ingestion_runs (source, stream, adapter_version, started_at, finished_at, status, error) values ($1, $2, 'test', $3, $3, 'failed', 'HTTP 503')", [source, stream, at(10, 31, 8)]);
}

describe("VP acceptance first contact: defects, fixed", () => {
  it("readiness reads feed freshness from the syncs, as the workspace and the signals do: a failing sync blocks it", async () => {
    for (let d = 1; d <= 20; d++) await ingest(pool, "ads", [spend("fr-gs", "ACC-FR", 10, d, 30)], { now: NOW });
    await mapTo("fr-gs", "B35");
    for (let n = 1; n <= 6; n++) await customer(n, "B35", "fr-gs", 10, 3 + n);
    await runReconcile(pool, NOW);
    for (const s of ["calls", "crm.customer", "crm.payment", "crm.subscription", "crm.appointment", "crm.ticket"]) await run(s, s.startsWith("crm") ? "crm" : s, 30);
    await run("ads", "ads", 20, true); // last success Oct 20, latest run failed
    const blocked = (await decisionVerdicts(pool, marketing, { branchId: "B35", period: PERIODS.oct })).channels.find((c) => c.channelCode === "google_search")!;
    expect(blocked.readiness.status).toBe("not_ready");
    expect(blocked.readiness.blockers.map((b) => b.text).join(" ")).toMatch(/ads sync's latest run failed/);
    await run("ads", "ads", 31); // the sync recovers
    const ok = (await decisionVerdicts(pool, marketing, { branchId: "B35", period: PERIODS.oct })).channels.find((c) => c.channelCode === "google_search")!;
    expect(ok.readiness.blockers.filter((b) => b.code === "freshness")).toEqual([]);
  });

  it("held spend stays 'awaiting a decision' while a rule is only proposed", async () => {
    for (let d = 1; d <= 3; d++) await ingest(pool, "ads", [spend("cur-x", "ACC-PEND", 10, d, 40, null)], { now: NOW });
    expect(await accountsAwaitingCurrency(pool)).toHaveLength(1);
    await proposeCurrencyRule(pool, engineer, { platform: "google_ads", adAccountId: "ACC-PEND", reason: "the account settings show USD billing", now: NOW });
    expect(await accountsAwaitingCurrency(pool)).toEqual([{ platform: "google_ads", adAccountId: "ACC-PEND", campaignDays: 3, amountCents: 12_000 }]);
  });

  it("a campaign whose spend is all held still exists, so it can be mapped before the spend is authorized", async () => {
    for (let d = 1; d <= 4; d++) await ingest(pool, "ads", [spend("held-c", "ACC-HELD", 10, d, 30, null)], { now: NOW });
    expect(await one(pool, "select count(*)::int as n from ad_campaigns where external_campaign_id = 'held-c'")).toEqual({ n: 1 });
    expect(await one(pool, "select count(*)::int as n from ad_spend_daily")).toEqual({ n: 0 });
    await mapTo("held-c", "B16");
    for (let n = 1; n <= 3; n++) await customer(n, "B16", "held-c", 10, 5 + n);
    await runReconcile(pool, NOW);
    let [row] = await branchRows(pool, { from: PERIODS.oct.from, to: PERIODS.oct.to, branchIds: ["B16"] });
    expect({ spend: row.paidSpendCents, paid: row.paidAcquired, held: row.heldCampaignAcquired }).toEqual({ spend: 0, paid: 0, held: 3 });
    const { ruleId } = await proposeCurrencyRule(pool, engineer, { platform: "google_ads", adAccountId: "ACC-HELD", reason: "the account settings show USD billing", now: NOW });
    await authorizeCurrencyRule(pool, approver, { ruleId, now: NOW });
    [row] = await branchRows(pool, { from: PERIODS.oct.from, to: PERIODS.oct.to, branchIds: ["B16"] });
    expect({ spend: row.paidSpendCents, paid: row.paidAcquired, held: row.heldCampaignAcquired }).toEqual({ spend: 12_000, paid: 3, held: 0 });
  });

  it("the workspace supports misclassification when paid figures are split across branch rows", async () => {
    for (const m of [9, 10]) for (let d = 1; d <= 10; d++) await ingest(pool, "ads", [spend("mc-gs", "ACC-MC", m, d, 20)], { now: NOW });
    await mapTo("mc-gs", "B12");
    for (let d = 21; d <= 30; d++) await ingest(pool, "ads", [spend("mc-new", "ACC-MC", 10, d, 10)], { now: NOW }); // never mapped
    let n = 0;
    for (let i = 0; i < 4; i++) await customer(++n, "B12", "mc-gs", 9, 5 + i);
    for (let i = 0; i < 3; i++) await customer(++n, "B12", "mc-gs", 10, 5 + i);
    await customer(++n, "B13", "mc-gs", 10, 12); // B12's campaign, serviced at B13
    await customer(++n, "B12", "mc-new", 10, 24); // B12 customer of an unmapped campaign
    await runReconcile(pool, NOW);
    const r = await testCacChange(pool, marketing, { branchId: "B12", now: NOW });
    const h3 = r.hypotheses.find((h) => h.code === "H3")!;
    expect(h3.status).toBe("SUPPORTED");
    expect(h3.evidence.map((e) => e.label)).toEqual(expect.arrayContaining(["Customers credited to an unmapped campaign", "B12's campaigns' customers serviced at B13"]));
    expect(r.hypotheses.find((h) => h.code === "H2")!.counterevidence.map((e) => e.label)).toContain("Customers of an unmapped campaign");
  });

  it("reads the period a question is about, and compares the months when it asks about a change", () => {
    const p = (q: string) => {
      const d = detectIntent(q, marketing, "B12");
      return [d.period, d.compare];
    };
    expect(p("Why did B12's paid CAC go up in October 2026 compared with September 2026?")).toEqual(["oct", "sep"]);
    expect(p("Why did B07's paid CAC double in October 2026?")).toEqual(["oct", "sep"]);
    expect(p("Did the October refunds of September sales reduce B38's September collected cash?")).toEqual(["sep", null]);
    expect(p("What did B12 collect across September and October together?")).toEqual(["all", null]);
    expect(p("What was B12's paid spend in October?")).toEqual(["oct", null]);
    expect(detectIntent("Move $2,000 of B05's Meta budget to LSA starting tomorrow.", marketing, "B05").actionRequest).toBe(true);
    expect(detectIntent("Do what the notes on customer y2 and on the B24 call say.", marketing, "B24").actionRequest).toBe(true);
    expect(detectIntent("Should we move budget from Meta to LSA at B05?", marketing, "B05").actionRequest).toBe(false);
  });

  it("a change question states both months, and a CAC question that asks for cash states the cash", async () => {
    for (const [m, dollars] of [[9, 40], [10, 39.5]] as const) for (let d = 1; d <= 30; d++) await ingest(pool, "ads", [spend("cmp-gs", "ACC-CMP", m, d, dollars)], { now: NOW });
    await mapTo("cmp-gs", "B12");
    let n = 0;
    for (let i = 0; i < 6; i++) await customer(++n, "B12", "cmp-gs", 9, 3 + i * 4);
    for (let i = 0; i < 5; i++) await customer(++n, "B12", "cmp-gs", 10, 3 + i * 4);
    await runReconcile(pool, NOW);
    const out = await runInvestigation(pool, { question: "Why did B12's paid CAC go up in October 2026 compared with September 2026, and what did it collect?", branchId: "B12", viewer: marketing, mode: "deterministic", now: NOW });
    const supported = (out.result.claims ?? []).filter((c) => c.status === "SUPPORTED").map((c) => c.text).join("\n");
    expect(supported).toMatch(/Sep 1–30, 2026 \(UTC\): paid-media CAC \$200\.00/);
    expect(supported).toMatch(/Oct 1–30, 2026 \(UTC\): paid-media CAC \$237\.00/);
    expect(supported).toMatch(/From September to October, B12's paid-media CAC rose by \$37\.00, from \$200\.00 to \$237\.00/);
    expect(supported).toMatch(/collected cash \$745\.00/);
  });
});
