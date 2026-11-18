import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import { wallTimeToInstant } from "@/lib/primitives";
import { BRANCH_BY_OFFICE, SCENARIO } from "@/lib/reference";
import { seed, type SeedReport } from "@/lib/sim/seed";
import { CALLS_FIX_DEPLOYED_AT, PERIOD_END } from "@/lib/sim/world";
import { branchRows, channelRows, conversionBridge, paidCac, totals } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { quarantineGroupIds, replay } from "@/lib/ingest/replay";
import { planReplay } from "@/lib/ingest/replay-plan";
import { budgetSignal, decisionHolds } from "@/lib/metrics/decision";
import { decisionVerdicts } from "@/lib/decision/verdicts";
import { listScenarios, saveScenario, scenario, ScenarioRequestSchema } from "@/lib/decision/scenario";
import { builderDefaults } from "@/lib/decision/signal-copy";
import { revokeCurrencyRule } from "@/lib/currency/rules";
import { reconcile } from "@/lib/reconcile/reconcile";
import { withTransaction } from "@/lib/db";
import { nestedPool } from "@/lib/workflow/nested";
import { getException } from "@/lib/queries";
import { VIEWERS, type Viewer } from "@/lib/viewer";
import { one, testPool } from "../helpers";

/**
 * The full demo dataset, end to end: 44 branches, ~11 weeks of daily polling runs through
 * the real pipeline. Slow (~2 min) — this is the test that proves the demo reproduces.
 */
let pool: Pool;
let report: SeedReport;
const OCT = { from: PERIODS.oct.from, to: PERIODS.oct.to, branchIds: null };
const FINAL_RUN = new Date(PERIOD_END.getTime() + 8 * 3_600_000);

beforeAll(async () => {
  pool = testPool();
  report = await seed(pool);
});
afterAll(async () => pool.end());

describe("seeded demo scenario", () => {
  it("leaves planner statistics on every table it filled, without waiting for autovacuum (R-20)", async () => {
    // last_analyze is set only by an explicit ANALYZE; autovacuum sets last_autoanalyze.
    const { rows } = await pool.query<{ relname: string }>(
      `select relname from pg_stat_user_tables where schemaname = 'public' and n_live_tup > 0 and last_analyze is null order by relname`,
    );
    expect(rows.map((r) => r.relname)).toEqual([]);
  });

  it("ingests everything once: every delivery beyond the first is absorbed", async () => {
    const r = await one(pool, "select count(*) as versions, sum(delivery_count) as deliveries from raw_events");
    expect(Number(r.deliveries) - Number(r.versions)).toBe(report.duplicates);
    expect(report.duplicates).toBeGreaterThan(10_000);
  });

  it("the CRM outage run failed and the next run recovered the window", async () => {
    expect(report.failedRuns).toBe(1);
    const failed = await one(pool, "select stream, started_at from ingestion_runs where status = 'failed'");
    const next = await one(pool, "select window_start from ingestion_runs where stream = $1 and status = 'succeeded' and started_at > $2 order by started_at limit 1", [failed.stream, failed.started_at]);
    expect(new Date(next.window_start as string).getTime()).toBeLessThan(new Date(failed.started_at as string).getTime());
    expect((await one(pool, "select count(*) n from exceptions where kind = 'payment_without_ticket' and status = 'open'")).n).toBe("0");
  });

  it("quarantines exactly the drifted calls that arrived before the fix shipped", async () => {
    const lastOldRun = CALLS_FIX_DEPLOYED_AT.getTime() - 12 * 3_600_000; // the last 08:00 run on calls@1.0
    const expected = report.world.records.filter(
      (r) => r.stream === "calls" && "caller" in r.payload && r.visibleAt < lastOldRun,
    ).length;
    const ids = await quarantineGroupIds(pool, { source: "calls", errorCode: "MISSING_FIELD", branchId: SCENARIO.callFeedDriftBranch });
    expect(ids.length).toBe(expected);
    expect((await one(pool, "select count(*) n from raw_events where status = 'quarantined'")).n).toBe(String(expected));
  });

  it("collected revenue equals the generated payment ground truth to the cent", async () => {
    const latest = new Map<string, Record<string, unknown>>();
    for (const r of report.world.records) {
      if (r.stream !== "crm.payment" || r.visibleAt >= FINAL_RUN.getTime()) continue;
      latest.set(`${r.payload.paymentID}:${r.payload.status}`, r.payload);
    }
    let truth = 0;
    for (const p of latest.values()) {
      if (p.status !== "1") continue;
      const tz = BRANCH_BY_OFFICE.get(Number(p.officeID))!.timezone;
      const at = wallTimeToInstant(String(p.date), tz).getTime();
      if (at >= OCT.from.getTime() && at < OCT.to.getTime()) truth += Math.round(Number(p.amount) * 100);
    }
    expect((await totals(pool, OCT)).collectedCents).toBe(truth);
  });

  it("the conversion bridge buckets add up", async () => {
    const b = await conversionBridge(pool, OCT);
    expect(b.existingCustomers + b.notSold + b.creditedElsewhere + b.soldNotServiced + b.serviced).toBe(b.paidProspects);
    expect(b.platformClaimed).toBeGreaterThan(b.paidLeadRecords);
  });

  it("the incident branch stands out, and replay brings it back in line", async () => {
    const rows = await branchRows(pool, OCT);
    const company = await totals(pool, OCT, rows);
    const b20 = rows.find((r) => r.branchId === SCENARIO.callFeedDriftBranch)!;
    const share = (r: { unknownAcquired: number; acquired: number }) => r.unknownAcquired / r.acquired;
    expect(share(b20)).toBeGreaterThan(company.unknownShare! * 1.6);

    const ids = await quarantineGroupIds(pool, { source: "calls", errorCode: "MISSING_FIELD", branchId: SCENARIO.callFeedDriftBranch });
    const result = await replay(pool, {
      source: "calls", rawEventIds: ids, mapperVersion: "1.1", actor: "test", idempotencyKey: "scenario-replay-1", dryRun: false,
      now: new Date("2026-10-31T13:00:00Z"), scope: { ...OCT, branchIds: [SCENARIO.callFeedDriftBranch] },
    });
    expect(result.projected).toBe(ids.length);
    const after = (await branchRows(pool, { ...OCT, branchIds: [SCENARIO.callFeedDriftBranch] }))[0];
    expect(share(after)).toBeLessThan(company.unknownShare! * 1.6);
    expect(after.acquired).toBe(b20.acquired);
    expect(after.collectedCents).toBe(b20.collectedCents);
  });

  it("ChangeGuard: the simulated LSA → PMax migration is caught once, gates the budget signal, and re-maps without duplicating anything company-wide", async () => {
    const branch = SCENARIO.lsaMigrationBranch;
    const gaps = await pool.query("select id from exceptions where kind = 'channel_coverage_gap'");
    expect(gaps.rows).toHaveLength(1);
    const gap = (await getException(pool, Number(gaps.rows[0].id)))!;
    expect(gap.branchId).toBe(branch);
    expect(gap.evidence.lastSpendDate).toBe("2026-10-12");
    expect((await budgetSignal(pool, branch, OCT)).trustworthy).toBe(false);

    const ALL = { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: null };
    const pick = (rows: Awaited<ReturnType<typeof branchRows>>) =>
      rows.map((r) => [r.branchId, r.paidSpendCents, r.acquired, r.paidAcquired, r.unknownAcquired, r.collectedCents]);
    const ledger = () =>
      one(pool, `select (select count(*) from ad_spend_daily) as spend_rows, (select sum(cost_cents) from ad_spend_daily) as spend_cents,
        (select count(*) from raw_events) as raw_events, (select count(*) from leads) as leads, (select count(*) from crm_customers) as customers,
        (select sum(total_cents) from crm_tickets) as invoiced, (select sum(amount_cents) from crm_payments where status = 'successful') as collected`);
    const before = { ledger: await ledger(), branches: pick(await branchRows(pool, ALL)) };

    const plan = await planReplay(pool, gap, "1.1");
    expect(plan.rawEventIds.length).toBeGreaterThan(15);
    const request = {
      ...plan, mapperVersion: "1.1", actor: "test", idempotencyKey: "scenario-remap-1", dryRun: false,
      now: new Date("2026-10-31T13:00:00Z"), exceptionId: gap.id, scope: { ...OCT, branchIds: [branch] },
    };
    const result = await replay(pool, request);
    expect(result.projected).toBe(plan.rawEventIds.length);
    expect(result.after!.channels.google_lsa.spendCents).toBeGreaterThan(result.before!.channels.google_lsa.spendCents);
    expect(result.after!.paidSpendCents).toBe(result.before!.paidSpendCents);

    // Across all 44 branches: no spend, customer, invoice or payment created or lost.
    expect(await ledger()).toEqual(before.ledger);
    expect(pick(await branchRows(pool, ALL))).toEqual(before.branches);
    // Local Services spend at the branch is continuous across the migration.
    const days = await one(pool, `select count(distinct s.spend_date) as n from ad_spend_daily s join campaign_branch_map m on m.campaign_id = s.campaign_id
      where m.branch_id = $1 and s.channel_code = 'google_lsa' and s.spend_date >= '2026-09-01' and s.spend_date < '2026-10-31'`, [branch]);
    expect(days.n).toBe("60");
    expect((await getException(pool, gap.id))!.status).toBe("resolved");
    expect((await budgetSignal(pool, branch, OCT)).trustworthy).toBe(true);
    expect((await replay(pool, request)).alreadyProcessed).toBe(true);
  });

  it("unmapped spend blocks the budget signal of the branch whose customers it produced (audit 2026-11-09, D-1)", async () => {
    // The seed's one unmapped campaign is Local Services spend whose customers are serviced at
    // B44. Its exception has no branch (no branch owns the campaign), and before the fix that
    // meant it blocked nothing: B44 read "trustworthy" while LSA's cost there was understated.
    const unmapped = await one<{ id: string; external: string }>(pool, "select id, evidence->>'externalCampaignId' as external from exceptions where kind = 'unmapped_spend' and status = 'open'");
    const hit = await one<{ n: string }>(pool, "select count(*) n from v_acquisitions where campaign_external_id = $1 and branch_id = 'B44' and initial_status = 'completed'", [unmapped.external]);
    expect(Number(hit.n)).toBeGreaterThan(0);
    const signal = await budgetSignal(pool, "B44", OCT);
    expect(signal.trustworthy).toBe(false);
    expect(signal.blockers.map((b) => b.exceptionId)).toContain(Number(unmapped.id));
    // It blocks only where its customers are: the ChangeGuard branch is not held by it.
    expect((await budgetSignal(pool, "B09", OCT)).blockers.map((b) => b.exceptionId)).not.toContain(Number(unmapped.id));
    // No branch owns it, so only company-wide roles may open it: holds and blockers say so, and a
    // branch- or brand-scoped view names it without a link to "not found" (book gap N27).
    expect(signal.blockers.find((b) => b.exceptionId === Number(unmapped.id))?.companyLevel).toBe(true);
    expect((await decisionHolds(pool, ["B44"])).find((h) => h.exceptionId === Number(unmapped.id))).toMatchObject({ branchId: "B44", companyLevel: true });
    // Control, whatever the earlier tests resolved: a hold is company-level exactly when its incident
    // has no branch, so a branch's own incidents stay openable from its holds.
    for (const h of await decisionHolds(pool, null, 100)) {
      const own = await one<{ branch_id: string | null }>(pool, "select branch_id from exceptions where id = $1", [h.exceptionId]);
      expect(h.companyLevel, `hold #${h.exceptionId}`).toBe(own.branch_id === null);
    }
    // Decision Lab: the brand lead (B44 is in the brand) reads the reason without a dead link; a
    // company-wide role still opens it.
    const hrefs = async (viewer: Viewer) =>
      (await decisionVerdicts(pool, viewer, { branchId: "B44", period: PERIODS.oct })).channels.flatMap((c) => [...c.integrity.reasons, ...c.readiness.reasons]).map((r) => r.href);
    expect(VIEWERS.brand.branchIds).toContain("B44");
    expect(await hrefs(VIEWERS.brand)).not.toContain(`/exceptions/${unmapped.id}`);
    expect(await hrefs(VIEWERS.marketing)).toContain(`/exceptions/${unmapped.id}`);
  });
});

/**
 * A scenario's branch baseline is the scorecard's own figure (2026-11-17). In exp-n1 case R one
 * person revokes B03's Local Services currency rule, so all of that campaign's October spend is held
 * at intake. The scorecard's paid-media CAC (definition v3) then leaves out the 14 customers
 * credited to the held campaign: $8,930.74 over 36 = $248.08. The scenario summed every paid-media
 * channel's customers instead: $8,930.74 over 50 = $178.61, under the same name, for the same branch
 * and period. Everything here runs in one transaction that is rolled back, so the seeded world the
 * other tests read stays as it was.
 */
describe("a scenario's branch baseline is the scorecard's (B03 with Local Services held at intake)", () => {
  let client: PoolClient;
  let tx: Pool;
  const NOW = new Date("2026-10-31T13:40:00Z");
  const move = (fromChannel: string, toChannel: string) =>
    ScenarioRequestSchema.parse({ branchId: "B03", period: "oct", changes: [{ fromChannel, toChannel, amountCents: 50_000 }] });
  const ledger = () =>
    one(
      tx,
      `select (select coalesce(sum(cost_cents), 0) from ad_spend_daily)::text as spend, (select count(*) from raw_events)::int as raw_events,
              (select count(*) from crm_customers)::int as customers, (select coalesce(sum(total_cents), 0) from crm_tickets)::text as invoiced,
              (select coalesce(sum(amount_cents), 0) from crm_payments where status = 'successful')::text as collected`,
    );

  beforeAll(async () => {
    client = await pool.connect();
    await client.query("begin");
    tx = nestedPool(client);
    const rule = await one<{ id: string }>(tx, "select id from currency_rules where platform = 'google_lsa' and ad_account_id = 'LSA-B03' and revoked_at is null");
    await revokeCurrencyRule(tx, VIEWERS.engineer, { ruleId: Number(rule.id), reason: "test: account currency not confirmed", now: NOW });
    await withTransaction(tx, (t) => reconcile(t, NOW));
  });
  afterAll(async () => {
    await client.query("rollback");
    client.release();
  });

  it("the scorecard counts 36 of B03's 50 paid-media customers: the 14 credited to the held campaign have no cost in any figure", async () => {
    const [row] = await branchRows(tx, { from: PERIODS.oct.from, to: PERIODS.oct.to, branchIds: ["B03"] });
    const channels = (await channelRows(tx, { from: PERIODS.oct.from, to: PERIODS.oct.to, branchIds: ["B03"] })).filter((c) => c.costBasis === "media");
    expect(row).toMatchObject({ paidSpendCents: 893_074, paidAcquired: 36, heldCampaignAcquired: 14 });
    expect(channels.reduce((t, c) => t + c.spendCents, 0)).toBe(row.paidSpendCents);
    expect(channels.reduce((t, c) => t + c.acquired, 0)).toBe(50);
    expect(paidCac(row.paidSpendCents, row.paidAcquired)).toBe(24_808);
  });

  it("a saved Search ↔ Meta scenario carries the scorecard's baseline, and reads the same after reload", async () => {
    const [row] = await branchRows(tx, { from: PERIODS.oct.from, to: PERIODS.oct.to, branchIds: ["B03"] });
    const scorecard = paidCac(row.paidSpendCents, row.paidAcquired);
    for (const [from, to] of [["google_search", "meta"], ["meta", "google_search"]]) {
      const computed = await scenario(tx, VIEWERS.marketing, move(from, to));
      const saved = await saveScenario(tx, VIEWERS.marketing, move(from, to));
      const reopened = (await listScenarios(tx, VIEWERS.marketing, { branchId: "B03" })).find((s) => s.id === saved.id)!;
      for (const r of [computed, saved.result, reopened.result]) {
        expect(r.baseline, `${from} → ${to}`).toMatchObject({ paidSpendCents: row.paidSpendCents, paidCustomers: row.paidAcquired, paidCacCents: scorecard });
        // The projection's branch totals count the same customers: the forecast's change, on 36.
        expect(r.projection.paidCustomers.point).toBeCloseTo(row.paidAcquired + r.projection.deltaCustomers.point, 9);
        expect(r.projection.paidCacCents.point).toBe(Math.round(row.paidSpendCents / r.projection.paidCustomers.point));
      }
      expect(computed.decisionReady).toBe(true);
      expect(computed.warnings.join(" ")).toMatch(/This compares two channels, not the branch/);
    }
  });

  it("decides as before: Local Services held and not ready, the recommendation held, B04 untouched, the ledger unchanged", async () => {
    const before = await ledger();
    for (const [from, to] of [["google_search", "google_lsa"], ["google_lsa", "google_search"], ["meta", "google_lsa"], ["google_lsa", "meta"]]) {
      await expect(scenario(tx, VIEWERS.marketing, move(from, to)), `${from} → ${to}`).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/held at intake/) });
    }
    await saveScenario(tx, VIEWERS.marketing, move("google_search", "meta"));
    const v = await decisionVerdicts(tx, VIEWERS.marketing, { branchId: "B03", period: PERIODS.oct });
    expect(v.channels.find((c) => c.channelCode === "google_lsa")!.readiness.blockers.map((b) => b.code)).toContain("cost_held");
    expect(v.budgetSignal.recommendation.status).toBe("held");
    expect(builderDefaults(v.budgetSignal, v.channels.map((c) => c.channelCode))).toEqual({ from: "", to: "" });

    // The clean-spend control: every B04 customer is counted, so its baseline is the scorecard's and
    // the channels' sum alike, as it always was; nothing of B03's hold reaches it.
    const [b04] = await branchRows(tx, { from: PERIODS.oct.from, to: PERIODS.oct.to, branchIds: ["B04"] });
    const r04 = await scenario(tx, VIEWERS.marketing, ScenarioRequestSchema.parse({ branchId: "B04", period: "oct", changes: [{ fromChannel: "google_search", toChannel: "google_lsa", amountCents: 50_000 }] }));
    const sum = (k: "spendCents" | "customers") => r04.baseline.channels.reduce((t, c) => t + c[k], 0);
    expect(r04.baseline.paidCacCents).toBe(paidCac(b04.paidSpendCents, b04.paidAcquired));
    expect(r04.baseline.paidCacCents).toBe(paidCac(sum("spendCents"), sum("customers")));
    expect(r04.projection.paidCustomers.point).toBeCloseTo(sum("customers") + r04.projection.deltaCustomers.point, 9);
    expect(r04.decisionReady).toBe(true);
    const v04 = await decisionVerdicts(tx, VIEWERS.marketing, { branchId: "B04", period: PERIODS.oct });
    expect(v04.budgetSignal.recommendation.status).toBe("shift");
    expect(v04.channels.find((c) => c.channelCode === "google_lsa")!.readiness.status).toBe("ready");
    expect(await ledger()).toEqual(before);
  });
});
