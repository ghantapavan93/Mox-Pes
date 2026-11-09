import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { wallTimeToInstant } from "@/lib/primitives";
import { BRANCH_BY_OFFICE, SCENARIO } from "@/lib/reference";
import { seed, type SeedReport } from "@/lib/sim/seed";
import { CALLS_FIX_DEPLOYED_AT, PERIOD_END } from "@/lib/sim/world";
import { branchRows, conversionBridge, totals } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { quarantineGroupIds, replay } from "@/lib/ingest/replay";
import { planReplay } from "@/lib/ingest/replay-plan";
import { budgetSignal } from "@/lib/metrics/decision";
import { getException } from "@/lib/queries";
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
});
