import { afterAll, beforeAll, expect, it, vi } from "vitest";
import type { Pool } from "pg";
import { attentionFlags } from "@/lib/attention";
import { decisionVerdicts } from "@/lib/decision/verdicts";
import { money } from "@/lib/format";
import { traceCash } from "@/lib/lineage/cash";
import { traceBranchMetric } from "@/lib/lineage/trace";
import { budgetSignal, decisionHolds } from "@/lib/metrics/decision";
import { METRICS } from "@/lib/metrics/definitions";
import { branchRows, channelRows, conversionBridge, paidCac, totals } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { listExceptions } from "@/lib/queries";
import { compareSnapshot, SnapshotSchema } from "@/lib/shadow/snapshot";
import { VIEWERS } from "@/lib/viewer";
import { A, B, OCT, T, buildFixture, cohortPool, evidence, pickRow, pickTotals, plus, scorecard } from "./cohort-lib";

/**
 * Cohort fixture, parts 1-3 (funnel grains, cash at cutoffs, CAC split) plus the lead-branch
 * variant. Expected values were written to expected.json before the first run; each `check`
 * records expected vs actual and soft-asserts the requester's expectation.
 */

const route = vi.hoisted(() => ({ viewer: null as unknown, pool: null as unknown }));
vi.mock("@/lib/server", () => ({
  getViewer: async () => route.viewer,
  getPool: () => route.pool,
  businessNow: async () => new Date("2026-10-31T13:00:00Z"),
}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<Record<string, unknown>>()), connection: async () => {} }));

let pool: Pool;
beforeAll(async () => {
  pool = await cohortPool();
  route.pool = pool;
  route.viewer = VIEWERS.marketing;
});
afterAll(async () => pool?.end());

function check(q: string, expected: unknown, actual: unknown, source: string) {
  const match = JSON.stringify(expected) === JSON.stringify(actual);
  evidence(`check.${q}`, { expected, actual, match, source });
  expect.soft(actual, q).toEqual(expected);
}

const scopeOf = (branchIds: string[] | null, to: Date = OCT.to) => ({ from: OCT.from, to, branchIds });
const viewer = VIEWERS.marketing;

it("parts 1-3: funnel, cash at cutoffs, CAC split (leads tagged A, customer serviced at B)", async () => {
  const stages: Record<string, unknown> = {};
  await buildFixture(pool, {}, async (name) => {
    const oct = await totals(pool, scopeOf(null));
    const toC1 = await totals(pool, scopeOf(null, T.c1));
    const rowB = (await branchRows(pool, scopeOf([B])))[0];
    const pay = await pool.query(
      `select p.crm_payment_id, p.amount_cents, p.status, re.delivery_count, re.received_at, re.last_delivered_at
       from crm_payments p join raw_events re on re.id = p.raw_event_id order by 1`,
    );
    const raw9502 = await pool.query(
      "select external_id, delivery_count, status from raw_events where source = 'crm' and entity = 'payment' and entity_id = '9502'",
    );
    stages[name] = {
      octCollectedCents: oct.collectedCents, octRefundsCents: oct.refundsCents, octNewCustomerCollectedCents: oct.newCustomerCollectedCents,
      windowToC1CollectedCents: toC1.collectedCents, branchBCollectedCents: rowB.collectedCents,
      paymentRows: pay.rows.length, payments: pay.rows, raw9502: raw9502.rows,
    };
  });
  evidence("p2.stages", stages);
  const s = stages as Record<string, { octCollectedCents: number; windowToC1CollectedCents: number; paymentRows: number }>;

  // ── 1 · funnel grains ─────────────────────────────────────────────────────────────────────
  const company = await scorecard(pool, scopeOf(null));
  const rowA = company.rows.find((r) => r.branchId === A);
  const rowB = company.rows.find((r) => r.branchId === B);
  const tA = await totals(pool, scopeOf([A]));
  const tB = await totals(pool, scopeOf([B]));
  evidence("p1.totals.company", pickTotals(company.totals));
  evidence("p1.totals.A", pickTotals(tA));
  evidence("p1.totals.B", pickTotals(tB));
  evidence("p1.branchRow.A", pickRow(rowA));
  evidence("p1.branchRow.B", pickRow(rowB));
  const bridge = {
    company: await conversionBridge(pool, scopeOf(null)),
    A: await conversionBridge(pool, scopeOf([A])),
    B: await conversionBridge(pool, scopeOf([B])),
  };
  evidence("p1.bridge", bridge);
  const otherBranches = company.rows.filter((r) => r.branchId !== A && r.branchId !== B && (r.sold || r.acquired || r.paidSpendCents || r.rawLeads));
  evidence("p1.otherBranchesWithActivity", otherBranches.map((r) => r.branchId));

  // Reporting contract (the published BI grain) and the raw tables: what states exist at all.
  const factAcq = await pool.query(
    "select crm_customer_id, branch_id, channel_code, sold_at, initial_status, initial_completed_at, collected_cents from reporting.fact_acquisitions_v1 order by 1",
  );
  evidence("p1.reporting.fact_acquisitions_v1", factAcq.rows);
  const subs = await pool.query("select crm_subscription_id, office_id, status, sold_at, cancelled_at from crm_subscriptions order by 1");
  evidence("p1.crm_subscriptions", subs.rows);
  const leadCols = await pool.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = 'leads' order by ordinal_position");
  evidence("p1.leads.columns", leadCols.rows.map((r) => r.column_name));
  const leadRows = await pool.query("select id, source, branch_id, channel_code, attribution_evidence, campaign_external_id, occurred_at, excluded_code from leads order by id");
  evidence("p1.leads", leadRows.rows);
  const leadCampaigns = await pool.query("select lead_id, campaign_external_id, platforms, platform, campaign_id, status from v_lead_campaigns order by 1");
  evidence("p1.v_lead_campaigns", leadCampaigns.rows);
  evidence("p1.metric_registry_keys", Object.keys(METRICS));

  check("bookings(sold)", 2, company.totals.sold, "lib/metrics/scorecard.ts totals.sold (v_acquisitions.sold_at in period)");
  check("completed_first_services(acquired)", 1, company.totals.acquired, "totals.acquired");
  check("cancellations_on_scorecard", 1, null, "no scorecard/bridge field counts cancellations; reporting.fact_acquisitions_v1.initial_status has them");
  check(
    "cancellations_in_reporting_contract",
    1,
    factAcq.rows.filter((r) => r.initial_status === "cancelled").length,
    "reporting.fact_acquisitions_v1 initial_status = 'cancelled'",
  );
  check("not_two_acquired", true, company.totals.acquired !== 2, "totals.acquired");
  check("bridge_serviced", 1, bridge.company.serviced, "conversionBridge.serviced");
  check("bridge_cancelled_bucket", 1, null, "conversionBridge has no cancelled bucket: soldNotServiced mixes cancelled and not-yet-serviced");

  // ── 2 · cash at cutoffs, retry, refund ────────────────────────────────────────────────────
  check("cash_known_after_d1(oct window)", 12000, s.after_d1.octCollectedCents, "totals.collectedCents, period oct, as stored after d1's delivery");
  check("cash_window_to_c1(payment-date cutoff)", 12000, s.after_d3.windowToC1CollectedCents, "totals.collectedCents with Scope.to = 2026-10-12 (library only)");
  check("cash_after_all", 18000, s.after_d3.octCollectedCents, "totals.collectedCents, period oct");
  check("retry_changes_totals", false, s.after_retry.octCollectedCents !== s.after_d2.octCollectedCents, "totals.collectedCents before/after re-delivery");
  check("retry_payment_rows", 2, s.after_retry.paymentRows, "crm_payments rows after re-delivery of 9502 (no duplicate row)");
  const cashB = await traceCash(pool, viewer, { branchId: B, period: PERIODS.oct });
  evidence("p2.traceCash.B", { value: cashB.value, payments: cashB.payments, invariants: cashB.invariants, newCustomers: cashB.newCustomers, atRisk: cashB.atRisk });
  const cashToC1 = await traceCash(pool, viewer, { branchId: B, period: { key: "oct", label: "custom [Oct 1, Oct 12)", from: OCT.from, to: T.c1 } });
  evidence("p2.traceCash.B.windowToC1", { value: cashToC1.value, newCustomers: cashToC1.newCustomers });

  // The route the screens use: a cutoff cannot be asked for, the period key falls back to October.
  const metricsRoute = await import("@/app/api/metrics/route");
  for (const q of ["period=oct", "period=2026-10-12", "period=oct&to=2026-10-12T00:00:00Z"]) {
    const res = await metricsRoute.GET(new Request(`http://localhost/api/metrics?${q}`));
    const body = (await res.json()) as { period: string; totals: { collectedCents: number; paidCacCents: number | null }; branches: Array<{ branchId: string; paidSpendCents: number; paidAcquired: number; collectedCents: number }> };
    evidence(`p2.api.metrics?${q}`, {
      status: res.status, period: body.period, collectedCents: body.totals.collectedCents, paidCacCents: body.totals.paidCacCents,
      A: body.branches.find((b) => b.branchId === A), B: body.branches.find((b) => b.branchId === B),
    });
  }

  // ── 3 · paid CAC, A vs B vs company ─────────────────────────────────────────────────────
  const cacA = paidCac(rowA!.paidSpendCents, rowA!.paidAcquired);
  const cacB = paidCac(rowB!.paidSpendCents, rowB!.paidAcquired);
  evidence("p3.cac", {
    A: { spend: rowA!.paidSpendCents, paidAcquired: rowA!.paidAcquired, cac: cacA, branchPageStat: money(tA.paidCacCents), overviewCell: money(rowA!.paidAcquired ? Math.round(rowA!.paidSpendCents / rowA!.paidAcquired) : null) },
    B: { spend: rowB!.paidSpendCents, paidAcquired: rowB!.paidAcquired, cac: cacB, branchPageStat: money(tB.paidCacCents), branchPageSub: `company ${money(company.totals.paidCacCents)}`, overviewCell: money(rowB!.paidAcquired ? Math.round(rowB!.paidSpendCents / rowB!.paidAcquired) : null) },
    company: { spend: company.totals.paidSpendCents, paidAcquired: company.totals.paidAcquired, cac: company.totals.paidCacCents, overviewStat: money(company.totals.paidCacCents) },
  });
  const flags = attentionFlags(company.rows);
  evidence("p3.attentionFlags", { A: flags.get(A), B: flags.get(B) });
  evidence("p3.channelRows.B", (await channelRows(pool, scopeOf([B]))).filter((c) => c.acquired || c.spendCents));
  evidence("p3.channelRows.A", (await channelRows(pool, scopeOf([A]))).filter((c) => c.acquired || c.spendCents));

  check("cohort_cost_per_booking", 10000, null, "no product metric divides spend by bookings (lib/metrics/definitions.ts METRICS keys)");
  check("cost_per_completed_first_service(company)", 20000, company.totals.paidCacCents, "totals.paidCacCents (PERIOD basis, coincides here)");
  check("spend_assigned_to_B", 0, rowB!.paidSpendCents, "branchRows B11 paidSpendCents");
  check("B_cac_not_presented_as_comparable", "not shown as a comparable figure", money(tB.paidCacCents), "app/branches/[id]/page.tsx:83 Stat value money(t.paidCacCents)");
  check("A_cac", "explicit cohort CAC $200 (campaign basis)", money(tA.paidCacCents), "branch page Stat for A");

  for (const branchId of [A, B]) {
    const trace = await traceBranchMetric(pool, viewer, { branchId, period: PERIODS.oct, metric: "paid_cac" });
    evidence(`p3.trace.${branchId}`, {
      value: trace.value,
      numerator: trace.numerator.campaigns.map((c) => ({ ext: c.externalCampaignId, spend: c.spendCents, mappedTo: c.mapping.branchId })),
      denominator: trace.denominator.customers.map((c) => ({ id: c.crmCustomerId, campaign: c.campaignExternalId, channel: c.channelCode })),
      excluded: trace.excluded,
      missing: trace.missing.map((m) => ({ kind: m.kind, detail: m.detail })),
      limitations: trace.limitations,
    });
  }

  const openExc = await listExceptions(pool, { branchIds: null, status: "open" });
  evidence("p3.exceptions.open", openExc.map((e) => ({ id: e.id, kind: e.kind, branch: e.branchId, summary: e.summary, amountCents: e.amountCents, evidence: e.evidence })));
  const allExc = await listExceptions(pool, { branchIds: null });
  evidence("p3.exceptions.all", allExc.map((e) => ({ kind: e.kind, branch: e.branchId, status: e.status, summary: e.summary })));
  for (const branchId of [A, B]) {
    const signal = await budgetSignal(pool, branchId, { from: OCT.from, to: OCT.to });
    evidence(`p3.budgetSignal.${branchId}`, { signal: signal.signal, trustworthy: signal.trustworthy, blockers: signal.blockers });
    const verdicts = await decisionVerdicts(pool, viewer, { branchId, period: PERIODS.oct });
    evidence(
      `p3.decisionVerdicts.${branchId}`,
      verdicts.channels
        .filter((c) => c.spendCents || c.acquired)
        .map((c) => ({
          channel: c.channelCode, spend: c.spendCents, acquired: c.acquired, cac: c.cacCents,
          integrity: c.integrity.status, integrityReasons: c.integrity.reasons.filter((r) => r.status !== "pass" && r.status !== "info").map((r) => `${r.code}:${r.status}:${r.text}`),
          readiness: c.readiness.status, readinessFails: c.readiness.reasons.filter((r) => r.status === "fail").map((r) => r.code),
        })),
    );
  }
  evidence("p3.decisionHolds.company", await decisionHolds(pool, null, 8, { from: OCT.from, to: OCT.to }));

  // Shadow Mode: can another system's cohort / per-booking figure even be stated and compared?
  const base = {
    system: "cohort-audit-sheet", asOf: "2026-10-31T00:00:00Z", scope: { company: true as const },
    period: { from: "2026-10-01", to: "2026-10-30" }, currency: "USD",
  };
  const perBooking = SnapshotSchema.parse({
    ...base, value: "100.00", numerator: "200.00", denominator: 2,
    definition: { id: "cost_per_booking", version: "1", family: "cac", numerator: "paid_media_spend_mapped_to_branch", population: "customers_sold", periodBasis: "utc_day", branchBasis: "campaign_mapping" },
  });
  const cohortBasis = SnapshotSchema.parse({
    ...base, value: "200.00", numerator: "200.00", denominator: 1,
    definition: { id: "cohort_cost_per_completed_first_service", version: "1", family: "cac", numerator: "paid_media_spend_mapped_to_branch", population: "new_customers_first_serviced_paid_first_touch", periodBasis: "campaign_cohort", branchBasis: "campaign_mapping" },
  });
  const now = plus(T.d3, 60);
  for (const [name, snap] of [["perBooking", perBooking], ["cohortBasis", cohortBasis]] as const) {
    const r = await compareSnapshot(pool, viewer, snap, now);
    evidence(`p3.shadow.${name}`, { verdict: r.verdict, dimensions: r.dimensions, findings: r.findings, ours: r.ours, limitations: r.limitations });
  }
});

it("variant: the serviced person's call is tagged B (same campaign, mapped to A)", async () => {
  await buildFixture(pool, { lead1Branch: B });
  const company = await scorecard(pool, scopeOf(null));
  const rowA = company.rows.find((r) => r.branchId === A);
  const rowB = company.rows.find((r) => r.branchId === B);
  evidence("v.branchRow.A", pickRow(rowA));
  evidence("v.branchRow.B", pickRow(rowB));
  evidence("v.totals.company", pickTotals(company.totals));
  evidence("v.bridge", { A: await conversionBridge(pool, scopeOf([A])), B: await conversionBridge(pool, scopeOf([B])) });
  const exc = await listExceptions(pool, { branchIds: null });
  evidence("v.exceptions.all", exc.map((e) => ({ kind: e.kind, branch: e.branchId, status: e.status, summary: e.summary })));
  const verdicts = await decisionVerdicts(pool, viewer, { branchId: B, period: PERIODS.oct });
  evidence(
    "v.decisionVerdicts.B",
    verdicts.channels.filter((c) => c.spendCents || c.acquired).map((c) => ({ channel: c.channelCode, cac: c.cacCents, integrity: c.integrity.status, warnings: c.integrity.reasons.filter((r) => r.status === "warn").map((r) => r.code) })),
  );
  check("variant_any_exception_flags_split", true, exc.some((e) => e.status === "open"), "listExceptions open (any kind)");
  check("variant_B_cac", "not shown as a comparable figure", money(paidCac(rowB!.paidSpendCents, rowB!.paidAcquired)), "branch CAC for B11");
});
