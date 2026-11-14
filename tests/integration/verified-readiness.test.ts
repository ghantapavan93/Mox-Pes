import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapCampaignToBranch } from "@/lib/actions";
import type { Queryable } from "@/lib/db";
import { POLICY, stateOf, verifiedReadiness, type PolicyRule } from "@/lib/decision/verified";
import { openCacInquiry } from "@/lib/inquiry/store";
import { traceAttribution, traceCash } from "@/lib/lineage/cash";
import { traceBranchMetric } from "@/lib/lineage/trace";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { ForbiddenError, VIEWERS } from "@/lib/viewer";
import { acquisition, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * Verified decision readiness (lib/decision/verified.ts): a deterministic policy over the Decision
 * Lab's own verdicts, the traces and the investigation workspace, every rule shown.
 */
const NOW = new Date("2026-10-31T13:00:00Z");
const { marketing, partner } = VIEWERS;

const rule = (code: string, forces: PolicyRule["forces"], passed: boolean): PolicyRule => ({ code, forces, passed, text: `${code} ${passed ? "passes" : "fails"}` });

describe("the policy decides in order", () => {
  it("NOT_READY wins over every other failure; READY needs every rule", () => {
    expect(stateOf([rule("readiness", "NOT_READY", false), rule("workspace", "NEEDS_REVIEW", false), rule("measured_effect", "READY_WITH_LIMITATIONS", false)])).toEqual({ state: "NOT_READY", because: ["readiness fails"] });
    expect(stateOf([rule("readiness", "NOT_READY", true), rule("workspace", "NEEDS_REVIEW", false), rule("measured_effect", "READY_WITH_LIMITATIONS", false)]).state).toBe("NEEDS_REVIEW");
    expect(stateOf([rule("readiness", "NOT_READY", true), rule("measured_effect", "READY_WITH_LIMITATIONS", false)]).state).toBe("READY_WITH_LIMITATIONS");
    expect(stateOf([rule("readiness", "NOT_READY", true), rule("measured_effect", "READY_WITH_LIMITATIONS", true)])).toEqual({ state: "READY", because: [] });
    expect(POLICY).toHaveLength(4);
  });
});

let pool: Pool;
beforeAll(async () => {
  pool = testPool();
  await freshDb(pool);
  const ads: RawRecord[] = [];
  for (let d = 1; d <= 30; d++) {
    for (const m of [9, 10]) {
      ads.push({ entity: "spend_day", payload: { platform: "google_ads", accountId: "ACC-VR", campaignId: "vr-gs", campaignName: "vr search", date: `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}`, costMicros: "50000000", clicks: 4, conversions: 1, fetchedAt: `2026-${String(m).padStart(2, "0")}-${String(d).padStart(2, "0")}T23:00:00Z`, campaignType: "SEARCH", currencyCode: "USD" } });
    }
  }
  await ingest(pool, "ads", ads, { now: NOW });
  const c = await one<{ id: string }>(pool, "select id from ad_campaigns where external_campaign_id = 'vr-gs'");
  await mapCampaignToBranch(pool, { campaignId: Number(c.id), branchId: "B07", actor: "setup", reason: "fixture mapping", now: new Date("2026-09-01T00:00:00Z") });
  for (let n = 1; n <= 4; n++) {
    const won = acquisition(n, "B07", `+1480552${String(1000 + n)}`, new Date(Date.UTC(2026, 9, 2 + n * 3, 16)), { source: "Google Ads" });
    (won.call.payload as Record<string, unknown>).campaign = "vr-gs";
    await ingest(pool, "calls", [won.call], { now: NOW });
    await ingest(pool, "crm", won.crm, { now: NOW });
  }
  await runReconcile(pool, NOW);
}, 120_000);
afterAll(async () => pool?.end());

describe("verified readiness for a branch", () => {
  it("shows every rule, the state each failure forces, and is NOT_READY when the Decision Lab's own readiness fails", async () => {
    const v = await verifiedReadiness(pool, marketing, { branchId: "B07", period: PERIODS.oct });
    const search = v.channels.find((c) => c.channelCode === "google_search")!;
    expect(search.rules.map((r) => r.code)).toEqual(["readiness", "integrity", "cac_reproduces", "cash_reproduces", "invariants", "integrity_warnings", "workspace", "measured_effect", "complete", "attribution_coverage"]);
    // Four customers is below the Decision Lab's minimum: its readiness fails, so this is not ready.
    expect(search.rules.find((r) => r.code === "readiness")?.passed).toBe(false);
    expect(search.state).toBe("NOT_READY");
    // The numbers themselves are proved: the traces reproduce and the invariants hold.
    expect(search.rules.filter((r) => ["cac_reproduces", "cash_reproduces", "invariants"].includes(r.code)).every((r) => r.passed)).toBe(true);
    // Without an experiment the decision would rest on attribution.
    expect(search.rules.find((r) => r.code === "measured_effect")?.passed).toBe(false);
  });

  it("reads the branch's investigation workspace", async () => {
    await openCacInquiry(pool, marketing, { branchId: "B07", now: NOW });
    const v = await verifiedReadiness(pool, marketing, { branchId: "B07", period: PERIODS.oct });
    const ws = v.channels[0].rules.find((r) => r.code === "workspace")!;
    expect(ws.text).toMatch(/workspace/);
  });

  it("is refused outside the viewer's scope", async () => {
    await expect(verifiedReadiness(pool, partner, { branchId: "B07", period: PERIODS.oct })).rejects.toThrow(ForbiddenError);
  });
});

describe("one scorecard row per snapshot (R-34, 2026-11-13)", () => {
  const args = { branchId: "B07", period: PERIODS.oct };
  /** The scorecard (branchRows) is the only query with this CTE. */
  const isScorecard = (text: string) => text.includes("leadagg as (");

  it("reads the branch's scorecard row once, and every trace given that row equals the trace that reads its own", async () => {
    const client = await pool.connect();
    try {
      await client.query("begin isolation level repeatable read read only");
      let scorecards = 0;
      const counting = {
        query: (text: string, values?: unknown[]) => {
          if (isScorecard(text)) scorecards++;
          return client.query(text, values);
        },
      } as Queryable;
      await verifiedReadiness(counting, marketing, args);
      // Until 2026-11-13: four, the paid-CAC trace, the cash trace, the attribution trace and then
      // verified readiness itself, the same row from the same snapshot each time.
      expect(scorecards).toBe(1);

      const [row] = await branchRows(client, { from: args.period.from, to: args.period.to, branchIds: [args.branchId] });
      expect(await traceBranchMetric(client, marketing, { ...args, metric: "paid_cac", scorecard: row })).toEqual(await traceBranchMetric(client, marketing, { ...args, metric: "paid_cac" }));
      expect(await traceCash(client, marketing, { ...args, scorecard: row })).toEqual(await traceCash(client, marketing, args));
      expect(await traceAttribution(client, marketing, { ...args, scorecard: row })).toEqual(await traceAttribution(client, marketing, args));
      await client.query("commit");
    } finally {
      client.release();
    }
  });

  it("refuses a row it cannot know was read in its own snapshot, or a row for another branch", async () => {
    const [row] = await branchRows(pool, { from: args.period.from, to: args.period.to, branchIds: [args.branchId] });
    // Given the pool, a trace opens its own snapshot: a row read anywhere else could disagree with it.
    await expect(traceBranchMetric(pool, marketing, { ...args, metric: "paid_cac", scorecard: row })).rejects.toThrow(/same snapshot/);
    await expect(traceCash(pool, marketing, { ...args, scorecard: row })).rejects.toThrow(/same snapshot/);
    await expect(traceAttribution(pool, marketing, { ...args, scorecard: row })).rejects.toThrow(/same snapshot/);
    const client = await pool.connect();
    try {
      await expect(traceBranchMetric(client, marketing, { branchId: "B08", period: PERIODS.oct, metric: "paid_cac", scorecard: row })).rejects.toThrow(/for B07, not B08/);
    } finally {
      client.release();
    }
  });
});
