import { appendFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import type { Pool } from "pg";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapCampaignToBranch } from "@/lib/actions";
import { createPool } from "@/lib/db";
import { branchRows, conversionBridge, totals, type BranchRow, type Scope, type Totals } from "@/lib/metrics/scorecard";
import { instantToWallTime } from "@/lib/primitives";
import { call, crm, freshDb, ingest, runReconcile } from "@/tests/helpers";

/**
 * Shared helpers for the cohort audit. Only revenue_signal_audit_cohort_test is ever written;
 * every record enters through the product's own intake (ingestRecords via tests/helpers.ingest),
 * the product's own campaign-mapping decision (lib/actions.mapCampaignToBranch) and the product's
 * own reconciliation. Nothing is inserted behind the pipeline's back.
 */

/** Where evidence.jsonl is appended: COHORT_OUT, or this folder. */
export const SCRATCH = process.env.COHORT_OUT ?? fileURLToPath(new URL(".", import.meta.url)).replace(/\\/g, "/").replace(/\/$/, "");
export const TEST_DB = "revenue_signal_audit_cohort_test";
export const TEST_URL = `postgres://postgres@127.0.0.1:54333/${TEST_DB}`;

/** A pool on the cohort test database, refused for any other database (freshDb drops the schema). */
export async function cohortPool(): Promise<Pool> {
  if (process.env.TEST_DATABASE_URL !== TEST_URL) throw new Error(`refusing to run: TEST_DATABASE_URL must be ${TEST_URL}`);
  const pool = createPool(TEST_URL);
  const { rows } = await pool.query<{ d: string }>("select current_database() as d");
  if (rows[0].d !== TEST_DB) {
    await pool.end();
    throw new Error(`refusing to touch ${rows[0].d}`);
  }
  return pool;
}

/** Prints a labelled evidence line and appends it to evidence.jsonl in the scratch folder. */
export function evidence(label: string, value: unknown): void {
  const line = JSON.stringify({ label, value }, (_k, v) => (typeof v === "bigint" ? v.toString() : v));
  console.log(`EVIDENCE ${line}`);
  appendFileSync(`${SCRATCH}/evidence.jsonl`, `${line}\n`);
}

// ── Fixture parameters (written before the first run; see expected.json) ─────────────────────

export const A = "B10"; // the campaign's branch (CRM office 110)
export const B = "B11"; // the serviced customer's CRM office / servicing branch (CRM office 111)
const TZ = "America/Phoenix"; // both branches: UTC-7, no DST
export const wall = (d: Date) => instantToWallTime(d, TZ);
const at = (iso: string) => new Date(iso);

export const CAMPAIGN_A = "coh-A";
export const PHONE_1 = "+16025550101";
export const PHONE_2 = "+16025550102";
export const OCT: Scope = { from: at("2026-10-01T00:00:00Z"), to: at("2026-10-31T00:00:00Z"), branchIds: null };

export const T = {
  spendReceived: at("2026-10-05T06:00:00Z"),
  mappedAt: at("2026-10-05T07:00:00Z"),
  call1: at("2026-10-06T16:00:00Z"),
  sold1: at("2026-10-06T18:00:00Z"),
  call2: at("2026-10-07T16:00:00Z"),
  sold2: at("2026-10-07T18:00:00Z"),
  cancel2: at("2026-10-09T15:00:00Z"),
  init1: at("2026-10-09T16:00:00Z"),
  done1: at("2026-10-09T17:00:00Z"),
  ticket1: at("2026-10-09T18:00:00Z"),
  init2: at("2026-10-12T16:00:00Z"),
  d1: at("2026-10-10T17:00:00Z"),
  c1: at("2026-10-12T00:00:00Z"), // cutoff between d1 and d2
  d2: at("2026-10-15T17:00:00Z"),
  retry: at("2026-10-16T09:00:00Z"),
  d3: at("2026-10-22T17:00:00Z"),
};

/** One day of Google Ads spend, shaped like the ads feed (no stated currency: the fixture's USD rule applies). */
export function spendDay(campaignId: string, date: string, dollars: number, fetchedAt: string, extra: Record<string, unknown> = {}): RawRecord {
  return {
    entity: "spend_day",
    payload: {
      platform: "google_ads", accountId: "GA-COHORT", campaignId, campaignName: `${campaignId} | Search`, campaignType: "SEARCH",
      date, costMicros: String(Math.round(dollars * 1_000_000)), clicks: 10, conversions: 1, fetchedAt, ...extra,
    },
  };
}

/** The product's own mapping decision (audited, reconciles in its transaction). */
export async function mapCampaign(pool: Pool, externalId: string, branchId: string, now: Date): Promise<number> {
  const { rows } = await pool.query<{ id: string }>("select id from ad_campaigns where platform = 'google_ads' and external_campaign_id = $1", [externalId]);
  if (!rows[0]) throw new Error(`campaign ${externalId} was not created by intake`);
  await mapCampaignToBranch(pool, { campaignId: Number(rows[0].id), branchId, actor: "marketing-ops", reason: "cohort fixture: the campaign targets this branch", now });
  return Number(rows[0].id);
}

const plus = (d: Date, minutes: number) => new Date(d.getTime() + minutes * 60_000);

/** Records of the fixture, by name, so later steps can re-deliver or revise them. */
export const R = {
  spend1: spendDay(CAMPAIGN_A, "2026-10-03", 100, "2026-10-03T23:00:00Z"),
  spend2: spendDay(CAMPAIGN_A, "2026-10-04", 100, "2026-10-04T23:00:00Z"),
  call1: call("COH-CALL-1", A, PHONE_1, T.call1, "Google Ads", { campaign: CAMPAIGN_A }),
  call2: call("COH-CALL-2", A, PHONE_2, T.call2, "Google Ads", { campaign: CAMPAIGN_A }),
  // Person 1 books; the CRM office (servicing branch) is B; the initial service completes.
  cust1: crm.customer(9101, B, PHONE_1, T.sold1),
  sub1: crm.subscription(9201, 9101, B, T.sold1),
  appt1Pending: crm.appointment(9301, 9201, 9101, B, "0", T.init1, T.sold1),
  appt1Done: crm.appointment(9301, 9201, 9101, B, "1", T.init1, T.done1),
  ticket1: crm.ticket(9401, 9101, 9301, B, "200.00", T.ticket1),
  pay1: crm.payment(9501, 9101, 9401, B, "120.00", T.d1),
  pay2: crm.payment(9502, 9101, 9401, B, "80.00", T.d2),
  refund: crm.payment(9503, 9101, 9401, B, "-20.00", T.d3, "1", "9502"),
  // Person 2 books at A and cancels before the initial service.
  cust2: crm.customer(9102, A, PHONE_2, T.sold2),
  sub2: crm.subscription(9202, 9102, A, T.sold2),
  appt2Pending: crm.appointment(9302, 9202, 9102, A, "0", T.init2, T.sold2),
  sub2Cancelled: crm.subscription(9202, 9102, A, T.sold2, { active: "0", dateCancelled: wall(T.cancel2), dateUpdated: wall(T.cancel2) }),
  appt2Cancelled: crm.appointment(9302, 9202, 9102, A, "-1", T.init2, T.cancel2),
};

export interface Stage {
  label: string;
  company: Totals;
  rows: BranchRow[];
}

/** The scorecard as the Overview and branch pages read it: branch rows, totals, both for one scope. */
export async function scorecard(pool: Pool, scope: Scope): Promise<{ rows: BranchRow[]; totals: Totals }> {
  const rows = await branchRows(pool, scope);
  return { rows, totals: await totals(pool, scope, rows) };
}

export const pickRow = (r: BranchRow | undefined) =>
  r && {
    branch: r.branchId, paidSpendCents: r.paidSpendCents, platformClaimed: r.platformClaimed, rawLeads: r.rawLeads, prospects: r.prospects, paidProspects: r.paidProspects,
    sold: r.sold, acquired: r.acquired, paidAcquired: r.paidAcquired, collectedCents: r.collectedCents, refundsCents: r.refundsCents,
    newCustomerCollectedCents: r.newCustomerCollectedCents, newCustomerAcvCents: r.newCustomerAcvCents, openExceptions: r.openExceptions, atRiskCents: r.atRiskCents,
  };

export const pickTotals = (t: Totals) => ({
  paidSpendCents: t.paidSpendCents, unallocatedSpendCents: t.unallocatedSpendCents, rawLeads: t.rawLeads, prospects: t.prospects, paidProspects: t.paidProspects,
  sold: t.sold, acquired: t.acquired, paidAcquired: t.paidAcquired, paidCacCents: t.paidCacCents, collectedCents: t.collectedCents, refundsCents: t.refundsCents,
  newCustomerCollectedCents: t.newCustomerCollectedCents, openExceptions: t.openExceptions, atRiskCents: t.atRiskCents, untiedCents: t.untiedCents,
  creditDisputedCents: t.creditDisputedCents, unknownShare: t.unknownShare,
});

/**
 * Builds the fixture through the real pipeline, one delivery batch per source event, each at its
 * own receipt time, reconciling after each as the worker would. `onStage` is called with the
 * name of each point the audit measures at.
 */
export async function buildFixture(
  pool: Pool,
  opts: { lead1Branch?: string } = {},
  onStage: (name: string, now: Date) => Promise<void> = async () => {},
): Promise<{ campaignA: number }> {
  await freshDb(pool);
  const step = async (source: Parameters<typeof ingest>[1], records: RawRecord[], now: Date) => {
    const stats = await ingest(pool, source, records, { now });
    await runReconcile(pool, now);
    return stats;
  };
  await step("ads", [R.spend1, R.spend2], T.spendReceived);
  const campaignA = await mapCampaign(pool, CAMPAIGN_A, A, T.mappedAt);
  // Variant: the first caller reached a tracking number tagged for another branch (same campaign).
  const call1 = opts.lead1Branch ? call("COH-CALL-1", opts.lead1Branch, PHONE_1, T.call1, "Google Ads", { campaign: CAMPAIGN_A }) : R.call1;
  await step("calls", [call1], plus(T.call1, 5));
  await step("crm", [R.cust1, R.sub1, R.appt1Pending], plus(T.sold1, 30));
  await step("calls", [R.call2], plus(T.call2, 5));
  await step("crm", [R.cust2, R.sub2, R.appt2Pending], plus(T.sold2, 30));
  await step("crm", [R.sub2Cancelled, R.appt2Cancelled], plus(T.cancel2, 30));
  await step("crm", [R.appt1Done, R.ticket1], plus(T.ticket1, 30));
  await step("crm", [R.pay1], plus(T.d1, 30));
  await onStage("after_d1", plus(T.d1, 30));
  await step("crm", [R.pay2], plus(T.d2, 30));
  await onStage("after_d2", plus(T.d2, 30));
  const retryStats = await step("crm", [R.pay2, R.pay2], T.retry);
  evidence("fixture.retry_ingest_stats", retryStats);
  await onStage("after_retry", T.retry);
  await step("crm", [R.refund], plus(T.d3, 30));
  await onStage("after_d3", plus(T.d3, 30));
  return { campaignA };
}

export { conversionBridge, ingest, runReconcile, plus };
