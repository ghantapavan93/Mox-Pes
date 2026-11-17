import { afterAll, beforeAll, expect, it } from "vitest";
import type { Pool } from "pg";
import type { RawRecord } from "@/lib/adapters/contract";
import { money } from "@/lib/format";
import { budgetSignal, decisionHolds } from "@/lib/metrics/decision";
import { paidCac, totals } from "@/lib/metrics/scorecard";
import { listExceptions } from "@/lib/queries";
import { SnapshotSchema } from "@/lib/shadow/snapshot";
import { getShadowCheck, runShadowCheck } from "@/lib/shadow/store";
import { VIEWERS } from "@/lib/viewer";
import { crm } from "@/tests/helpers";
import {
  A, B, CAMPAIGN_A, OCT, PHONE_1, PHONE_2, T, buildFixture, cohortPool, evidence, ingest, mapCampaign, pickRow, pickTotals, plus, runReconcile, scorecard, spendDay, wall,
} from "./cohort-lib";

/**
 * Cohort fixture, parts 4-5: an equal-total swap between branches (spend, then servicing offices),
 * and later changes after a decision cutoff. Everything enters through intake + reconciliation.
 */

let pool: Pool;
beforeAll(async () => {
  pool = await cohortPool();
});
afterAll(async () => pool?.end());

const viewer = VIEWERS.marketing;
const scopeOf = (branchIds: string[] | null, to: Date = OCT.to) => ({ from: OCT.from, to, branchIds });

function check(q: string, expected: unknown, actual: unknown, source: string) {
  const match = JSON.stringify(expected) === JSON.stringify(actual);
  evidence(`check.${q}`, { expected, actual, match, source });
  expect.soft(actual, q).toEqual(expected);
}

async function state(label: string) {
  const sc = await scorecard(pool, scopeOf(null));
  const row = (id: string) => sc.rows.find((r) => r.branchId === id)!;
  const exceptions = await listExceptions(pool, { branchIds: null });
  const out = {
    company: pickTotals(sc.totals),
    A: { ...pickRow(row(A)), cac: money(paidCac(row(A).paidSpendCents, row(A).paidAcquired)) },
    B: { ...pickRow(row(B)), cac: money(paidCac(row(B).paidSpendCents, row(B).paidAcquired)) },
    exceptions: exceptions.map((e) => ({ id: e.id, kind: e.kind, branch: e.branchId, status: e.status, summary: e.summary })),
  };
  evidence(label, out);
  return out;
}

const withPayload = (r: RawRecord, patch: Record<string, unknown>): RawRecord => ({ ...r, payload: { ...(r.payload as Record<string, unknown>), ...patch } });

it("part 4a: equal-total swap of spend between campaigns mapped to A and B", async () => {
  await buildFixture(pool);
  const addAt = new Date("2026-10-23T06:00:00Z");
  await ingest(pool, "ads", [spendDay("coh-B", "2026-10-03", 50, "2026-10-03T23:00:00Z")], { now: addAt });
  await mapCampaign(pool, "coh-B", B, plus(addAt, 60));
  const before = await state("p4a.before");
  // Both platforms restate Oct 3: A's campaign to $50, B's to $100. Newer fetches, accepted.
  const swapAt = new Date("2026-10-25T12:00:00Z");
  const stats = await ingest(pool, "ads", [
    spendDay(CAMPAIGN_A, "2026-10-03", 50, "2026-10-25T11:00:00Z"),
    spendDay("coh-B", "2026-10-03", 100, "2026-10-25T11:00:00Z"),
  ], { now: swapAt });
  const rec = await runReconcile(pool, swapAt);
  evidence("p4a.swap", { stats, reconcile: rec });
  const after = await state("p4a.after");
  check("p4a.company_equal", true, JSON.stringify(before.company) === JSON.stringify(after.company), "totals() company, before vs after");
  check("p4a.branches_differ", true, before.A.paidSpendCents !== after.A.paidSpendCents && before.B.cac !== after.B.cac, "branchRows A/B before vs after");
  check("p4a.flagged_by_any_exception", true, JSON.stringify(before.exceptions) !== JSON.stringify(after.exceptions), "listExceptions before vs after");
  for (const id of [A, B]) {
    const s = await budgetSignal(pool, id, { from: OCT.from, to: OCT.to });
    evidence(`p4a.budgetSignal.${id}`, { trustworthy: s.trustworthy, blockers: s.blockers.length });
  }
  evidence("p4a.decisionHolds", await decisionHolds(pool, null, 8, { from: OCT.from, to: OCT.to }));
});

it("part 4b: equal-total swap of the two customers' servicing offices", async () => {
  await buildFixture(pool);
  const before = await state("p4b.before");
  const swapAt = new Date("2026-10-25T12:00:00Z");
  const upd = { dateUpdated: wall(swapAt) };
  // Customer 9101 (serviced) moves to A's office, 9102 (cancelled) to B's: newer CRM versions of
  // every record each customer has. Payments carry no version clock: a changed office is a new
  // version by content, applied in receipt order.
  const records: RawRecord[] = [
    crm.customer(9101, A, PHONE_1, T.sold1, upd),
    crm.subscription(9201, 9101, A, T.sold1, upd),
    withPayload(crm.appointment(9301, 9201, 9101, A, "1", T.init1, T.done1), upd),
    withPayload(crm.ticket(9401, 9101, 9301, A, "200.00", T.ticket1), upd),
    crm.payment(9501, 9101, 9401, A, "120.00", T.d1),
    crm.payment(9502, 9101, 9401, A, "80.00", T.d2),
    crm.payment(9503, 9101, 9401, A, "-20.00", T.d3, "1", "9502"),
    crm.customer(9102, B, PHONE_2, T.sold2, upd),
    crm.subscription(9202, 9102, B, T.sold2, { active: "0", dateCancelled: wall(T.cancel2), ...upd }),
    crm.appointment(9302, 9202, 9102, B, "-1", T.init2, swapAt),
  ];
  const stats = await ingest(pool, "crm", records, { now: swapAt });
  const rec = await runReconcile(pool, swapAt);
  evidence("p4b.swap", { stats, reconcile: rec });
  const after = await state("p4b.after");
  const differing = (Object.keys(before.company) as Array<keyof typeof before.company>).filter((k) => before.company[k] !== after.company[k]);
  evidence("p4b.company_fields_that_moved", differing.map((k) => ({ field: k, before: before.company[k], after: after.company[k] })));
  check("p4b.company_fields_that_moved", [], differing, "totals() company, before vs after");
  check("p4b.branches_differ", true, before.A.cac !== after.A.cac && before.B.cac !== after.B.cac, "branch CAC A/B before vs after");
});

it("part 5: later changes after a decision cutoff", async () => {
  await buildFixture(pool);
  const cutoff = new Date("2026-10-24T00:00:00Z");
  const cashSnapshot = (value: string) =>
    SnapshotSchema.parse({
      system: "decision-memo", asOf: cutoff.toISOString(), scope: { company: true }, period: { from: "2026-10-01", to: "2026-10-23" }, currency: "USD", value,
      definition: { id: "net_cash", version: "1", family: "cash", cashBasis: "payment_date_net_of_refunds", periodBasis: "utc_day", branchBasis: "crm_office" },
    });

  // What the decision saw at the cutoff, through the product's own reads.
  const atCutoff = {
    oct: pickTotals(await totals(pool, scopeOf(null))),
    windowToCutoff: pickTotals(await totals(pool, scopeOf(null, cutoff))),
  };
  evidence("p5.at_cutoff", atCutoff);
  const stored = await runShadowCheck(pool, viewer, { kind: "snapshot", input: cashSnapshot("180.00") }, cutoff);
  evidence("p5.shadow.at_cutoff", { id: stored.id, verdict: stored.verdict, ours: (stored.result as { ours: unknown }).ours, dims: (stored.result as { dimensions: unknown }).dimensions });

  // After the cutoff: a refund dated BEFORE it (delivered late), a refund dated after it, an
  // accepted newer spend revision of Oct 3, and a refused newer revision of Oct 4 (EUR).
  const lateAt = new Date("2026-10-26T10:00:00Z");
  const r1 = await ingest(pool, "crm", [
    crm.payment(9504, 9101, 9401, B, "-30.00", new Date("2026-10-21T17:00:00Z"), "1", "9501"),
    crm.payment(9505, 9101, 9401, B, "-10.00", new Date("2026-10-26T09:00:00Z"), "1", "9501"),
  ], { now: lateAt });
  await runReconcile(pool, lateAt);
  const reviseAt = new Date("2026-10-27T10:00:00Z");
  const r2 = await ingest(pool, "ads", [
    spendDay(CAMPAIGN_A, "2026-10-03", 140, "2026-10-27T09:00:00Z"),
    spendDay(CAMPAIGN_A, "2026-10-04", 90, "2026-10-27T09:00:00Z", { currencyCode: "EUR" }),
  ], { now: reviseAt });
  const rec = await runReconcile(pool, reviseAt);
  evidence("p5.late_ingest", { refunds: r1, spend: r2, reconcile: rec });

  const afterChanges = {
    oct: pickTotals(await totals(pool, scopeOf(null))),
    windowToCutoff: pickTotals(await totals(pool, scopeOf(null, cutoff))),
  };
  evidence("p5.after_changes", afterChanges);
  const now = new Date("2026-10-27T12:00:00Z");
  const rerun = await runShadowCheck(pool, viewer, { kind: "snapshot", input: cashSnapshot("180.00") }, now);
  evidence("p5.shadow.rerun", { id: rerun.id, verdict: rerun.verdict, result: rerun.result });
  const kept = await getShadowCheck(pool, viewer, stored.id);
  evidence("p5.shadow.stored_check_reread", { id: kept?.id, verdict: kept?.verdict, ours: (kept?.result as { ours: unknown }).ours, checkedAt: kept?.checkedAt });

  const exc = await listExceptions(pool, { branchIds: null });
  evidence("p5.exceptions", exc.map((e) => ({ id: e.id, kind: e.kind, branch: e.branchId, status: e.status, summary: e.summary, amountCents: e.amountCents })));
  evidence("p5.decisionHolds", await decisionHolds(pool, null, 8, { from: OCT.from, to: OCT.to }));
  const sig = await budgetSignal(pool, A, { from: OCT.from, to: OCT.to });
  evidence("p5.budgetSignal.A", { trustworthy: sig.trustworthy, blockers: sig.blockers.map((b) => ({ kind: b.kind, summary: b.summary, revisions: b.revisions })) });
  const spendRows = await pool.query(
    `select s.spend_date::text as day, s.cost_cents, s.source_updated_at, re.received_at, re.status from ad_spend_daily s join raw_events re on re.id = s.raw_event_id order by 1`,
  );
  evidence("p5.ad_spend_daily", spendRows.rows);
  const rawSpend = await pool.query(
    "select entity_id, status, error_code, exclusion_code, payload ->> 'costMicros' as micros, payload ->> 'fetchedAt' as fetched, received_at from raw_events where source = 'ads' order by id",
  );
  evidence("p5.raw_events.ads", rawSpend.rows);

  // AUDIT-ONLY SQL, not a product read path: the ledger still holds every version's receipt time,
  // so the cutoff figure is recoverable from raw_events; nothing in the product reads it this way.
  const ledger = await pool.query(
    `select coalesce(sum((re.payload ->> 'amount')::numeric * 100), 0)::bigint as cents
     from raw_events re where re.source = 'crm' and re.entity = 'payment' and re.status = 'projected' and re.received_at <= $1`,
    [cutoff],
  );
  evidence("p5.audit_only.ledger_sum_received_before_cutoff", ledger.rows[0]);

  check("p5.restated_window_to_cutoff", 18000, afterChanges.windowToCutoff.collectedCents, "totals() window [Oct 1, cutoff) re-read after the late refund");
  check("p5.cac_restated", 20000, afterChanges.oct.paidCacCents, "totals().paidCacCents after the accepted Oct 3 revision");
});
