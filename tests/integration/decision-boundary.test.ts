import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapCampaignToBranch } from "@/lib/actions";
import { authorizeCurrencyRule, proposeCurrencyRule } from "@/lib/currency/rules";
import { DEFAULT_ASSUMPTIONS, scenario } from "@/lib/decision/scenario";
import { budgetSignalCopy, budgetSignalNote, builderDefaults, SIGNAL_GATE_LABEL } from "@/lib/decision/signal-copy";
import { decisionVerdicts, type DecisionVerdicts } from "@/lib/decision/verdicts";
import { budgetSignal, decisionHolds, evidenceHolds, type BudgetSignal } from "@/lib/metrics/decision";
import { channelRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { captureState } from "@/lib/workflow/snapshot";
import { VIEWERS } from "@/lib/viewer";
import { acquisition, freshDb, ingest, runReconcile, testPool } from "../helpers";

/**
 * The decision boundary (lib/metrics/decision.ts): a fact can be displayable, a pairwise comparison
 * valid, and a budget recommendation still held, as three separate outcomes. The world mirrors the
 * recorded B03 cases (docs/agent-work/product-audit/harness/boundary/cases.mts, on the seed) at a
 * size whose every number is computed here from the records, never from a product query:
 *
 *   gs-B03   Search          B03  GA-WEST  Oct 1–20  $100/day = $2,000   8 customers  → $250.00
 *   lsa-B03  Local Services  B03  LSA-B03  Oct 1–20  $50/day  = $1,000   6 customers  → $166.67
 *   fb-B03   Meta            B03  META-1   Oct 1–20  $20/day  = $400     5 customers  → $80.00
 *   gs-B04   Search          B04  GA-WEST  Oct 1–20  $90/day  = $1,800   6 customers  → $300.00
 *   lsa-B04  Local Services  B04  LSA-B04  Oct 1–20  $40/day  = $800     5 customers  → $160.00
 *   fb-B04   Meta            B04  META-1   Oct 1–20  $25/day  = $500     5 customers  → $100.00
 *
 * B04 shares GA-WEST and META-1 with B03 and holds nothing of its own: it is the control. Each
 * account has its own authorized USD rule, so an account without one is excluded at intake, as in
 * the product (lib/currency/rules.ts).
 */

const OCT = PERIODS.oct;
const NOW = new Date("2026-10-31T13:00:00Z");
const DAYS = Array.from({ length: 20 }, (_, i) => i + 1);
const iso = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const { marketing } = VIEWERS;

const CAMPAIGNS = {
  "gs-B03": { platform: "google_ads", accountId: "GA-WEST", campaignType: "SEARCH", branch: "B03", dollars: 100 },
  "lsa-B03": { platform: "google_lsa", accountId: "LSA-B03", campaignType: "LOCAL_SERVICES", branch: "B03", dollars: 50 },
  "fb-B03": { platform: "meta", accountId: "META-1", campaignType: undefined, branch: "B03", dollars: 20 },
  "gs-B04": { platform: "google_ads", accountId: "GA-WEST", campaignType: "SEARCH", branch: "B04", dollars: 90 },
  "lsa-B04": { platform: "google_lsa", accountId: "LSA-B04", campaignType: "LOCAL_SERVICES", branch: "B04", dollars: 40 },
  "fb-B04": { platform: "meta", accountId: "META-1", campaignType: undefined, branch: "B04", dollars: 25 },
} as const;
type CampaignId = keyof typeof CAMPAIGNS;
/** The call-tracking source that credits each platform's channel (lib/adapters/marketing.ts). */
const CALL_SOURCE = { google_ads: "Google Ads", google_lsa: "Google LSA", meta: "Facebook", microsoft_ads: "Bing" } as const;
const CUSTOMERS: Record<CampaignId, number> = { "gs-B03": 8, "lsa-B03": 6, "fb-B03": 5, "gs-B04": 6, "lsa-B04": 5, "fb-B04": 5 };

function spend(id: string, c: { platform: string; accountId: string; campaignType?: string }, d: number, dollars: number, extra: Record<string, unknown> = {}): RawRecord {
  return {
    entity: "spend_day",
    payload: {
      platform: c.platform, accountId: c.accountId, campaignId: id, campaignName: `${id} campaign`, ...(c.campaignType ? { campaignType: c.campaignType } : {}),
      date: iso(d), costMicros: String(Math.round(dollars * 1_000_000)), clicks: 10, conversions: 1, fetchedAt: `${iso(d)}T23:00:00Z`, ...extra,
    },
  };
}

let customerNo = 0;
/** One serviced customer at `branch` whose call names `campaign` on `platform`. */
async function customer(pool: Pool, branch: string, platform: keyof typeof CALL_SOURCE, campaign: string, day: number) {
  const n = ++customerNo;
  const won = acquisition(n, branch, `+1480555${String(1000 + n)}`, new Date(Date.UTC(2026, 9, day, 17)), { source: CALL_SOURCE[platform] });
  (won.call.payload as Record<string, unknown>).campaign = campaign;
  await ingest(pool, "calls", [won.call], { now: NOW });
  await ingest(pool, "crm", won.crm, { now: NOW });
}

async function rule(pool: Pool, platform: string, account: string) {
  await pool.query(
    `insert into currency_rules (platform, ad_account_id, currency, proposed_by, proposed_at, reason, authorized_by, authorized_at)
     values ($1, $2, 'USD', 'test-fixture:engineer', '2026-08-01T00:00:00Z', 'test fixture: the account reports in USD', 'test-fixture:approver', '2026-08-01T00:00:00Z')`,
    [platform, account],
  );
}

async function mapTo(pool: Pool, external: string, branch: string) {
  const { rows } = await pool.query<{ id: string }>("select id from ad_campaigns where external_campaign_id = $1", [external]);
  await mapCampaignToBranch(pool, { campaignId: Number(rows[0].id), branchId: branch, actor: "test-fixture", reason: "fixture: the campaign targets this branch", now: NOW });
}

/** The world above; `withoutRule` leaves one account with no currency rule, so its spend is held at intake. */
async function seedWorld(pool: Pool, opts: { withoutRule?: string } = {}) {
  await freshDb(pool, { currencyRule: false });
  customerNo = 0;
  for (const [platform, account] of [["google_ads", "GA-WEST"], ["google_lsa", "LSA-B03"], ["google_lsa", "LSA-B04"], ["meta", "META-1"], ["microsoft_ads", "MS-1"]]) {
    if (account !== opts.withoutRule) await rule(pool, platform, account);
  }
  for (const [id, c] of Object.entries(CAMPAIGNS) as Array<[CampaignId, (typeof CAMPAIGNS)[CampaignId]]>) {
    await ingest(pool, "ads", DAYS.map((d) => spend(id, c, d, c.dollars)), { now: NOW });
    await mapTo(pool, id, c.branch);
    for (let i = 0; i < CUSTOMERS[id]; i++) await customer(pool, c.branch, c.platform, id, 3 + (i % 10));
  }
  await runReconcile(pool, NOW);
}

/** What every surface says, read through the product's own functions, for one branch. */
async function surfaces(pool: Pool, branch: string) {
  const signal = await budgetSignal(pool, branch, OCT);
  const verdicts = await decisionVerdicts(pool, marketing, { branchId: branch, period: OCT });
  const bySpend = verdicts.channels.filter((c) => c.spendCents > 0).sort((a, b) => b.spendCents - a.spendCents).map((c) => c.channelCode);
  return {
    signal,
    verdicts,
    card: budgetSignalCopy(signal, branch, "oct"),
    note: budgetSignalNote(verdicts.budgetSignal),
    builder: builderDefaults(verdicts.budgetSignal, bySpend),
    incidentHolds: await decisionHolds(pool, [branch], 8, OCT),
    evidenceHolds: await evidenceHolds(pool, [branch], OCT),
  };
}

const readiness = (v: DecisionVerdicts, code: string) => v.channels.find((c) => c.channelCode === code)!.readiness;
const reasonsOf = (s: BudgetSignal, code: string) => s.eligibility.find((e) => e.channelCode === code)!.reasons.map((r) => r.code);
const move = (pool: Pool, branch: string, from: string, to: string) =>
  scenario(pool, marketing, { branchId: branch, period: "oct", changes: [{ fromChannel: from, toChannel: to, amountCents: 20_000 }], assumptions: DEFAULT_ASSUMPTIONS });

async function ledger(pool: Pool) {
  const { rows } = await pool.query(
    "select (select coalesce(sum(cost_cents), 0)::bigint from ad_spend_daily) as spend, (select count(*) from ad_spend_daily) as days, (select coalesce(sum(amount_cents), 0)::bigint from crm_payments) as paid",
  );
  return rows[0];
}

let pool: Pool;
beforeAll(() => {
  pool = testPool();
});
afterAll(async () => pool.end());

describe("the decision boundary: facts, comparisons and recommendations stay apart", () => {
  describe("a held channel (Local Services at B03: its account has no currency rule)", () => {
    beforeEach(async () => seedWorld(pool, { withoutRule: "LSA-B03" }), 120_000);

    it("cannot look ready to act on: its readiness fails with the records' own reason, on every surface", async () => {
      const s = await surfaces(pool, "B03");
      expect(s.signal.trustworthy).toBe(true); // no incident says anything
      expect(reasonsOf(s.signal, "google_lsa")).toEqual(["held"]);
      const lsa = readiness(s.verdicts, "google_lsa");
      expect(lsa.status).toBe("not_ready");
      expect(lsa.blockers.map((b) => b.code)).toEqual(["cost_held"]);
      expect(lsa.blockers[0].text).toContain("held at intake on 20 days of the period (Oct 1–Oct 20)");
      expect(lsa.blockers[0].text).toContain("no authorized rule says this ad account reports in USD");
      expect(lsa.blockers[0].text).toContain("(CURRENCY_UNSTATED, account LSA-B03)");
      // The Overview names it, though no incident does.
      expect(s.incidentHolds).toEqual([]);
      expect(s.evidenceHolds).toMatchObject([{ branchId: "B03", channelCode: "google_lsa", code: "held" }]);
      // A move involving it is refused with that reason, not "has no spend".
      await expect(move(pool, "B03", "google_search", "google_lsa")).rejects.toThrow(/no counted spend at B03 .*held at intake/);
    });

    it("leaves the unaffected pair comparable, as 'among verified channels', without a branch-wide ranking", async () => {
      const s = await surfaces(pool, "B03");
      expect(s.signal.comparison).toMatchObject({ basis: "verified", signal: "shift", compared: ["google_search", "meta"], from: { channelCode: "google_search" }, to: { channelCode: "meta" } });
      expect(s.signal.comparison.ratio).toBeCloseTo(25_000 / 8_000, 6);
      expect(s.signal.excluded.map((x) => x.channelCode)).toEqual(["google_lsa"]);
      expect(s.card.gate.label).toBe(SIGNAL_GATE_LABEL.clear);
      expect(s.card.headline).toBe(
        "Among verified channels, Google Search costs 3.1× Meta per attributed new customer (first evidenced touch). Not a branch-wide ranking: Google Local Services is left out.",
      );
      expect(s.card.excluded).toEqual([expect.stringMatching(/^Google Local Services \(6 customers\): Its spend at B03 is held at intake/)]);
      expect(s.card.invalid).toBeNull(); // the raw pair is the verified pair: nothing to call invalid
      expect(s.note).toEqual({ text: "Budget signal, among verified channels: Google Search costs 3.1× Meta per customer (Google Local Services left out)", badge: "recommendation held", tone: "warn" });
      // The pair's own move can be reviewed (no blocker touches either side), labelled as a pair.
      for (const code of ["google_search", "meta"]) expect(readiness(s.verdicts, code).status).toBe("ready");
      const pair = await move(pool, "B03", "google_search", "meta");
      expect(pair.decisionReady).toBe(true);
      expect(pair.warnings.join(" ")).toContain("This compares two channels, not the branch: Google Local Services is left out of B03's comparison (held at intake)");
    });

    it("holds the recommendation: the observed shift never becomes one, and nothing is preselected", async () => {
      const s = await surfaces(pool, "B03");
      expect(s.signal.signal).toBe("shift"); // the raw observation, as before the boundary
      expect(s.signal.recommendation.status).toBe("held");
      expect(s.signal.recommendation.heldBy).toEqual([{ exceptionId: null, channelCode: "google_lsa", text: expect.stringContaining("Google Local Services: Its spend at B03 is held at intake") }]);
      expect(s.card.decision).toEqual({
        tone: "warn",
        label: "Branch-wide recommendation held",
        text: "Google Local Services is left out, and its missing cost could change which channel is cheapest or most expensive. A move between the verified channels can still be reviewed in the Decision Lab; a move involving Google Local Services cannot until its cost here is known.",
      });
      expect(s.builder).toEqual({ from: "", to: "" });
      // The fix receipt's snapshot carries the same status, for a reader after the fact.
      const snap = await captureState(pool, 0, "B03");
      expect(snap.branch?.budgetSignal).toMatchObject({ trustworthy: true, recommendation: "held" });
    });

    it("is not inherited by B04, which shares GA-WEST and META-1 with B03", async () => {
      const s = await surfaces(pool, "B04");
      expect(s.signal.eligibility.every((e) => e.reasons.length === 0)).toBe(true);
      expect(s.signal.comparison.basis).toBe("branch");
      expect(s.signal.recommendation).toEqual({ status: "shift", heldBy: [] });
      expect(s.card.headline).toBe("Google Search costs 3.0× Meta per attributed new customer (first evidenced touch). An observation, not a recommendation.");
      expect(s.card.decision).toBeNull();
      expect(s.builder).toEqual({ from: "google_search", to: "meta" });
      expect(s.evidenceHolds).toEqual([]);
      expect(s.verdicts.channels.filter((c) => c.channelCode !== "microsoft").every((c) => c.readiness.status === "ready")).toBe(true);
    });

    it("an authorized rule (the correction for this hold) releases the channel and the recommendation", async () => {
      // Two people, as the product requires: an engineer proposes, a different approver authorizes.
      const { ruleId } = await proposeCurrencyRule(pool, VIEWERS.engineer, { platform: "google_lsa", adAccountId: "LSA-B03", reason: "fixture: the account settings show USD billing", now: NOW });
      expect((await authorizeCurrencyRule(pool, VIEWERS.approver, { ruleId, now: NOW })).reprojected).toBe(20);
      await runReconcile(pool, NOW);
      const s = await surfaces(pool, "B03");
      expect(reasonsOf(s.signal, "google_lsa")).toEqual([]);
      expect(s.signal.comparison.basis).toBe("branch");
      expect(s.signal.recommendation.status).toBe("shift");
      expect(readiness(s.verdicts, "google_lsa").status).toBe("ready");
      expect(s.evidenceHolds).toEqual([]);
    });
  });

  describe("a refused revision and a held channel together (B03), then a correction of the refusal only", () => {
    beforeEach(async () => {
      await seedWorld(pool, { withoutRule: "LSA-B03" });
      // A newer revision of fb-B03's Oct 10 with fractional conversions: ads@1.2 refuses it.
      await ingest(pool, "ads", [spend("fb-B03", CAMPAIGNS["fb-B03"], 10, 20, { conversions: 2.5, fetchedAt: "2026-10-31T12:00:00Z" })], { now: NOW });
      await runReconcile(pool, NOW);
    }, 120_000);

    it("a blocked ratio cannot become a shift recommendation", async () => {
      const s = await surfaces(pool, "B03");
      expect(s.signal.trustworthy).toBe(false);
      expect(s.signal.blockers).toHaveLength(1);
      expect(s.signal.blockers[0]).toMatchObject({ kind: "quarantined_source_records", touches: ["meta"] });
      expect(reasonsOf(s.signal, "meta")).toEqual(["refused"]);
      // The raw ratio (Search 3.1× Meta) is the blocked one: Meta's spend is not confirmed.
      expect(s.signal.signal).toBe("shift");
      expect(s.signal.recommendation.status).toBe("held");
      expect(s.signal.comparison).toMatchObject({ basis: "verified", compared: ["google_search"], signal: "none", from: null, to: null });
      expect(s.card.headline).toBe("Fewer than two paid channels at B03 can be compared on verified figures: Google Local Services and Meta are left out.");
      expect(s.card.headline).not.toMatch(/× Meta/);
      // Named once, as what the refusal distorts, never as the comparison.
      expect(s.card.invalid).toBe("Not a valid comparison: Google Search costs 3.1× Meta per attributed new customer (first evidenced touch), but Meta is left out (revision refused).");
      expect(s.card.blocked).toBe("Do not move budget at B03 yet. Open incidents hold every move here; they change what Meta cost or which customers it produced:");
      expect(s.note.badge).toBe("gated");
      expect(s.builder).toEqual({ from: "", to: "" });
      // An incident at the branch holds every move there, as before the boundary.
      expect((await move(pool, "B03", "google_search", "meta")).decisionReady).toBe(false);
    });

    it("B04, in the same META-1 account, inherits neither hold", async () => {
      const s = await surfaces(pool, "B04");
      expect(s.signal.trustworthy).toBe(true);
      expect(s.signal.recommendation.status).toBe("shift");
      expect(s.incidentHolds).toEqual([]);
      expect(s.evidenceHolds).toEqual([]);
    });

    it("an accepted newer revision clears the refusal only: the held channel still holds the recommendation", async () => {
      const before = await ledger(pool);
      await ingest(pool, "ads", [spend("fb-B03", CAMPAIGNS["fb-B03"], 10, 20, { fetchedAt: "2026-10-31T12:30:00Z" })], { now: NOW });
      await runReconcile(pool, NOW);
      const incident = (await pool.query("select status, resolution from exceptions where kind = 'quarantined_source_records' and branch_id = 'B03'")).rows[0];
      // History: the refusal was corrected, and says by what.
      expect(incident.status).toBe("resolved");
      expect(incident.resolution).toMatch(/^Corrected\. Oct 10: .*accepted a newer revision/);
      // The current decision: no incident gates it, Meta is comparable again, Local Services still holds it.
      const s = await surfaces(pool, "B03");
      expect(s.signal.trustworthy).toBe(true);
      expect(reasonsOf(s.signal, "meta")).toEqual([]);
      expect(reasonsOf(s.signal, "google_lsa")).toEqual(["held"]);
      expect(s.signal.recommendation.status).toBe("held");
      expect(s.signal.recommendation.heldBy.map((h) => h.channelCode)).toEqual(["google_lsa"]);
      expect(s.card.headline).toMatch(/^Among verified channels, Google Search costs 3\.1× Meta/);
      expect(s.builder).toEqual({ from: "", to: "" });
      const snap = await captureState(pool, 0, "B03");
      expect(snap.branch?.budgetSignal).toMatchObject({ trustworthy: true, recommendation: "held", heldBy: [expect.stringContaining("Google Local Services")] });
      // The correction re-sent the same amount: the accepted ledger did not move.
      expect(await ledger(pool)).toEqual(before);
    });
  });

  describe("a held day in a shared account (gs-B03 on Oct 15, stated for an account with no rule)", () => {
    beforeEach(async () => {
      await seedWorld(pool);
      await ingest(pool, "ads", [spend("gs-B03", { ...CAMPAIGNS["gs-B03"], accountId: "GA-WEST-X" }, 15, 100, { fetchedAt: "2026-10-31T12:00:00Z" })], { now: NOW });
      await runReconcile(pool, NOW);
    }, 120_000);

    it("leaves Search out as understated at B03, and B04's figures, in the same GA-WEST account, unchanged", async () => {
      const s = await surfaces(pool, "B03");
      expect(s.signal.channels.find((c) => c.channelCode === "google_search")).toMatchObject({ spendCents: 190_000, acquired: 8 });
      expect(s.signal.eligibility.find((e) => e.channelCode === "google_search")!.reasons[0].text).toContain(
        "held at intake on 1 day of the period (Oct 15): the feed stated no currency and no authorized rule says this ad account reports in USD; not counted (CURRENCY_UNSTATED, account GA-WEST-X). The counted spend leaves that day out, so its cost per customer is understated",
      );
      expect(s.signal.recommendation.status).toBe("held");
      expect(s.signal.comparison).toMatchObject({ basis: "verified", compared: ["google_lsa", "meta"] });
      expect(s.card.invalid).toBe("Not a valid comparison: Google Search costs 3.0× Meta per attributed new customer (first evidenced touch), but Google Search is left out (held at intake).");
      const b4 = await surfaces(pool, "B04");
      expect(b4.signal.channels.find((c) => c.channelCode === "google_search")).toMatchObject({ spendCents: 180_000, acquired: 6, cacCents: 30_000 });
      expect(b4.signal.recommendation.status).toBe("shift");
      expect(b4.evidenceHolds).toEqual([]);
    });
  });

  describe("a source-recorded $0.00 (the control: no record is missing)", () => {
    beforeEach(async () => {
      await seedWorld(pool);
      // Microsoft Ads at B03: every day recorded at $0.00 by the source, and 5 customers.
      const ms = { platform: "microsoft_ads", accountId: "MS-1" };
      await ingest(pool, "ads", DAYS.map((d) => spend("ms-B03", ms, d, 0)), { now: NOW });
      await mapTo(pool, "ms-B03", "B03");
      for (let i = 0; i < 5; i++) await customer(pool, "B03", "microsoft_ads", "ms-B03", 4 + i);
      await runReconcile(pool, NOW);
    }, 120_000);

    it("leaves its channel out with its own reason, and holds nothing: not every null CAC is a hold", async () => {
      const s = await surfaces(pool, "B03");
      expect(s.signal.trustworthy).toBe(true);
      expect(s.signal.eligibility.find((e) => e.channelCode === "microsoft")).toMatchObject({ spendCents: 0, acquired: 5, cacCents: null });
      const zero = s.signal.eligibility.find((e) => e.channelCode === "microsoft")!.reasons;
      expect(zero).toMatchObject([{ code: "recorded_zero", holds: false, couldChange: false, short: "$0.00 recorded" }]);
      expect(zero[0].text).toBe("The source recorded $0.00 for it at B03 on all 20 counted days of the period: there is no cost per customer to act on. No record of it is held.");
      expect(readiness(s.verdicts, "microsoft").blockers.map((b) => b.code)).toEqual(["cost_recorded_zero"]);
      // Left out of the comparison, but it cannot change it: the recommendation stands.
      expect(s.signal.comparison).toMatchObject({ basis: "verified", signal: "shift", compared: ["google_search", "google_lsa", "meta"] });
      expect(s.signal.recommendation).toEqual({ status: "shift", heldBy: [] });
      expect(s.card.headline).toBe(
        "Among verified channels, Google Search costs 3.1× Meta per attributed new customer (first evidenced touch). Microsoft Ads is left out, by records that cannot change this comparison.",
      );
      expect(s.card.decision).toBeNull();
      expect(s.evidenceHolds).toEqual([]);
      expect(s.builder).toEqual({ from: "google_search", to: "meta" });
      await expect(move(pool, "B03", "google_search", "microsoft")).rejects.toThrow(/source recorded \$0\.00/);
    });
  });
});

describe("branch keys (B11 evidence, BUSINESS-FIT.md §3): the limitation is shown, nothing is reassigned", () => {
  beforeEach(async () => {
    await freshDb(pool);
    customerNo = 100;
    const search = { platform: "google_ads", accountId: "GA-SOUTHWEST", campaignType: "SEARCH" };
    await ingest(pool, "ads", [spend("coh-A", search, 3, 100), spend("coh-A", search, 4, 100), spend("own-B11", search, 5, 50)], { now: NOW });
    await mapTo(pool, "coh-A", "B10");
    await mapTo(pool, "own-B11", "B11");
    await customer(pool, "B11", "google_ads", "coh-A", 6); // B10's campaign, B11's customer (the fixture)
    for (let i = 0; i < 5; i++) await customer(pool, "B10", "google_ads", "coh-A", 7 + i);
    for (let i = 0; i < 2; i++) await customer(pool, "B10", "google_ads", "own-B11", 8 + i); // B11's campaign, B10's customers
    await runReconcile(pool, NOW);
  }, 120_000);

  it("a CAC whose spend and customers come from different branches' campaigns says so, and is not replaced", async () => {
    const before = await ledger(pool);
    const b11 = await budgetSignal(pool, "B11", OCT);
    const s11 = b11.eligibility.find((e) => e.channelCode === "google_search")!;
    // B11's $50.00 over B10's customer: shown, with why it cannot carry a decision. No new metric.
    expect(s11).toMatchObject({ spendCents: 5_000, acquired: 1, cacCents: 5_000 });
    expect(s11.reasons).toMatchObject([{ code: "elsewhere", short: "cost at B10", holds: false, couldChange: true }]);
    expect(s11.reasons[0].text).toBe(
      "Its only customer came from a campaign mapped to B10, which counts its cost (branch keys, D-2), so none of the spend counted here is theirs. Which branch carries that cost is a business decision.",
    );
    expect(s11.limitations).toEqual(["2 customers of this branch's campaigns are serviced at B10; their cost is counted here, the customers there (branch keys, D-2)."]);
    // B10: a partial mix is a limitation, never a reason to leave the channel out.
    const b10 = await budgetSignal(pool, "B10", OCT);
    const s10 = b10.eligibility.find((e) => e.channelCode === "google_search")!;
    expect(s10).toMatchObject({ spendCents: 20_000, acquired: 7, cacCents: Math.round(20_000 / 7), reasons: [] });
    expect(s10.limitations).toEqual([
      "2 of its 7 customers came from campaigns mapped to B11; their cost is counted there, not in this figure (branch keys, D-2).",
      "1 customer of this branch's campaigns is serviced at B11; their cost is counted here, the customers there (branch keys, D-2).",
    ]);
    // The channel rows every page reads are the same numbers: nothing moved between branches.
    expect((await channelRows(pool, { ...OCT, branchIds: ["B11"] })).find((c) => c.channelCode === "google_search")).toMatchObject({ spendCents: 5_000, acquired: 1, cacCents: 5_000 });
    expect((await channelRows(pool, { ...OCT, branchIds: ["B10"] })).find((c) => c.channelCode === "google_search")).toMatchObject({ spendCents: 20_000, acquired: 7 });
    const v11 = await decisionVerdicts(pool, marketing, { branchId: "B11", period: OCT });
    expect(readiness(v11, "google_search").blockers.map((b) => b.code)).toEqual(["cost_elsewhere", "min_customers"]);
    expect(await ledger(pool)).toEqual(before);
  });
});
