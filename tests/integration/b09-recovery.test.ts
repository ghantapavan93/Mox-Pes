import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { decisionVerdicts } from "@/lib/decision/verdicts";
import { withTransaction } from "@/lib/db";
import { dispatchEvents } from "@/lib/events/consumers";
import { runStream } from "@/lib/ingest/ingest";
import { runOutcome, verificationSentence } from "@/lib/ingest/run-outcome";
import { traceBranchMetric } from "@/lib/lineage/trace";
import { budgetSignal } from "@/lib/metrics/decision";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { recentRuns, verificationsByRun } from "@/lib/queries";
import { gapCoverage } from "@/lib/reconcile/gap-coverage";
import { gapStatusesAt } from "@/lib/reconcile/gap-status";
import { InMemorySourceClient } from "@/lib/sim/clients";
import { VIEWERS } from "@/lib/viewer";
import { transitionCase } from "@/lib/workflow/cases";
import { acquisition, call, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * B09: from decision hold to verified recovery. The B09 story in miniature: a Local Services
 * campaign that Google migrated into Performance Max on Oct 13, whose spend the old mapper
 * (ads@1.0) filed as Google Search. The active mapper files Performance Max with Local Services
 * enabled as Local Services, so the source's own re-fetch of those dates, through the ads feed,
 * re-files the spend. It adds no money.
 *
 * The expected results were written by hand first (docs/agent-work/B09-RECOVERY.md §2a) and are
 * computed from the records below, never from a product query:
 *
 *   lsa-B09      Local Services            B09  Oct 1–12   10,000 + 100·d cents   127,800
 *   pmax-lsa-B09 Performance Max, LSA on   B09  Oct 13–30  20,000 + 37·d cents    374,319
 *   gs-B09       Search                    B09  Oct 1–30   30,000 cents           900,000
 *   gs-B13       Search (control)          B13  Oct 1–30   25,000 cents           750,000
 *
 * The open incident requires every date from its gap start (Oct 13) to the feed's latest date
 * (Oct 30): 18 dates. A re-fetch of some of them (the selected chart week) must not clear the
 * hold; all of them, reconciled, clear exactly that incident, under its own id and case.
 */

const BRANCH = "B09";
const CONTROL = "B13";
const OCT = PERIODS.oct;
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const at = (iso: string) => new Date(`2026-10-31T${iso}:00Z`);
const SEEDED = at("08:00");

const CAMPAIGN = {
  lsa: { platform: "google_lsa", accountId: "LSA-B09", campaignId: "lsa-B09", campaignName: "B09 | Local Services", campaignType: "LOCAL_SERVICES" },
  pmax: { platform: "google_ads", accountId: "LSA-B09", campaignId: "pmax-lsa-B09", campaignName: "B09 | Local Services (PMax, pay-per-lead)", campaignType: "PERFORMANCE_MAX", localServicesEnabled: true },
  search: { platform: "google_ads", accountId: "GA-SW", campaignId: "gs-B09", campaignName: "B09 | Search", campaignType: "SEARCH" },
  control: { platform: "google_ads", accountId: "GA-SW2", campaignId: "gs-B13", campaignName: "B13 | Search", campaignType: "SEARCH" },
} as const;
type Campaign = keyof typeof CAMPAIGN;

/** The ledger's cents for one campaign-day. */
const CENTS: Record<Campaign, (d: number) => number> = {
  lsa: (d) => 10_000 + 100 * d,
  pmax: (d) => 20_000 + 37 * d,
  search: () => 30_000,
  control: () => 25_000,
};

/** One spend record as the source sends it; the original fetch is the next day at 06:00Z. */
function spend(campaign: Campaign, d: number, fetchedAt?: string, cents = CENTS[campaign](d)): RawRecord {
  const original = new Date(new Date(`${day(d)}T00:00:00Z`).getTime() + 30 * 3_600_000).toISOString();
  return { entity: "spend_day", payload: { ...CAMPAIGN[campaign], date: day(d), costMicros: String(cents * 10_000), clicks: 10, conversions: 3, fetchedAt: fetchedAt ?? original } };
}
const range = (from: number, to: number) => Array.from({ length: to - from + 1 }, (_, i) => from + i);
const sum = (days: number[], campaign: Campaign) => days.reduce((t, d) => t + CENTS[campaign](d), 0);

let pool: Pool;
beforeAll(() => {
  pool = testPool();
});
afterAll(async () => pool.end());

const setClock = (when: Date) => pool.query("update app_clock set now = $1", [when]);

/** One polling run of the ads feed at `when` (the path the worker uses), then the intake's consumers (reconciliation). */
async function deliverAds(records: RawRecord[], when: Date) {
  await setClock(when);
  const versions = records.map((r) => ({ stream: "ads", entity: r.entity, visibleAt: when.getTime() - 60_000, payload: r.payload as Record<string, unknown> }));
  const run = await runStream(pool, { client: new InMemorySourceClient("ads", "ads", versions), mapper: mapperFor("ads"), ctx: referenceContext, now: when, windowEnd: when, overlapMs: 0, initialCursor: new Date(when.getTime() - 24 * 3_600_000) });
  expect(run.status).toBe("succeeded");
  await dispatchEvents(pool);
  return run;
}

async function seed({ successorFrom = 13 } = {}) {
  await freshDb(pool);
  const ads: RawRecord[] = [
    ...range(1, 12).map((d) => spend("lsa", d)),
    ...range(successorFrom, 30).map((d) => spend("pmax", d)),
    ...range(1, 30).map((d) => spend("search", d)),
    ...range(1, 30).map((d) => spend("control", d)),
  ];
  await ingest(pool, "ads", ads, { mapper: mapperFor("ads", "1.0"), now: SEEDED });
  await pool.query(
    `insert into campaign_branch_map (campaign_id, branch_id, mapped_by, mapped_at)
     select id, case when external_campaign_id = 'gs-B13' then $2 else $1 end, 'marketing-ops', $3 from ad_campaigns`,
    [BRANCH, CONTROL, SEEDED],
  );
  const c1 = acquisition(1, BRANCH, "+16025559001", new Date(`${day(9)}T16:00:00Z`), { source: "Google LSA" });
  const c2 = acquisition(2, BRANCH, "+16025559002", new Date(`${day(18)}T16:00:00Z`), { source: "Google LSA" });
  const c3 = acquisition(3, CONTROL, "+16025559003", new Date(`${day(10)}T16:00:00Z`), { source: "Google Ads" });
  await ingest(pool, "calls", [...range(1, 30).map((d) => call(`LSA-${d}`, BRANCH, `+1602555${String(8000 + d)}`, new Date(`${day(d)}T15:00:00Z`), "Google LSA")), c1.call, c2.call, c3.call], { now: SEEDED });
  await ingest(pool, "crm", [...c1.crm, ...c2.crm, ...c3.crm], { now: SEEDED });
  await setClock(SEEDED);
  await runReconcile(pool, SEEDED);
}

const gaps = async () => (await pool.query<{ id: string; status: string; fingerprint: string; resolution: string | null }>("select id, status, fingerprint, resolution from exceptions where kind = 'channel_coverage_gap' order by id")).rows;
const caseOf = async (exceptionId: string) => one<{ id: string; state: string }>(pool, "select id, state from cases where exception_id = $1", [exceptionId]);
const spendOf = async (branch: string, channel: string) =>
  Number(
    (
      await one<{ c: string | null }>(
        pool,
        `select sum(s.cost_cents) as c from ad_spend_daily s join campaign_branch_map m on m.campaign_id = s.campaign_id
         where m.branch_id = $1 and s.channel_code = $2 and s.spend_date >= '2026-10-01' and s.spend_date < '2026-10-31'`,
        [branch, channel],
      )
    ).c ?? 0,
  );
/** What no correction may change: per-branch customers and collected cash, and the control's spend. */
const controls = async () => {
  const rows = await branchRows(pool, { from: OCT.from, to: OCT.to, branchIds: null });
  const b = (id: string) => rows.find((r) => r.branchId === id)!;
  return { b09: { acquired: b(BRANCH).acquired, collected: b(BRANCH).collectedCents, paid: b(BRANCH).paidSpendCents }, b13: { acquired: b(CONTROL).acquired, collected: b(CONTROL).collectedCents, paid: b(CONTROL).paidSpendCents } };
};
/** The incident's window as the accepted records cover it, by the production rule. */
const coverageOf = async (id: string) => {
  const e = await one<{ evidence: Record<string, unknown>; branch_id: string }>(pool, "select evidence, branch_id from exceptions where id = $1", [id]);
  return (await gapCoverage(pool, e.evidence, e.branch_id))!;
};
const days = (from: number, to: number) => range(from, to).map(day);
const CONTROLS = { b09: { acquired: 2, collected: 29_800, paid: 1_402_119 }, b13: { acquired: 1, collected: 14_900, paid: 750_000 } };
/** A delivery run's own row, as the Integrations pipeline reads it (DELIVERY-OUTCOMES.md). */
const runRow = (id: number) =>
  one<{ fetched: number; inserted: number; duplicates: number; projected: number; rows_changed: number | null }>(pool, "select fetched, inserted, duplicates, projected, rows_changed from ingestion_runs where id = $1", [id]);
/** The words its row shows: what it changed, why not, and each verification that used it. */
const outcomeOf = async (id: number) => {
  const r = await runRow(id);
  const o = runOutcome({ fetched: r.fetched, inserted: r.inserted, duplicates: r.duplicates, projected: r.projected, rowsChanged: r.rows_changed }, (await verificationsByRun(pool, [id])).get(id));
  return [o.effect, ...(o.reason ? [o.reason] : []), ...o.verifications.map(verificationSentence)];
};

describe("B09: a re-fetch clears the hold only when the whole window is covered", () => {
  let original: { id: string; fingerprint: string };
  let caseId: string;
  let r1: number;
  let r2: number;

  beforeAll(async () => {
    await seed();
  }, 180_000);

  it("missing: Oct 13–30 have no Local Services spend; the incident holds the decision", async () => {
    const rows = await gaps();
    expect(rows).toHaveLength(1);
    original = rows[0];
    expect(original).toMatchObject({ status: "open", fingerprint: "channel_coverage_gap:B09:google_lsa:2026-10-12" });
    caseId = (await caseOf(original.id)).id;
    expect([await spendOf(BRANCH, "google_lsa"), await spendOf(BRANCH, "google_search"), await spendOf(CONTROL, "google_search")]).toEqual([127_800, 1_274_319, 750_000]);
    const signal = await budgetSignal(pool, BRANCH, OCT);
    expect(signal.trustworthy).toBe(false);
    expect(signal.blockers.map((b) => String(b.exceptionId))).toContain(original.id);
    const c = await coverageOf(original.id);
    expect([c.window, c.required, c.covered, c.missing, c.misfiledCents, c.complete]).toEqual([{ from: "2026-10-13", to: "2026-10-30" }, days(13, 30), [], days(13, 30), 374_319, false]);
    // The status every view shows (lib/reconcile/gap-status.ts): held, nothing covered, the money filed as Search.
    const [s] = await gapStatusesAt(pool, BRANCH);
    expect(s).toMatchObject({ exceptionId: Number(original.id), state: "missing", held: true });
    // Changed 2026-11-16 (HOLD-TO-DECISION.md §1.5): the decision first, then why. It read "Decision held: none of …".
    expect(s.conclusion).toBe("Hold the budget decision. A required Google Local Services spend record is missing at B09: none of the 18 dates in the decision window (Oct 13–Oct 30) has one.");
    expect(s.change).toBe("Since Oct 13, $3,743.19 has been spent under pmax-lsa-B09, which is filed as Google Search; none of it is filed as Google Local Services.");
    expect(await controls()).toEqual(CONTROLS);
  });

  it("partial: the selected week (Oct 26–30) re-fetched, Oct 13–25 still missing: the same incident still holds", async () => {
    r1 = (await deliverAds(range(26, 30).map((d) => spend("pmax", d, "2026-10-31T09:00:00Z")), at("09:05"))).runId;
    expect(await spendOf(BRANCH, "google_lsa")).toBe(127_800 + 105_180);
    expect(await spendOf(BRANCH, "google_search")).toBe(1_274_319 - 105_180);
    // The decision gate first: on the code before this fix, the selected week's re-fetch opened it.
    const signal = await budgetSignal(pool, BRANCH, OCT);
    expect(signal.trustworthy).toBe(false);
    expect(signal.blockers.map((b) => String(b.exceptionId))).toContain(original.id);
    const rows = await gaps();
    expect(rows.map((r) => [r.id, r.status])).toEqual([[original.id, "open"]]);
    expect(await caseOf(original.id)).toMatchObject({ id: caseId });
    expect((await caseOf(original.id)).state).not.toMatch(/resolved|closed/);
    // What the accepted records cover now, and which run carried it: the week, not the window.
    const c = await coverageOf(original.id);
    expect([c.covered, c.missing, c.misfiledCents, c.complete]).toEqual([days(26, 30), days(13, 25), 269_139, false]);
    expect(c.runs).toEqual([{ runId: r1, adapterVersion: "ads@1.2", fetchedAt: { first: "2026-10-31T09:00:00Z", last: "2026-10-31T09:00:00Z" }, dates: days(26, 30), cents: 105_180 }]);
    // Decision Lab says why it still holds.
    const v = await decisionVerdicts(pool, VIEWERS.marketing, { branchId: BRANCH, period: OCT });
    const gate = v.channels.find((x) => x.channelCode === "google_lsa")!.readiness.reasons.find((r) => r.code === "budget_gate" && r.status === "fail")!;
    // Changed 2026-11-14 (B09-CROSS-VIEW.md): the clause is now the one every view uses for the
    // decision window; it said "5 of 18 required dates now have Google Local Services spend; …".
    expect(gate.text).toContain(" 5 of 18 dates in the decision window (Oct 13–Oct 30) have Google Local Services spend at B09; Oct 13–Oct 25 still have none, so it still holds.");
    // The incident, the daily evidence and the Overview read the same status: the week is not the window.
    const [s] = await gapStatusesAt(pool, BRANCH);
    expect(s.conclusion).toBe("Still on hold · 5 of 18 days verified. Oct 26–Oct 30 are covered, but the decision window (Oct 13–Oct 30) is not: Oct 13–Oct 25 still have no Google Local Services record.");
    expect(s.change).toBe("Originally $3,743.19 was filed as Google Search. Now $1,051.80 (Oct 26–Oct 30) is filed as Google Local Services; $2,691.39 (Oct 13–Oct 25) is still filed as Google Search.");
    expect(await controls()).toEqual(CONTROLS);
    // The run, as recorded when it ran: 5 versions stored, 5 accepted records changed; the hold
    // stands, so no verification has used it yet.
    expect(await runRow(r1)).toEqual({ fetched: 5, inserted: 5, duplicates: 0, projected: 5, rows_changed: 5 });
    expect(await outcomeOf(r1)).toEqual(["5 changes to accepted records"]);
  });

  it("sufficient: the rest (Oct 13–25) re-fetched: the original incident resolves under its own id and case", async () => {
    r2 = (await deliverAds(range(13, 25).map((d) => spend("pmax", d, "2026-10-31T11:00:00Z")), at("11:05"))).runId;
    expect([await spendOf(BRANCH, "google_lsa"), await spendOf(BRANCH, "google_search")]).toEqual([127_800 + sum(range(13, 30), "pmax"), 900_000]);
    expect(127_800 + sum(range(13, 30), "pmax")).toBe(502_119);
    const rows = await gaps();
    expect(rows.map((r) => [r.id, r.status])).toEqual([[original.id, "resolved"]]);
    expect(await caseOf(original.id)).toMatchObject({ id: caseId });
    const signal = await budgetSignal(pool, BRANCH, OCT);
    expect(signal.blockers.map((b) => String(b.exceptionId))).not.toContain(original.id);
    // Verified once, on the incident itself: the rule, the window, the runs and revisions it rests on.
    const row = await one<{ resolution: string; evidence: Record<string, unknown> }>(pool, "select resolution, evidence from exceptions where id = $1", [original.id]);
    expect(row.resolution).toMatch(/^Verified: all 18 required dates \(Oct 13–Oct 30\) have .+ spend at B09 in the accepted source records, from 2 delivery run\(s\); no successor spend in that window is filed under another channel or at another branch\.$/);
    expect(row.evidence).toMatchObject({ lastSpendDate: "2026-10-12", gapStart: "2026-10-13", feedLatestDate: "2026-10-30" });
    expect(row.evidence.verification).toMatchObject({
      window: { from: "2026-10-13", to: "2026-10-30" },
      requiredDates: 18,
      coveredDates: 18,
      coveredCents: 374_319,
      runs: [
        { runId: r2, adapterVersion: "ads@1.2", fetchedAt: { first: "2026-10-31T11:00:00Z", last: "2026-10-31T11:00:00Z" }, dates: days(13, 25), cents: 269_139 },
        { runId: r1, adapterVersion: "ads@1.2", fetchedAt: { first: "2026-10-31T09:00:00Z", last: "2026-10-31T09:00:00Z" }, dates: days(26, 30), cents: 105_180 },
      ],
    });
    // Cleared, and the same money moved: Decision Lab says it for October, not for September.
    const [s] = await gapStatusesAt(pool, BRANCH, { range: { from: "2026-10-01", to: "2026-10-31" } });
    expect(s).toMatchObject({ exceptionId: Number(original.id), state: "verified", held: false, reclassified: true });
    expect(s.change).toBe("$3,743.19 moved from Google Search to Google Local Services, and no amount changed: reclassified, not added.");
    expect(s.label).toBe("Coverage hold cleared · 18 of 18 days verified");
    expect(await gapStatusesAt(pool, BRANCH, { range: { from: "2026-09-01", to: "2026-10-01" } })).toEqual([]);
    // The handoff (B09-HANDOFF.md): a run the verification names opens on the ingestion pipeline,
    // listed however many runs came after it.
    expect((await recentRuns(pool, 1)).map((r) => Number(r.id))).toEqual([r2]);
    expect((await recentRuns(pool, 1, r1)).map((r) => Number(r.id))).toEqual([r2, r1]);
    expect(await controls()).toEqual(CONTROLS);
    // Each run's row (DELIVERY-OUTCOMES.md): what it changed when it ran, then the share of the
    // window the verification took from it. The ledger's cents for those dates, by hand:
    expect([sum(range(26, 30), "pmax"), sum(range(13, 25), "pmax")]).toEqual([105_180, 269_139]);
    expect(await runRow(r2)).toEqual({ fetched: 13, inserted: 13, duplicates: 0, projected: 13, rows_changed: 13 });
    expect(await outcomeOf(r1)).toEqual(["5 changes to accepted records", `Incident #${original.id}'s verification used Oct 26–Oct 30 (5 of 18 dates) to clear its coverage hold.`]);
    expect(await outcomeOf(r2)).toEqual(["13 changes to accepted records", `Incident #${original.id}'s verification used Oct 13–Oct 25 (13 of 18 dates) to clear its coverage hold.`]);
  });

  it("duplicate replay: the same correction again changes no money, opens nothing, records no second recovery", async () => {
    const before = { rows: await gaps(), evidence: (await one<{ e: unknown }>(pool, "select evidence as e from exceptions where id = $1", [original.id])).e, events: (await one<{ n: string }>(pool, "select count(*) as n from case_events where case_id = $1", [caseId])).n };
    const run = await deliverAds(range(13, 25).map((d) => spend("pmax", d, "2026-10-31T11:00:00Z")), at("12:05"));
    expect([run.stats?.inserted, run.stats?.duplicates]).toEqual([0, 13]);
    expect([await spendOf(BRANCH, "google_lsa"), await spendOf(BRANCH, "google_search")]).toEqual([502_119, 900_000]);
    expect(await gaps()).toEqual(before.rows);
    expect((await one<{ e: unknown }>(pool, "select evidence as e from exceptions where id = $1", [original.id])).e).toEqual(before.evidence);
    expect((await one<{ n: string }>(pool, "select count(*) as n from case_events where case_id = $1", [caseId])).n).toBe(before.events);
    expect(await controls()).toEqual(CONTROLS);
    // Its row: nothing stored, and recorded as having changed nothing (not inferred from that).
    expect(await runRow(run.runId)).toEqual({ fetched: 13, inserted: 0, duplicates: 13, projected: 0, rows_changed: 0 });
    expect(await outcomeOf(run.runId)).toEqual(["No change to accepted records", "Duplicate: every delivery was a version already stored"]);
  });

  it("an older revision delivered late cannot replace the accepted correction", async () => {
    const run = await deliverAds([spend("pmax", 20, "2026-10-31T10:00:00Z", 25_740)], at("12:10"));
    expect(Number((await one<{ c: string }>(pool, "select s.cost_cents as c from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id where c.external_campaign_id = 'pmax-lsa-B09' and s.spend_date = '2026-10-20'")).c)).toBe(20_740);
    expect([await spendOf(BRANCH, "google_lsa"), await spendOf(BRANCH, "google_search")]).toEqual([502_119, 900_000]);
    expect((await gaps()).map((r) => [r.id, r.status])).toEqual([[original.id, "resolved"]]);
    // Its row: stored (the pipeline's former "New 1"), but superseded, so it changed nothing; and
    // the verification still rests on r2 and r1 alone, once (no second verification).
    expect(await runRow(run.runId)).toEqual({ fetched: 1, inserted: 1, duplicates: 0, projected: 1, rows_changed: 0 });
    expect(await outcomeOf(run.runId)).toEqual(["No change to accepted records", "Stored, but a newer revision was already accepted"]);
    expect([...(await verificationsByRun(pool, [r1, r2, run.runId])).keys()].sort((a, b) => a - b)).toEqual([r1, r2]);
    expect((await one<{ e: Record<string, unknown> }>(pool, "select evidence as e from exceptions where id = $1", [original.id])).e.previousVerifications).toBeUndefined();
    expect(await controls()).toEqual(CONTROLS);
  });

  it("a later feed day does not reopen a verified incident: the verified window stays Oct 13–30", async () => {
    const before = await one<{ status: string; evidence: Record<string, unknown> }>(pool, "select status, evidence from exceptions where id = $1", [original.id]);
    await deliverAds([spend("search", 31, "2026-10-31T12:30:00Z"), spend("control", 31, "2026-10-31T12:30:00Z")], at("12:35"));
    const after = await one<{ status: string; evidence: Record<string, unknown> }>(pool, "select status, evidence from exceptions where id = $1", [original.id]);
    expect(after).toEqual(before);
    expect((await coverageOf(original.id)).window).toEqual({ from: "2026-10-13", to: "2026-10-30" });
    expect(await controls()).toEqual(CONTROLS);
  });

  it("a later version that un-covers a verified date reopens the same incident; repaired again, both verifications are kept", async () => {
    await deliverAds([spend("pmax", 20, "2026-10-31T12:40:00Z", 0)], at("12:45"));
    expect((await gaps()).map((r) => [r.id, r.status])).toEqual([[original.id, "open"]]);
    expect((await caseOf(original.id)).id).toBe(caseId);
    expect((await budgetSignal(pool, BRANCH, OCT)).blockers.map((b) => String(b.exceptionId))).toContain(original.id);
    expect((await coverageOf(original.id)).recordedZero).toEqual([day(20)]);
    // The current hold, on the same incident, with the earlier verification kept as history, never
    // shown as a clearance (HOLD-TO-DECISION.md §1.4, scenario 7).
    const [reopened] = await gapStatusesAt(pool, BRANCH);
    expect(reopened).toMatchObject({ exceptionId: Number(original.id), state: "partial", held: true, label: "Still on hold · 17 of 18 days verified" });
    expect(reopened.label).not.toMatch(/cleared/i);
    const held = await one<{ evidence: { verification?: { verifiedAt: string } } }>(pool, "select evidence from exceptions where id = $1", [original.id]);
    expect(held.evidence.verification?.verifiedAt).toBe(at("11:05").toISOString());
    const repair = await deliverAds([spend("pmax", 20, "2026-10-31T12:50:00Z")], at("12:55"));
    const row = await one<{ status: string; evidence: { previousVerifications?: unknown[]; verification?: { verifiedAt: string } } }>(pool, "select status, evidence from exceptions where id = $1", [original.id]);
    expect(row.status).toBe("resolved");
    expect(row.evidence.previousVerifications).toHaveLength(1);
    expect(row.evidence.verification?.verifiedAt).toBe(at("12:55").toISOString());
    expect((await gaps()).map((r) => r.id)).toEqual([original.id]);
    expect(await controls()).toEqual(CONTROLS);
    // Both verifications stay on the runs' rows, each with what it used: r2 gave 13 dates to the
    // first and 12 to the second (Oct 20 now comes from the repair).
    const v = `Incident #${original.id}'s verification used`;
    expect((await outcomeOf(r2)).slice(1)).toEqual([`${v} Oct 13–Oct 25 (13 of 18 dates) to clear its coverage hold.`, `${v} Oct 13–Oct 19, Oct 21–Oct 25 (12 of 18 dates) to clear its coverage hold.`]);
    expect(await outcomeOf(repair.runId)).toEqual(["1 change to accepted records", `${v} Oct 20 (1 of 18 dates) to clear its coverage hold.`]);
  });
});

describe("B09: the campaign record follows the newest fetch, as each spend day does (release check, 2026-11-15)", () => {
  let gap: string;

  beforeAll(async () => {
    await seed();
    gap = (await gaps())[0].id;
    await deliverAds(range(26, 30).map((d) => spend("pmax", d, "2026-10-31T09:00:00Z")), at("09:05"));
    await deliverAds(range(13, 25).map((d) => spend("pmax", d, "2026-10-31T11:00:00Z")), at("11:05"));
  }, 180_000);

  /** One version of a successor day as the source sends it, with other campaign fields. */
  const revision = (d: number, fetchedAt: string, fields: Record<string, unknown>, cents?: number): RawRecord => {
    const r = spend("pmax", d, fetchedAt, cents);
    return { entity: r.entity, payload: { ...(r.payload as Record<string, unknown>), ...fields } };
  };
  const campaign = () =>
    one<{ name: string; channel_code: string; campaign_type: string | null; local_services_enabled: boolean }>(
      pool,
      "select name, channel_code, campaign_type, local_services_enabled from ad_campaigns where external_campaign_id = 'pmax-lsa-B09'",
    );
  const dayRow = (d: number) =>
    one<{ cost_cents: string; channel_code: string; fetched_at: string }>(
      pool,
      `select s.cost_cents, s.channel_code, re.payload ->> 'fetchedAt' as fetched_at
       from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id join raw_events re on re.id = s.raw_event_id
       where c.external_campaign_id = 'pmax-lsa-B09' and s.spend_date = $1`,
      [day(d)],
    );
  const traced = async () => (await traceBranchMetric(pool, VIEWERS.marketing, { branchId: BRANCH, period: OCT, metric: "paid_spend" })).numerator.campaigns.find((c) => c.externalCampaignId === "pmax-lsa-B09")!;
  /** What the newest fetch (11:00) says about the campaign. */
  const NEWEST = { name: CAMPAIGN.pmax.campaignName, channel_code: "google_lsa", campaign_type: "PERFORMANCE_MAX", local_services_enabled: true };

  it("an older revision with another name and a Search campaign's inputs is stored, changes nothing, and leaves the campaign as the newest fetch said", async () => {
    expect(await campaign()).toEqual(NEWEST);
    const before = { oct20: await dayRow(20), lsa: await spendOf(BRANCH, "google_lsa"), search: await spendOf(BRANCH, "google_search"), trace: await traced(), controls: await controls() };
    // Fetched 10:30: older than Oct 20's accepted 11:00 revision, and a version of its own (no other fetch at 10:30).
    const run = await deliverAds([revision(20, "2026-10-31T10:30:00Z", { campaignName: "B09 | Search", campaignType: "SEARCH", localServicesEnabled: false }, CENTS.pmax(20) + 5_000)], at("12:30"));
    expect(await runRow(run.runId)).toEqual({ fetched: 1, inserted: 1, duplicates: 0, projected: 1, rows_changed: 0 });
    expect(await outcomeOf(run.runId)).toEqual(["No change to accepted records", "Stored, but a newer revision was already accepted"]);
    // Each facet on its own: the accepted day, the allocation, the campaign record, the trace, the decision.
    expect(await dayRow(20)).toEqual(before.oct20);
    expect([await spendOf(BRANCH, "google_lsa"), await spendOf(BRANCH, "google_search")]).toEqual([before.lsa, before.search]);
    // On the code before this check, the late 10:30 version rewrote the campaign: "B09 | Search",
    // google_search, SEARCH (the B09 world showed the same; RELEASE-CANDIDATE.md §1).
    expect(await campaign()).toEqual(NEWEST);
    expect(await traced()).toEqual(before.trace);
    const [s] = await gapStatusesAt(pool, BRANCH, { range: { from: "2026-10-01", to: "2026-10-31" } });
    expect(s).toMatchObject({ exceptionId: Number(gap), state: "verified", held: false, reclassified: true });
    expect((await budgetSignal(pool, BRANCH, OCT)).blockers.map((b) => String(b.exceptionId))).not.toContain(gap);
    expect(await controls()).toEqual(before.controls);
  });

  it("a newer revision still renames the campaign, and files its own day", async () => {
    const run = await deliverAds([revision(30, "2026-10-31T12:00:00Z", { campaignName: "B09 | Local Services (renamed)" })], at("12:35"));
    expect(await campaign()).toEqual({ ...NEWEST, name: "B09 | Local Services (renamed)" });
    expect((await dayRow(30)).fetched_at).toBe("2026-10-31T12:00:00Z");
    expect(await outcomeOf(run.runId)).toEqual(["1 change to accepted records"]);
    expect((await traced()).name).toBe("B09 | Local Services (renamed)");
  });

  it("an older-date backfill repairs its own day without rolling back the newer campaign record", async () => {
    // Oct 14 fetched 11:30: newer than that day's accepted 11:00 revision, older than the 12:00
    // rename. It still carries the campaign's old name.
    const lsa = await spendOf(BRANCH, "google_lsa");
    const run = await deliverAds([revision(14, "2026-10-31T11:30:00Z", {}, CENTS.pmax(14) + 1_000)], at("12:40"));
    expect(await dayRow(14)).toEqual({ cost_cents: String(CENTS.pmax(14) + 1_000), channel_code: "google_lsa", fetched_at: "2026-10-31T11:30:00Z" });
    expect(await spendOf(BRANCH, "google_lsa")).toBe(lsa + 1_000);
    expect(await outcomeOf(run.runId)).toEqual(["1 change to accepted records"]);
    expect(await campaign()).toEqual({ ...NEWEST, name: "B09 | Local Services (renamed)" });
  });

  it("history before migration 0031: each campaign's clock is the newest fetch its accepted spend rests on", async () => {
    const clocks = async () => (await pool.query<{ id: string; c: Date | null }>("select id, source_updated_at as c from ad_campaigns order by id")).rows.map((r) => [r.id, r.c?.toISOString() ?? null]);
    const recorded = await clocks();
    expect(Object.fromEntries(recorded)[String((await one<{ id: string }>(pool, "select id from ad_campaigns where external_campaign_id = 'pmax-lsa-B09'")).id)]).toBe("2026-10-31T12:00:00.000Z");
    const migration = readFileSync(path.join(process.cwd(), "database", "migrations", "0031_campaign_source_clock.sql"), "utf8");
    await pool.query("update ad_campaigns set source_updated_at = null"); // as if recorded before 0031
    await pool.query(migration);
    expect(await clocks()).toEqual(recorded);
    await pool.query(migration); // applied again: nothing changes
    expect(await clocks()).toEqual(recorded);
  });
});

describe("B09: a successor that starts two days after the stop", () => {
  beforeAll(async () => {
    await seed({ successorFrom: 15 });
  }, 180_000);

  it("its transition (Oct 13–14, no record in either campaign) is listed, not required; re-filing the successor verifies", async () => {
    const [original] = await gaps();
    expect(original.status).toBe("open");
    const before = await coverageOf(original.id);
    expect([before.window, before.transition, before.complete]).toEqual([{ from: "2026-10-15", to: "2026-10-30" }, days(13, 14), false]);
    const paid = (await controls()).b09.paid;
    await deliverAds(range(15, 30).map((d) => spend("pmax", d, "2026-10-31T09:00:00Z")), at("09:05"));
    expect((await gaps()).map((r) => [r.id, r.status])).toEqual([[original.id, "resolved"]]);
    expect((await coverageOf(original.id)).complete).toBe(true);
    expect((await controls()).b09.paid).toBe(paid);
  });
});

/**
 * The earlier overlap (R-54 case 1; HOLD-TO-DECISION.md §7, F2): the successor started on Oct 10,
 * three days before the predecessor's last day ended the overlap. The decision window still starts
 * at the gap (Oct 13), so a verification proves the window and nothing before it.
 */
describe("B09: a successor that started three days before the stop", () => {
  beforeAll(async () => {
    await seed({ successorFrom: 10 });
  }, 180_000);

  it("the window (Oct 13–30) verifies; the overlap days (Oct 10–12) stay filed as Search, outside what it proves", async () => {
    const [original] = await gaps();
    expect(original.status).toBe("open");
    const before = await coverageOf(original.id);
    expect([before.window, before.transition]).toEqual([{ from: "2026-10-13", to: "2026-10-30" }, []]);
    const paid = (await controls()).b09.paid;

    await deliverAds(range(13, 30).map((d) => spend("pmax", d, "2026-10-31T09:00:00Z")), at("09:05"));
    expect((await gaps()).map((r) => [r.id, r.status])).toEqual([[original.id, "resolved"]]);
    const [s] = await gapStatusesAt(pool, BRANCH, { range: { from: "2026-10-01", to: "2026-10-31" } });
    expect(s).toMatchObject({ exceptionId: Number(original.id), state: "verified", reclassified: true });
    // What moved is the window's money, by hand: Oct 13–30 of pmax-lsa-B09.
    expect(sum(range(13, 30), "pmax")).toBe(374_319);
    expect(s.change).toBe("$3,743.19 moved from Google Search to Google Local Services, and no amount changed: reclassified, not added.");
    // Oct 10–12 of the same campaign were never re-sent: still Google Search, and not part of the claim.
    expect(sum(range(10, 12), "pmax")).toBe(61_221);
    expect([await spendOf(BRANCH, "google_lsa"), await spendOf(BRANCH, "google_search")]).toEqual([127_800 + 374_319, 900_000 + 61_221]);
    expect((await coverageOf(original.id)).window).toEqual({ from: "2026-10-13", to: "2026-10-30" });
    expect((await controls()).b09.paid).toBe(paid);
  });
});

describe("B09: the successor mapped away from the branch does not hide misfiled spend", () => {
  beforeAll(async () => {
    await seed();
  }, 180_000);

  it("another campaign covering every date, with the successor moved to B13, does not verify the incident", async () => {
    const [original] = await gaps();
    const other: RawRecord[] = range(13, 30).map((d) => ({
      entity: "spend_day",
      payload: { platform: "google_lsa", accountId: "LSA-B09-2", campaignId: "lsa2-B09", campaignName: "B09 | Local Services 2", campaignType: "LOCAL_SERVICES", date: day(d), costMicros: String(1_000 * 10_000), clicks: 1, conversions: 0, fetchedAt: "2026-10-31T08:30:00Z" },
    }));
    await ingest(pool, "ads", other, { mapper: mapperFor("ads"), now: at("08:45") });
    await pool.query("insert into campaign_branch_map (campaign_id, branch_id, mapped_by, mapped_at) select id, $1, 'test', $2 from ad_campaigns where external_campaign_id = 'lsa2-B09'", [BRANCH, at("08:45")]);
    await pool.query("update campaign_branch_map set branch_id = $1 where campaign_id = (select id from ad_campaigns where external_campaign_id = 'pmax-lsa-B09')", [CONTROL]);
    await setClock(at("09:05"));
    await runReconcile(pool, at("09:05"));
    expect((await gaps()).map((r) => [r.id, r.status])).toEqual([[original.id, "open"]]);
    const c = await coverageOf(original.id);
    expect([c.missing, c.misfiled.length, c.misfiled.every((m) => m.branchId === CONTROL)]).toEqual([[], 18, true]);
    expect((await budgetSignal(pool, BRANCH, OCT)).trustworthy).toBe(false);
  });
});

describe("B09: a middle week re-fetched leaves dates on both sides missing", () => {
  beforeAll(async () => {
    await seed();
  }, 180_000);

  it("Oct 19–25 re-fetched: one incident, the original, still open; no second incident", async () => {
    const [original] = await gaps();
    await deliverAds(range(19, 25).map((d) => spend("pmax", d, "2026-10-31T09:00:00Z")), at("09:05"));
    expect([await spendOf(BRANCH, "google_lsa"), await spendOf(BRANCH, "google_search")]).toEqual([127_800 + 145_698, 1_274_319 - 145_698]);
    expect((await gaps()).map((r) => [r.id, r.status])).toEqual([[original.id, "open"]]);
    expect((await budgetSignal(pool, BRANCH, OCT)).trustworthy).toBe(false);
    const c = await coverageOf(original.id);
    expect([c.covered, c.missing]).toEqual([days(19, 25), [...days(13, 18), ...days(26, 30)]]);
    expect(await controls()).toEqual(CONTROLS);
  });

  it("closing the case by hand is not a correction: the incident stays open and still holds", async () => {
    const [g] = await gaps();
    const kase = await caseOf(g.id);
    await withTransaction(pool, (tx) => transitionCase(tx, { caseId: Number(kase.id), from: kase.state as never, to: "closed_insufficient_evidence", reason: "test: closed by hand" }, "test", at("10:00")));
    await setClock(at("10:05"));
    await runReconcile(pool, at("10:05"));
    expect((await gaps()).map((r) => [r.id, r.status])).toEqual([[g.id, "open"]]);
    expect((await budgetSignal(pool, BRANCH, OCT)).trustworthy).toBe(false);
  });
});

describe("an untouched incident is re-detected exactly as before, with fresh evidence", () => {
  beforeAll(async () => {
    await seed();
  }, 180_000);

  it("a new feed day (Oct 31, Search only) moves the feed's latest date and the window; same incident", async () => {
    const [original] = await gaps();
    await deliverAds([spend("search", 31, "2026-10-31T09:00:00Z"), spend("control", 31, "2026-10-31T09:00:00Z")], at("09:05"));
    const row = await one<{ evidence: Record<string, unknown> }>(pool, "select evidence from exceptions where id = $1", [original.id]);
    // Rule 6 still sees this very incident (no Local Services spend after Oct 12), so its evidence is refreshed as it always was.
    expect(row.evidence).toMatchObject({ lastSpendDate: "2026-10-12", feedLatestDate: "2026-10-31", gapDays: 19 });
    expect((await gaps()).map((r) => [r.id, r.status])).toEqual([[original.id, "open"]]);
    expect((await coverageOf(original.id)).window).toEqual({ from: "2026-10-13", to: "2026-10-31" });
  });
});
