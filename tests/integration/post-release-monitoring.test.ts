import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { getMonitorRun, monitorState, monitorView, type MonitorHooks, type MonitorRun } from "@/lib/changeguard/monitor";
import { OVERDUE_AFTER_MS } from "@/lib/changeguard/schedule";
import { createChange, decideChange, getChange, releaseChange, type ChangeRow } from "@/lib/changeguard/service";
import { decisionSummary } from "@/lib/changeguard/summary";
import { dateTime } from "@/lib/format";
import { runStream } from "@/lib/ingest/ingest";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { defaultRuntime } from "@/lib/jobs/runtime";
import { workerTick } from "@/lib/jobs/tick";
import { InMemorySourceClient } from "@/lib/sim/clients";
import { ForbiddenError, VIEWERS } from "@/lib/viewer";
import { call, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * Scheduled post-release monitoring (R-30), end to end on the real paths: changes go through
 * ChangeGuard (preflight → approval by another person → release), source records arrive through
 * the polling ingestion path (runStream → ingestRecords), and every check runs inside the
 * worker's own loop (workerTick → runDueChecks), driven by the business clock (app_clock), which
 * the test moves.
 *
 *   T0       release of mon-B20 → B20 (8 calls at B20 when approved)
 *   slot 1   a new call at B20 arrived → CURRENT (two workers race for the slot: one conclusion)
 *   slot 2   a revision changed only the agent note → CURRENT, no alert (benign)
 *   slot 3   no delivery for 42 h → INSUFFICIENT EVIDENCE (stale feed); last success not moved
 *   slot 4   the feed's latest run failed (503) → INSUFFICIENT EVIDENCE (unavailable)
 *   slot 5   a revision moved call MON-5 from B20 to B19, delivered twice → overdue first, then
 *            CONFIRMED DRIFT: one review item, recovery required, mapping untouched
 *   slot 6   the same revision delivered a third time → DRIFT again, the SAME review item updated
 *   slot 7   the check errors (fault) → nothing concluded, retried, then concluded for that slot
 */

const HOUR = 3_600_000;
const T0 = new Date("2026-10-31T13:00:00Z");
const at = (h: number, m = 0) => new Date(T0.getTime() + h * HOUR + m * 60_000);
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const { marketing, approver, partner, guest, brand } = VIEWERS;

function spend(campaignId: string, name: string, platform: string, d: number, dollars: number): RawRecord {
  return {
    entity: "spend_day",
    payload: { platform, accountId: `ACC-${campaignId}`, campaignId, campaignName: name, date: day(d), costMicros: String(dollars * 1_000_000), clicks: 5, conversions: 1, fetchedAt: `${day(d + 1)}T06:00:00Z`, campaignType: "SEARCH" },
  };
}

let pool: Pool;

async function setClock(when: Date) {
  await pool.query("update app_clock set now = $1", [when]);
}

/** One polling run of the call feed at `when`, delivering `records` (the real ingestion path). */
async function deliverCalls(records: RawRecord[], when: Date, fail: string | null = null) {
  const versions = records.map((r) => ({ stream: "calls", entity: r.entity, visibleAt: when.getTime() - 60_000, payload: r.payload as Record<string, unknown> }));
  const client = new InMemorySourceClient("calls", "calls", versions, () => fail);
  return runStream(pool, { client, mapper: mapperFor("calls"), ctx: referenceContext, now: when, windowEnd: when, overlapMs: 0, initialCursor: new Date(when.getTime() - 30 * 24 * HOUR) });
}

/** The worker's loop, as `npm run worker` runs it, at the business clock. */
const tick = (workerId = "test-worker", hooks?: MonitorHooks) => workerTick(defaultRuntime(pool, workerId), { hooks });

/** ChangeGuard, as people use it: propose (preflight), approve by another person, release. */
async function release(campaignExternalId: string, branchId: string, when: Date): Promise<ChangeRow> {
  const campaignId = Number((await one<{ id: string }>(pool, "select id from ad_campaigns where external_campaign_id = $1 and platform = 'google_ads'", [campaignExternalId])).id);
  const proposed = await createChange(pool, marketing, { kind: "campaign_mapping", payload: { campaignId, branchId }, reason: `Calls for ${campaignExternalId} arrive at ${branchId}` }, when);
  expect(proposed.status).toBe("ready_for_review");
  await decideChange(pool, approver, proposed.id, { decision: "approve", reason: "Lead evidence and brand agree; spend conserved", configHash: proposed.configHash, preflightHash: proposed.preflightHash! }, when);
  return releaseChange(pool, marketing, proposed.id, when);
}

const runsOf = async (changeId: number) =>
  (await pool.query("select id, trigger, slot_at, outcome, ran_by, exception_id, evidence, checks from change_monitor_runs where change_id = $1 order by id", [changeId])).rows;
const latestRun = async (changeId: number) => (await runsOf(changeId)).at(-1)!;
const mappingOf = async (campaignExternalId: string) =>
  one<{ branch_id: string | null; versions: number }>(
    pool,
    `select m.branch_id, (select count(*)::int from campaign_mapping_versions v where v.campaign_id = c.id) as versions
     from ad_campaigns c left join campaign_branch_map m on m.campaign_id = c.id where c.external_campaign_id = $1 and c.platform = 'google_ads'`,
    [campaignExternalId],
  );
const driftItems = async () => (await pool.query("select id, status, last_detected_at, evidence from exceptions where kind = 'mapping_drift' order by id")).rows;

beforeAll(() => {
  pool = testPool();
});
afterAll(async () => {
  await pool.end();
});

describe("one released mapping, checked on schedule by the worker", () => {
  let change: ChangeRow;
  let driftRunId: number;
  const calls = Array.from({ length: 8 }, (_, i) => call(`MON-${i}`, "B20", `+1602555${String(3000 + i)}`, new Date(`${day(2 + i)}T16:00:00Z`), "Google Ads", { campaign: "mon-B20" }));
  const revision = (c: RawRecord, extra: Record<string, unknown>): RawRecord => ({ entity: c.entity, payload: { ...(c.payload as object), ...extra } });

  beforeAll(async () => {
    await freshDb(pool);
    await ingest(pool, "ads", Array.from({ length: 10 }, (_, i) => spend("mon-B20", "B20 | Search | Monitor", "google_ads", i + 1, 80)), { now: at(-2) });
    expect((await deliverCalls(calls, at(-2))).status).toBe("succeeded");
    await runReconcile(pool, at(-1));
    await setClock(T0);
    change = await release("mon-B20", "B20", T0);
  }, 120_000);

  it("release: verified at release, first slot one day later, release evidence recorded", async () => {
    expect(change.status).toBe("verified");
    expect(change.verifiedAt).toBe(T0.toISOString());
    expect(change.lastVerifiedAt).toBe(T0.toISOString());
    expect(change.monitorDueAt).toBe(at(24).toISOString());
    expect(change.monitorUntil).toBe(at(14 * 24).toISOString());
    expect(change.verification!.releaseEvidence).toEqual({ leadEvidence: [{ branchId: "B20", leads: 8 }], verdict: "agrees", sources: ["calls"] });
    const view = (await monitorView(pool, change, T0))!;
    expect(view).toMatchObject({ state: "current", latest: null, lastVerifiedAt: T0.toISOString(), nextDueAt: at(24).toISOString(), runs: 0, reviewItem: null });
    // Nothing is due yet: the worker does nothing.
    await setClock(at(23));
    expect((await tick()).checks).toEqual([]);
  });

  it("slot 1 · a clean check: current; two workers on one slot record ONE conclusion", async () => {
    expect((await deliverCalls([call("MON-NEW-1", "B20", "+16025553100", at(19), "Google Ads", { campaign: "mon-B20" })], at(20))).status).toBe("succeeded");
    await setClock(at(24, 5));
    const [a, b] = await Promise.all([tick("worker-a"), tick("worker-b")]);
    const outcomes = [...a.checks, ...b.checks].filter((c) => c.changeId === change.id).map((c) => c.outcome).sort();
    expect(outcomes.filter((o) => o !== "skipped")).toEqual(["current"]);
    const runs = await runsOf(change.id);
    expect(runs).toHaveLength(1);
    expect(runs[0]).toMatchObject({ trigger: "scheduled", outcome: "current", exception_id: null });
    expect(new Date(runs[0].slot_at).toISOString()).toBe(at(24).toISOString());
    expect(runs[0].evidence.sinceRelease).toEqual({ newLeads: 1, revisions: 0, excluded: 0 });
    const now = (await getChange(pool, marketing, change.id)).change;
    expect(now).toMatchObject({ status: "verified", verifiedAt: T0.toISOString(), lastVerifiedAt: at(24, 5).toISOString(), monitorDueAt: at(48).toISOString() });
    expect((await monitorView(pool, now, at(24, 5)))!.state).toBe("current");
  });

  it("slot 2 · a benign revision (agent note only) raises no alert", async () => {
    expect((await deliverCalls([revision(calls[3], { agent_note: "Caller asked about ants" })], at(30))).status).toBe("succeeded");
    await setClock(at(48, 5));
    await tick();
    const run = await latestRun(change.id);
    expect(run.outcome).toBe("current");
    expect(run.evidence.sinceRelease).toEqual({ newLeads: 1, revisions: 1, excluded: 0 });
    expect(run.evidence.conflicting).toEqual([]);
    expect(await driftItems()).toEqual([]);
    expect((await getChange(pool, marketing, change.id)).change).toMatchObject({ status: "verified", lastVerifiedAt: at(48, 5).toISOString(), monitorDueAt: at(72).toISOString() });
  });

  it("slot 3 · a stale feed cannot certify the mapping; the last success is not refreshed", async () => {
    // No delivery since T0+30 h: 42 h before this check, past the 36 h freshness limit.
    await setClock(at(72, 5));
    await tick();
    const run = await latestRun(change.id);
    expect(run.outcome).toBe("insufficient_evidence");
    expect(run.evidence.reasons).toEqual(["FEED_STALE"]);
    expect(run.checks.find((c: { id: string }) => c.id === "feeds_current")).toMatchObject({ passed: false, status: "fail" });
    const now = (await getChange(pool, marketing, change.id)).change;
    expect(now).toMatchObject({ status: "verified", lastVerifiedAt: at(48, 5).toISOString(), monitorDueAt: at(96).toISOString() });
    expect((await monitorView(pool, now, at(72, 5)))!.state).toBe("insufficient_evidence");
    expect(await driftItems()).toEqual([]);
  });

  it("slot 4 · an unavailable feed (latest run failed) cannot certify it either", async () => {
    expect((await deliverCalls([], at(80), "HTTP 503 Service Unavailable from the call-tracking API")).status).toBe("failed");
    await setClock(at(96, 5));
    await tick();
    const run = await latestRun(change.id);
    expect(run.outcome).toBe("insufficient_evidence");
    expect(run.checks.find((c: { id: string }) => c.id === "feeds_current").detail).toContain("latest run failed");
    expect((await getChange(pool, marketing, change.id)).change.lastVerifiedAt).toBe(at(48, 5).toISOString());
  });

  it("an overdue slot is shown as overdue before any worker runs it", async () => {
    // The feed recovers with a conflicting revision: call MON-5's tracking number now belongs to B19.
    const moved = revision(calls[5], { branch_tag: "B19", agent_note: "Tracking number reassigned to Mesa" });
    expect((await deliverCalls([moved], at(100))).status).toBe("succeeded");
    // Duplicate delivery: the same revision again, in a later run.
    const dup = await deliverCalls([moved], at(110));
    expect(dup.stats).toMatchObject({ inserted: 0, duplicates: 1 });
    // Slot 5 was due at T0+120 h; at T0+126 h 5 m nobody has run it.
    const late = at(126, 5);
    await setClock(late);
    const now = (await getChange(pool, marketing, change.id)).change;
    expect(now.monitorDueAt).toBe(at(120).toISOString());
    expect((await monitorView(pool, now, late))!.state).toBe("overdue");
  });

  it("slot 5 · a conflicting source revision: confirmed drift, ONE review item, the mapping left untouched", async () => {
    const before = await mappingOf("mon-B20");
    // The revision itself moved the lead when it was ingested; the CHECK must move nothing more.
    await runReconcile(pool, at(126, 5));
    const figures = async () => new Map((await branchRows(pool, { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: null })).map((r) => [r.branchId, r]));
    const figuresBefore = await figures();
    const result = await tick();
    expect(result.checks.find((c) => c.changeId === change.id)).toMatchObject({ outcome: "drift", status: "recovery_required" });
    const run = await latestRun(change.id);
    driftRunId = Number(run.id);
    // A branch the approval never saw, and the coverage verdict fell from "agrees" (8 of 8) to "split" (8 of 9).
    expect(run.evidence.reasons).toEqual(["LEAD_OUTSIDE_APPROVED_EVIDENCE", "EVIDENCE_VERDICT_WORSENED"]);
    expect(run.evidence.atRelease.verdict).toBe("agrees");
    expect(run.evidence.now.verdict).toBe("split");
    expect(run.evidence.newBranches).toEqual(["B19"]);
    // The affected scope: the released branch, the branch the lead now lands at, the record and its prior version.
    expect(run.evidence.conflicting).toHaveLength(1);
    expect(run.evidence.conflicting[0]).toMatchObject({ source: "calls", sourceLeadId: "MON-5", branchId: "B19", previousBranchId: "B20" });
    const scope = (await one<{ scope: { branches: string[]; rawEventIds: number[]; spendAtStakeCents: number } }>(pool, "select scope from change_monitor_runs where id = $1", [driftRunId])).scope;
    expect(scope.branches).toEqual(["B19", "B20"]);
    expect(scope.rawEventIds).toHaveLength(2);
    expect(scope.spendAtStakeCents).toBe(80_000);
    // One review item, with its Action Center case.
    const items = await driftItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ status: "open", evidence: { changeId: change.id, runId: driftRunId, releasedBranch: "B20", conflictingLeads: 1 } });
    expect(run.exception_id).toBe(items[0].id);
    expect((await one<{ n: number }>(pool, "select count(*)::int as n from cases where exception_id = $1", [items[0].id])).n).toBe(1);
    // Nothing the check concluded touched the mapping, its versions, or a source record. On every
    // branch's scorecard the only field that moved is the released branch's open-item count: the
    // review item itself (spend, customers, CAC, collected and revenue at risk are unchanged).
    const figuresAfter = await figures();
    for (const [branchId, row] of figuresBefore) {
      const { openExceptions: was, ...rest } = row;
      const { openExceptions: now, ...restAfter } = figuresAfter.get(branchId)!;
      expect(restAfter, branchId).toEqual(rest);
      expect(now - was, branchId).toBe(branchId === "B20" ? 1 : 0);
    }
    expect(await mappingOf("mon-B20")).toEqual(before);
    expect(before).toEqual({ branch_id: "B20", versions: 2 });
    expect((await one<{ n: number; deliveries: number }>(pool, "select count(*)::int as n, max(delivery_count)::int as deliveries from raw_events where source = 'calls' and entity_id = 'MON-5'"))).toEqual({ n: 2, deliveries: 2 });
    // Recovery required; verified-at-release and the last success stay where they were.
    const now = (await getChange(pool, marketing, change.id)).change;
    expect(now).toMatchObject({ status: "recovery_required", verifiedAt: T0.toISOString(), lastVerifiedAt: at(48, 5).toISOString(), monitorDueAt: at(144).toISOString() });
    expect((await monitorView(pool, now, at(126, 5)))!).toMatchObject({ state: "confirmed_drift", reviewItem: { id: Number(items[0].id), status: "open" } });
    const events = (await getChange(pool, marketing, change.id)).events.map((e) => `${e.from}→${e.to}:${e.subject}`);
    expect(events.at(-1)).toBe("verified→recovery_required:system:monitor");
  });

  it("slot 6 · the same revision delivered again updates the SAME review item; the lead counts once", async () => {
    const moved = revision(calls[5], { branch_tag: "B19", agent_note: "Tracking number reassigned to Mesa" });
    expect((await deliverCalls([moved], at(130))).stats).toMatchObject({ inserted: 0, duplicates: 1 });
    const first = (await driftItems())[0];
    await setClock(at(144, 5));
    await tick();
    const run = await latestRun(change.id);
    expect(run.outcome).toBe("drift");
    expect(run.evidence.conflicting).toHaveLength(1);
    const items = await driftItems();
    expect(items).toHaveLength(1);
    expect(items[0].id).toBe(first.id);
    expect(new Date(items[0].last_detected_at).toISOString()).toBe(at(144, 5).toISOString());
    expect(items[0].evidence.runId).toBe(Number(run.id));
    expect(run.exception_id).toBe(first.id);
    expect((await one<{ n: number }>(pool, "select count(*)::int as n from cases where exception_id = $1", [first.id])).n).toBe(1);
    expect(await mappingOf("mon-B20")).toEqual({ branch_id: "B20", versions: 2 });
  });

  it("slot 7 · a check that errors concludes nothing, keeps its slot, and is retried", async () => {
    await setClock(at(168, 5));
    await pool.query("alter table ingestion_runs rename to ingestion_runs_offline");
    try {
      const result = await tick();
      expect(result.checks.find((c) => c.changeId === change.id)).toMatchObject({ outcome: "error" });
    } finally {
      await pool.query("alter table ingestion_runs_offline rename to ingestion_runs");
    }
    const errored = (await getChange(pool, marketing, change.id)).change;
    expect(errored).toMatchObject({ status: "recovery_required", lastVerifiedAt: at(48, 5).toISOString(), monitorDueAt: at(168).toISOString(), monitorRetryAt: at(169, 5).toISOString() });
    const view = (await monitorView(pool, errored, at(168, 5)))!;
    expect(view.latest!.outcome).toBe("error");
    expect(view.latestConclusion!.outcome).toBe("drift");
    // Not due again until the retry time.
    await setClock(at(168, 30));
    expect((await tick()).checks).toEqual([]);
    await setClock(at(169, 10));
    await tick();
    const runs = await runsOf(change.id);
    expect(runs.slice(-2).map((r) => r.outcome)).toEqual(["error", "drift"]);
    expect(new Date(runs.at(-1)!.slot_at).toISOString()).toBe(at(168).toISOString());
    expect((await getChange(pool, marketing, change.id)).change).toMatchObject({ monitorDueAt: at(192).toISOString(), monitorRetryAt: null });
  });

  it("the evidence is read-only and respects the viewer's scope", async () => {
    // Company-wide roles see everything, including B19.
    const full = await getMonitorRun(pool, marketing, change.id, driftRunId);
    expect(full.redacted.hidden).toEqual({ branches: 0, leads: 0, records: 0 });
    expect(full.redacted.run.evidence.conflicting).toHaveLength(1);
    expect((await getMonitorRun(pool, guest, change.id, driftRunId)).redacted.run.evidence.conflicting).toHaveLength(1);
    // The B20 partner reads the change (it touches only B20) but not B19's records or sentences.
    const scoped = await getMonitorRun(pool, partner, change.id, driftRunId);
    expect(scoped.redacted.hidden).toMatchObject({ branches: 1, leads: 1, records: 2 });
    expect(scoped.redacted.run.evidence.conflicting).toEqual([]);
    expect(scoped.redacted.run.scope.branches).toEqual(["B20"]);
    expect(scoped.redacted.run.evidence.newBranches).toEqual([]);
    expect(JSON.stringify(scoped.redacted.run.checks)).not.toContain("B19");
    expect(JSON.stringify(scoped.redacted.run.evidence.now)).not.toContain("B19");
    // Another brand's lead cannot read the change at all.
    await expect(getMonitorRun(pool, brand, change.id, driftRunId)).rejects.toBeInstanceOf(ForbiddenError);
    // A run id from another change is not found here.
    await expect(getMonitorRun(pool, marketing, change.id + 999, driftRunId)).rejects.toMatchObject({ status: 404 });
  });

  it("the decision summary: verdicts, what changed, what did not, one action per role, no remap implied", async () => {
    const now = at(169, 10);
    const current = (await getChange(pool, marketing, change.id)).change;
    const view = (await monitorView(pool, current, now))!;
    const forRole = (v: typeof marketing) => decisionSummary(pool, v, current, view);

    const m = await forRole(marketing);
    expect(m.release).toEqual({ verdict: "verified", at: T0.toISOString(), passed: 4, of: 4, approvedOn: "8 at B20 (agrees)" });
    expect(m.latest).toMatchObject({ state: "confirmed_drift", overdue: false });
    expect(m.changed).toEqual([
      "Call MON-5 was revised at the source: it now arrives at B19, a branch the approval did not see (it was B20).",
      'The campaign\'s leads now read "split" (8 of 9 at B20); at release they read "agrees".',
    ]);
    expect(m.unchanged[0]).toBe("The mapping is still B20 (version 2), as released.");
    expect(m.unchanged[1]).toMatch(/^No check edited spend, customers, credits or source records, and nothing was rolled back\. The checks recorded their results and one review item \(incident #\d+\)\.$/);
    expect(m.caution).toBe("One changed lead does not show the mapping is wrong: most of the campaign's leads (8 of 9) still arrive at B20, and a revision can be a correction at the source. Check the record first.");
    // The primary action opens the lead's own record, at its row.
    const leadRaw = Number((await one<{ raw_event_id: string }>(pool, "select raw_event_id from leads where source_lead_id = 'MON-5'")).raw_event_id);
    expect(m.next).toMatchObject({ label: "Review the changed lead", primary: true });
    expect(m.next.href).toMatch(new RegExp(`^/customers/(\\d+|P-\\d+)#raw-${leadRaw}$`));
    expect(JSON.stringify(m)).not.toMatch(/remap|compensating change is needed|should be remapped/i);

    // Read-only: the same record, as a plain link with no primary action.
    expect((await forRole(guest)).next).toMatchObject({ label: "Read the changed lead", primary: false, href: m.next.href });
    // An approver reviews too; the B20 partner sees the change but not the B19 lead.
    expect((await forRole(approver)).next).toMatchObject({ label: "Review the changed lead", primary: true });
    const p = await forRole(partner);
    expect(p.next).toMatchObject({ label: "Read the evidence", primary: false, href: `/changes/${change.id}/checks/${view.latestConclusion!.id}` });
    expect(p.changed).toContain("1 lead(s) now arrive at a branch outside your scope.");
    expect(p.changed).toContain('The campaign\'s leads now read "split" (8 of 9 at B20); at release they read "agrees".');
    expect(JSON.stringify(p)).not.toContain("B19");

    // A late next check is reported beside the drift, never as it.
    const late = (await monitorView(pool, current, at(199)))!;
    const lateSummary = await decisionSummary(pool, marketing, current, late);
    expect(lateSummary.latest).toMatchObject({ state: "confirmed_drift", overdue: true, dueAt: at(192).toISOString() });
    expect(lateSummary.next.label).toBe("Review the changed lead");
  });
});

describe("a controlled race: a newer release lands while a scheduled check runs", () => {
  let older: ChangeRow;
  let newer: ChangeRow;

  beforeAll(async () => {
    await freshDb(pool);
    await ingest(pool, "ads", Array.from({ length: 10 }, (_, i) => spend("race-1", "B21 | Search | Race", "google_ads", i + 1, 50)), { now: at(-2) });
    // Split evidence (6 and 6): either branch is a defensible mapping a person may approve.
    const calls = [
      ...Array.from({ length: 6 }, (_, i) => call(`RACE-21-${i}`, "B21", `+1480555${String(4000 + i)}`, new Date(`${day(2 + i)}T16:00:00Z`), "Google Ads", { campaign: "race-1" })),
      ...Array.from({ length: 6 }, (_, i) => call(`RACE-22-${i}`, "B22", `+1480555${String(5000 + i)}`, new Date(`${day(2 + i)}T17:00:00Z`), "Google Ads", { campaign: "race-1" })),
    ];
    expect((await deliverCalls(calls, at(-2))).status).toBe("succeeded");
    await runReconcile(pool, at(-1));
    await setClock(T0);
    older = await release("race-1", "B21", T0);
    expect(older.status).toBe("verified");
    // The newer change is approved now and released DURING older's first scheduled check.
    const campaignId = Number((older.payload as { campaignId: number }).campaignId);
    const proposed = await createChange(pool, marketing, { kind: "campaign_mapping", payload: { campaignId, branchId: "B22" }, reason: "B22 answers this campaign's calls from next week" }, at(1));
    newer = await decideChange(pool, approver, proposed.id, { decision: "approve", reason: "Split evidence; the B22 office takes over the campaign", configHash: proposed.configHash, preflightHash: proposed.preflightHash! }, at(1));
    expect(newer.status).toBe("approved");
    expect((await deliverCalls([], at(23))).status).toBe("succeeded");
  }, 120_000);

  it("the older change's check is judged again under the lock: REPLACED, not drift, and no stale 'current'", async () => {
    const when = at(24, 5);
    await setClock(when);
    let released: ChangeRow | null = null;
    const result = await tick("race-worker", {
      beforeRecord: async (changeId) => {
        if (changeId === older.id) released = await releaseChange(pool, marketing, newer.id, when);
      },
    });
    expect(released!.status).toBe("verified");
    expect(result.checks.find((c) => c.changeId === older.id)).toMatchObject({ outcome: "superseded", reevaluated: true, exceptionId: null });
    const o = (await getChange(pool, marketing, older.id)).change;
    // Nothing certified, nothing raised, scheduling stopped; the status it earned at release stands.
    expect(o).toMatchObject({ status: "verified", lastVerifiedAt: T0.toISOString(), monitorDueAt: null });
    expect((await monitorView(pool, o, when))!.state).toBe("replaced");
    expect((await latestRun(older.id)).checks[0].detail).toContain(`Replaced by change #${newer.id}`);
    expect(await driftItems()).toEqual([]);
    // The live mapping is the newer release's; the monitor wrote no version.
    expect(await mappingOf("race-1")).toEqual({ branch_id: "B22", versions: 3 });
    expect((await getChange(pool, marketing, newer.id)).change).toMatchObject({ status: "verified", monitorDueAt: at(48, 5).toISOString() });
  });

  it("the newer change is then monitored on its own schedule; a lead at the other approved branch contradicts nothing", async () => {
    // The newer release was approved on split evidence (6 at B21, 6 at B22). One more call at
    // B21 and two at B22: still split, no branch the approval did not see.
    const more = [
      call("RACE-21-NEW", "B21", "+14805554100", at(40), "Google Ads", { campaign: "race-1" }),
      call("RACE-22-NEW-1", "B22", "+14805555100", at(41), "Google Ads", { campaign: "race-1" }),
      call("RACE-22-NEW-2", "B22", "+14805555101", at(42), "Google Ads", { campaign: "race-1" }),
    ];
    expect((await deliverCalls(more, at(46))).status).toBe("succeeded");
    await setClock(at(48, 10));
    const result = await tick();
    expect(result.checks.map((c) => [c.changeId, c.outcome])).toEqual([[newer.id, "current"]]);
    const run = await latestRun(newer.id);
    expect(run.evidence.now).toEqual({ leadEvidence: [{ branchId: "B22", leads: 8 }, { branchId: "B21", leads: 7 }], verdict: "split" });
    expect(run.evidence.sinceRelease).toMatchObject({ newLeads: 3 });
    expect(run.evidence.conflicting).toEqual([]);
    expect((await one<{ scope: { branches: string[]; rawEventIds: number[] } }>(pool, "select scope from change_monitor_runs where id = $1", [run.id])).scope).toMatchObject({ branches: ["B22"], rawEventIds: [] });
  });

  it("summaries: a current change needs nothing; an overdue one is a missing check (engineer acts), not a drift", async () => {
    const n = (await getChange(pool, marketing, newer.id)).change;
    const current = await decisionSummary(pool, marketing, n, (await monitorView(pool, n, at(48, 10)))!);
    expect(current.latest.state).toBe("current");
    expect(current.next).toEqual({ label: "No action needed", href: null, primary: false, note: `Next check ${dateTime(at(72, 5).toISOString())}.` });
    expect(current.caution).toBeNull();

    // The worker stops: the slot due T0+72 h 5 m passes its 6 h grace.
    const overdueView = (await monitorView(pool, n, at(78, 6)))!;
    expect(overdueView.state).toBe("overdue");
    const engineerSummary = await decisionSummary(pool, VIEWERS.engineer, n, overdueView);
    expect(engineerSummary.latest).toMatchObject({ state: "overdue", overdue: true });
    expect(engineerSummary.next).toMatchObject({ label: "Check the worker", href: "/audit", primary: true });
    const analystSummary = await decisionSummary(pool, marketing, n, overdueView);
    expect(analystSummary.next).toMatchObject({ label: "Ask an integration engineer to check the worker", href: null, primary: false });
    expect(analystSummary.next.note).toContain("This is not a drift");
    // The older, replaced change points at the newer one.
    const o = (await getChange(pool, marketing, older.id)).change;
    expect((await decisionSummary(pool, marketing, o, (await monitorView(pool, o, at(48, 10)))!)).next).toMatchObject({ label: `Open change #${newer.id}`, href: `/changes/${newer.id}` });
  });
});

describe("an ambiguous campaign id (R-46 stays open): uncertainty and scope, no invented answer", () => {
  let change: ChangeRow;

  beforeAll(async () => {
    await freshDb(pool);
    await ingest(pool, "ads", Array.from({ length: 10 }, (_, i) => spend("amb-1", "B12 | Search | Shared id", "google_ads", i + 1, 40)), { now: at(-2) });
    const calls = Array.from({ length: 6 }, (_, i) => call(`AMB-${i}`, "B12", `+1520555${String(6000 + i)}`, new Date(`${day(2 + i)}T16:00:00Z`), "Google Ads", { campaign: "amb-1" }));
    expect((await deliverCalls(calls, at(-2))).status).toBe("succeeded");
    await runReconcile(pool, at(-1));
    await setClock(T0);
    change = await release("amb-1", "B12", T0);
  }, 120_000);

  it("a Meta campaign starts using the same id and a lead with it lands at B05: insufficient evidence, not drift", async () => {
    await ingest(pool, "ads", [spend("amb-1", "Meta | Lead form | Spring", "meta", 20, 30)], { now: at(10) });
    expect((await deliverCalls([call("AMB-X", "B05", "+15205556100", at(18), "Facebook", { campaign: "amb-1" })], at(20))).status).toBe("succeeded");
    await setClock(at(24, 5));
    await tick();
    const run = await latestRun(change.id);
    expect(run.outcome).toBe("insufficient_evidence");
    expect(run.evidence.reasons).toEqual(["CAMPAIGN_ID_AMBIGUOUS"]);
    expect(run.evidence.sharedId).toEqual([expect.objectContaining({ platform: "meta", branchId: null })]);
    const checks = Object.fromEntries(run.checks.map((c: { id: string; status: string }) => [c.id, c.status]));
    expect(checks).toMatchObject({ still_applied: "pass", campaign_id_unambiguous: "unknown", evidence_since_release: "unknown" });
    // Changed 2026-11-13 (R-46 in ChangeGuard): this expected "may be the other campaign's" and
    // scope branches ["B05", "B12"]. Both encoded the bare-id rule, which counted AMB-X as this
    // campaign's lead. Its record says "Facebook", so it is the Meta campaign's lead and is not
    // this campaign's evidence. The guard is unchanged: outcome, reason, check states and the
    // two campaigns in scope are as before, and nothing is certified.
    expect(run.checks.find((c: { id: string }) => c.id === "evidence_since_release").detail).toContain("Not judged while the id is shared. This campaign's own leads: 6 at B12");
    expect(run.evidence.now.leadEvidence).toEqual([{ branchId: "B12", leads: 6 }]);
    expect(run.evidence.conflicting).toEqual([]);
    const scope = (await one<{ scope: { branches: string[]; campaignIds: number[] } }>(pool, "select scope from change_monitor_runs where id = $1", [run.id])).scope;
    expect(scope.campaignIds).toHaveLength(2);
    expect(scope.branches).toEqual(["B12"]);
    // No review item, no status change, no refreshed success, the mapping as released.
    expect(await driftItems()).toEqual([]);
    expect((await getChange(pool, marketing, change.id)).change).toMatchObject({ status: "verified", lastVerifiedAt: T0.toISOString() });
    expect(await mappingOf("amb-1")).toEqual({ branch_id: "B12", versions: 2 });
  });
});

describe("the monitoring state rule", () => {
  const due = "2026-11-02T13:00:00.000Z";
  const base = { status: "verified" as const, monitorDueAt: due, lastVerifiedAt: "2026-11-01T13:05:00.000Z" };
  const run = (outcome: MonitorRun["outcome"]) => ({ outcome });
  it("orders replaced > drift > overdue > insufficient > current", () => {
    const onTime = new Date(Date.parse(due) + OVERDUE_AFTER_MS);
    const late = new Date(Date.parse(due) + OVERDUE_AFTER_MS + 1);
    expect(monitorState(base, run("current"), onTime)).toBe("current");
    expect(monitorState(base, run("current"), late)).toBe("overdue");
    expect(monitorState(base, run("insufficient_evidence"), onTime)).toBe("insufficient_evidence");
    expect(monitorState(base, run("insufficient_evidence"), late)).toBe("overdue");
    expect(monitorState({ ...base, status: "recovery_required" }, run("current"), late)).toBe("confirmed_drift");
    expect(monitorState(base, run("drift"), onTime)).toBe("confirmed_drift");
    expect(monitorState({ ...base, monitorDueAt: null }, run("superseded"), late)).toBe("replaced");
    // A release that did not fully verify, never checked since: nothing certifies it.
    expect(monitorState({ ...base, lastVerifiedAt: null }, null, onTime)).toBe("insufficient_evidence");
  });
});
