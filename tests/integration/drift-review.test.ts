import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { briefCopy } from "@/lib/changeguard/brief";
import { factsKey } from "@/lib/changeguard/facts";
import { runCheck } from "@/lib/changeguard/monitor";
import { StaleEvidenceError, driftCase, factsOfRun, recordDriftReview, type DriftCaseView } from "@/lib/changeguard/review";
import { createChange, decideChange, getChange, releaseChange, type ChangeRow } from "@/lib/changeguard/service";
import { decisionSummary } from "@/lib/changeguard/summary";
import { monitorView } from "@/lib/changeguard/monitor";
import { money } from "@/lib/format";
import { runStream } from "@/lib/ingest/ingest";
import { defaultRuntime } from "@/lib/jobs/runtime";
import { workerTick } from "@/lib/jobs/tick";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { getException } from "@/lib/queries";
import { branchesOfBrands } from "@/lib/reference";
import { InMemorySourceClient } from "@/lib/sim/clients";
import { ForbiddenError, VIEWERS, type Viewer } from "@/lib/viewer";
import { assignCaseOwner, closeCase } from "@/lib/workflow/proposals";
import { caseAudit } from "@/lib/workflow/queries";
import { call, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * The flagship drift review, on the real paths (docs/agent-work/DRIFT-REVIEW.md).
 *
 * A campaign mapping rv-B44 → B44 is released through ChangeGuard on 10 calls at B44. The worker
 * checks it on schedule (workerTick), records arrive through the polling ingestion path
 * (runStream), and the business clock moves:
 *
 *   slot 1   clean → current
 *   slot 2   call RV-0 revised to B39 → CONFIRMED DRIFT: one review item, its case detected
 *   review   needs investigation (owner required), then reviewed — no mapping change: case closed
 *   slot 3-7 the same evidence again — a duplicate delivery, an agent-note-only edit, two workers on
 *            one slot, a manual re-check, a failing feed, a check that errors — the case stays
 *            reviewed, nothing is reopened or created
 *   slot 8   call RV-1 revised to B41 (a second lead outside the approved branches) → the SAME case
 *            reopens once, even with two workers and a manual check racing; the review is kept
 *   slot 9   the same again → no second reopen
 *   stale    a reviewer saves against an older check while RV-2 → B42 landed → refused, nothing
 *            written; saving against the new check succeeds
 *   race     a review and a check bringing new evidence, at once → never closed over unseen facts
 *
 * Throughout: the mapping, its versions, spend, credits, source records and every earlier check's
 * result are unchanged by reviews and recurrence; only the case, its history and the exception's
 * status move.
 */

const route = vi.hoisted(() => ({ viewer: null as unknown, pool: null as unknown, now: new Date("2026-10-31T13:00:00Z") }));
vi.mock("@/lib/server", () => ({
  getViewer: async () => route.viewer,
  getPool: () => route.pool,
  businessNow: async () => route.now,
}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

const HOUR = 3_600_000;
const T0 = new Date("2026-10-31T13:00:00Z");
const at = (h: number, m = 0) => new Date(T0.getTime() + h * HOUR + m * 60_000);
const slot = (k: number) => at(24 * k, 5);
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const { marketing, engineer, approver, partner, guest, brand } = VIEWERS;
/** A reviewer who could decide but sees only the brand's branches (B40–B44): no demo role is this. */
const scopedReviewer: Viewer = { ...marketing, subject: "test:scoped-reviewer", label: "Scoped analyst", branchIds: branchesOfBrands(["joshuas"]), brandIds: ["joshuas"] };

let pool: Pool;
let change: ChangeRow;
let exceptionId: number;
let caseId: number;

const calls = Array.from({ length: 10 }, (_, i) => call(`RV-${i}`, "B44", `+1480555${String(4000 + i)}`, new Date(`${day(2 + i)}T16:00:00Z`), "Google Ads", { campaign: "rv-B44" }));
const revise = (c: RawRecord, extra: Record<string, unknown>): RawRecord => ({ entity: c.entity, payload: { ...(c.payload as object), ...extra } });

function spend(d: number): RawRecord {
  return {
    entity: "spend_day",
    payload: { platform: "google_ads", accountId: "ACC-rv-B44", campaignId: "rv-B44", campaignName: "B44 | Search | Review", date: day(d), costMicros: String(50 * 1_000_000), clicks: 5, conversions: 1, fetchedAt: `${day(d + 1)}T06:00:00Z`, campaignType: "SEARCH" },
  };
}

async function setClock(when: Date) {
  await pool.query("update app_clock set now = $1", [when]);
}

async function deliverCalls(records: RawRecord[], when: Date, fail: string | null = null) {
  const versions = records.map((r) => ({ stream: "calls", entity: r.entity, visibleAt: when.getTime() - 60_000, payload: r.payload as Record<string, unknown> }));
  const client = new InMemorySourceClient("calls", "calls", versions, () => fail);
  return runStream(pool, { client, mapper: mapperFor("calls"), ctx: referenceContext, now: when, windowEnd: when, overlapMs: 0, initialCursor: new Date(when.getTime() - 30 * 24 * HOUR) });
}

const tick = (workerId = "test-worker") => workerTick(defaultRuntime(pool, workerId), {});

/** The feed delivered recently (nothing new), then the clock reaches the slot. */
async function reachSlot(k: number) {
  expect((await deliverCalls([], at(24 * k - 1))).status).toBe("succeeded");
  await setClock(slot(k));
}

const kase = async () => one<{ id: string; state: string; owner: string | null; reopen_count: number }>(pool, "select id, state, owner, reopen_count from cases where id = $1", [caseId]);
const exceptionRow = async () => one<{ status: string; resolution: string | null }>(pool, "select status, resolution from exceptions where id = $1", [exceptionId]);
const transitions = async () =>
  (await pool.query<{ from_state: string | null; to_state: string; actor: string; detail: Record<string, unknown> }>("select from_state, to_state, actor, detail from case_events where case_id = $1 and event = 'transition' order by id", [caseId])).rows;
const count = async (sql: string, params: unknown[] = []) => Number((await one<{ n: string }>(pool, sql, params)).n);
const latestDrift = async () => one<{ id: string }>(pool, "select id from change_monitor_runs where exception_id = $1 and outcome = 'drift' order by id desc limit 1", [exceptionId]);
const viewAs = async (viewer: Viewer, sinceRunId: number | null = null): Promise<DriftCaseView> => driftCase(pool, viewer, (await getException(pool, exceptionId))!, { sinceRunId });

/** What a review or a recurrence must never change: mappings, spend, credits, source records, verification. */
async function businessState() {
  const md5 = (table: string, order: string) => one<{ h: string | null }>(pool, `select md5(string_agg(t::text, '|' order by ${order})) as h from ${table} t`).then((r) => r.h);
  return {
    mapping: await md5("campaign_branch_map", "campaign_id"),
    mappingVersions: await md5("campaign_mapping_versions", "campaign_id, version"),
    spend: await md5("ad_spend_daily", "t::text"),
    rawEvents: await md5("raw_events", "id"),
    leads: await md5("leads", "id"),
    overrides: await md5("overrides", "t::text"),
    credit: await md5("v_acquisitions", "t::text"),
    payments: await md5("crm_payments", "t::text"),
    verification: (await one<{ v: unknown }>(pool, "select jsonb_build_object('status', status, 'verifiedAt', verified_at, 'lastVerifiedAt', last_verified_at, 'checks', verification -> 'checks', 'release', verification -> 'releaseEvidence') as v from config_changes where id = $1", [change.id])).v,
  };
}
/** Every check recorded so far, exactly as stored. */
const runsSnapshot = async (upTo: number) => (await pool.query("select * from change_monitor_runs where id <= $1 order by id", [upTo])).rows;

async function review(viewer: Viewer, input: { disposition: "reviewed_no_change" | "needs_investigation"; rationale: string; owner?: "engineer" | "marketing" | "approver"; runId?: number }) {
  const runId = input.runId ?? Number((await latestDrift()).id);
  const run = (await pool.query("select * from change_monitor_runs where id = $1", [runId])).rows[0];
  return recordDriftReview(pool, viewer, { exceptionId, runId, evidenceKey: factsKey(factsOfRun({ evidence: run.evidence })), disposition: input.disposition, rationale: input.rationale, owner: input.owner ?? null, now: await one<{ now: Date }>(pool, "select now from app_clock").then((r) => r.now) });
}

beforeAll(async () => {
  pool = testPool();
  route.pool = pool;
  await freshDb(pool);
  await ingest(pool, "ads", Array.from({ length: 10 }, (_, i) => spend(i + 1)), { now: at(-2) });
  expect((await deliverCalls(calls, at(-2))).status).toBe("succeeded");
  await runReconcile(pool, at(-1));
  await setClock(T0);
  const campaignId = Number((await one<{ id: string }>(pool, "select id from ad_campaigns where external_campaign_id = 'rv-B44'")).id);
  const proposed = await createChange(pool, marketing, { kind: "campaign_mapping", payload: { campaignId, branchId: "B44" }, reason: "Calls for rv-B44 arrive at B44" }, T0);
  expect(proposed.status).toBe("ready_for_review");
  await decideChange(pool, approver, proposed.id, { decision: "approve", reason: "Lead evidence and brand agree; spend conserved", configHash: proposed.configHash, preflightHash: proposed.preflightHash! }, T0);
  change = await releaseChange(pool, marketing, proposed.id, T0);
  expect(change.status).toBe("verified");

  await reachSlot(1);
  expect((await tick()).checks.find((c) => c.changeId === change.id)?.outcome).toBe("current");
  // A revision of RV-0 at the source: its tracking number now belongs to B39 (another brand).
  expect((await deliverCalls([revise(calls[0], { branch_tag: "B39", agent_note: "Tracking number moved to the Sage office" })], at(30))).status).toBe("succeeded");
  await reachSlot(2);
  expect((await tick()).checks.find((c) => c.changeId === change.id)?.outcome).toBe("drift");
  const item = await one<{ id: string }>(pool, "select id from exceptions where kind = 'mapping_drift'");
  exceptionId = Number(item.id);
  caseId = Number((await one<{ id: string }>(pool, "select id from cases where exception_id = $1", [exceptionId])).id);
}, 180_000);

afterAll(async () => {
  await pool.end();
});

describe("the open case: a brief built from stored facts", () => {
  it("names the change, the proof and the next step; keeps finding, decision and outcome apart", async () => {
    const view = await viewAs(marketing);
    expect(view).toMatchObject({ state: "detected", reopenCount: 0, release: { atTarget: 10, total: 10 }, latest: { atTarget: 9, total: 10 }, hiddenLeads: 0, canDecide: true, readOnlyReason: null, decision: null, reopened: null });
    expect(view.change).toMatchObject({ campaign: "rv-B44", releasedBranch: "B44", liveBranch: "B44", liveVersion: 2, unchanged: true });
    expect(view.leads).toHaveLength(1);
    expect(view.leads[0]).toMatchObject({ noun: "Call", sourceLeadId: "RV-0", branchAtRelease: "B44", branchNow: "B39", isNew: false });
    // The two stored versions, field by field, the changed ones first.
    const changed = view.leads[0].fields.filter((f) => f.changed).map((f) => [f.field, f.before, f.after]);
    expect(changed).toContainEqual(["branch_tag", "B44", "B39"]);
    expect(view.leads[0].atRelease!.rawEventId).not.toBe(view.leads[0].latest.rawEventId);

    const brief = briefCopy(view);
    expect(brief.headline).toBe("One lead changed branches. The mapping stayed at B44.");
    expect(brief.detail).toContain("revised at the source to point to B39");
    expect(brief.finding).toMatch(/^Check #\d+ on Nov 2 confirmed a change in the evidence the release was approved on\. The check changed nothing\.$/);
    expect(brief.disposition).toBe("Open — no one has reviewed it yet.");
    expect(view.spendAtStakeCents).toBe(50_000);
    expect(brief.outcome).toBe(`No revenue impact was measured from this finding. ${money(50_000)} of the campaign's spend is at stake, not lost. One source revision does not show the mapping is wrong.`);
    // Ids and exact times stay out of the headline.
    expect(brief.headline).not.toMatch(/#|RV-|\d{1,2}:\d{2}/);
  });

  it("scope: the brand lead (B40–B44) reads the case with B39's lead counted, never named", async () => {
    const view = await viewAs(brand);
    expect(view.leads).toEqual([]);
    expect(view.hiddenLeads).toBe(1);
    expect(view.canDecide).toBe(false);
    const serialized = JSON.stringify(view);
    expect(serialized).not.toContain("B39");
    expect(serialized).not.toContain("RV-0");
    expect(briefCopy(view).headline).toBe("One lead now points outside the approved branches. The mapping stayed at B44.");
  });
});

describe("permission and scope on the write path", () => {
  it("refuses guests, roles that do not decide, a reviewer who cannot read all the evidence, and other branches", async () => {
    const before = await businessState();
    for (const viewer of [guest, approver, brand]) await expect(review(viewer, { disposition: "reviewed_no_change", rationale: "Looks like a source correction" })).rejects.toBeInstanceOf(ForbiddenError);
    // Can decide, but B39 (in the evidence) is outside their branches: they may not close it.
    await expect(review(scopedReviewer, { disposition: "reviewed_no_change", rationale: "Looks like a source correction" })).rejects.toThrow(/outside your scope/);
    // Another branch's partner cannot even see the case exists.
    await expect(review({ ...partner, can: { ...partner.can, decide: true } }, { disposition: "reviewed_no_change", rationale: "Looks like a source correction" })).rejects.toMatchObject({ status: 404 });
    expect(await count("select count(*) as n from case_reviews")).toBe(0);
    expect((await kase()).state).toBe("detected");
    expect(await businessState()).toEqual(before);
  });

  it("direct requests: 403 / 404 / 400 / 409 from the route, nothing written", async () => {
    const { POST } = await import("@/app/api/exceptions/[id]/review/route");
    const post = (id: number | string, body: unknown) => POST(new Request(`http://localhost/api/exceptions/${id}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }), { params: Promise.resolve({ id: String(id) }) });
    const run = await latestDrift();
    const runRow = (await pool.query("select evidence from change_monitor_runs where id = $1", [run.id])).rows[0];
    const body = { disposition: "reviewed_no_change", runId: Number(run.id), evidenceKey: factsKey(factsOfRun(runRow)), rationale: "Checked the call record; a source correction." };
    route.viewer = guest;
    expect((await post(exceptionId, body)).status).toBe(403);
    route.viewer = { ...partner, can: { ...partner.can, decide: true } };
    expect((await post(exceptionId, body)).status).toBe(404);
    route.viewer = marketing;
    expect((await post(exceptionId, { ...body, rationale: "short" })).status).toBe(400);
    expect((await post(exceptionId, { ...body, disposition: "needs_investigation" })).status).toBe(400); // no owner
    expect((await post(exceptionId, { ...body, evidenceKey: "0".repeat(64) })).status).toBe(409);
    expect((await post(exceptionId, { ...body, runId: 1 })).status).toBe(400); // check #1 found no drift
    expect((await post("abc", body)).status).toBe(404);
    expect(await count("select count(*) as n from case_reviews")).toBe(0);
  });

  it("the generic assign and close paths cannot skip the review", async () => {
    await expect(assignCaseOwner(pool, { caseId, owner: "engineer", actor: engineer })).rejects.toMatchObject({ status: 409 });
    await expect(closeCase(pool, { caseId, outcome: "closed_unresolvable", reason: "Nothing we can do from here", actor: marketing })).rejects.toMatchObject({ status: 409 });
    expect((await kase()).state).toBe("detected");
  });
});

describe("a person decides", () => {
  it("needs investigation: requires an accountable owner and what to check; the case stays open", async () => {
    await expect(review(engineer, { disposition: "needs_investigation", rationale: "Ask the call vendor about the number" })).rejects.toMatchObject({ status: 400 });
    await expect(review(engineer, { disposition: "needs_investigation", rationale: "short", owner: "engineer" })).rejects.toMatchObject({ status: 400 });
    const before = await businessState();
    await setClock(at(50));
    const saved = await review(engineer, { disposition: "needs_investigation", rationale: "Ask the call vendor whether the number moved to B39", owner: "engineer" });
    expect(saved.state).toBe("investigating");
    expect(await kase()).toMatchObject({ state: "investigating", owner: "engineer", reopen_count: 0 });
    expect((await exceptionRow()).status).toBe("open");
    const view = await viewAs(marketing);
    expect(briefCopy(view).disposition).toBe("Needs investigation — owned by Integration engineer since Nov 2.");
    expect(view.decision).toMatchObject({ disposition: "needs_investigation", owner: "engineer", ownerLabel: "Integration engineer", rationale: "Ask the call vendor whether the number moved to B39" });
    expect(await businessState()).toEqual(before);
  });

  it("reviewed — no mapping change: persisted with actor, time, disposition and the check reviewed; closes the same case", async () => {
    const before = await businessState();
    const runsBefore = await runsSnapshot(Number((await latestDrift()).id));
    await setClock(at(52));
    const run = await latestDrift();
    const saved = await review(marketing, { disposition: "reviewed_no_change", rationale: "The B39 number is a source correction; B44 still gets 9 of 10 calls." });
    expect(saved.state).toBe("closed_acknowledged");
    const row = await one<Record<string, unknown>>(pool, "select * from case_reviews where id = $1", [saved.review.id]);
    expect(row).toMatchObject({ case_id: String(caseId), exception_id: String(exceptionId), disposition: "reviewed_no_change", actor_subject: "demo:marketing", actor_role: "marketing", run_id: String(run.id), owner: null });
    expect(new Date(row.reviewed_at as Date).toISOString()).toBe(at(52).toISOString());
    expect(row.facts).toEqual(["lead|calls|RV-0|B39", "verdict|split"]);
    expect(await kase()).toMatchObject({ id: String(caseId), state: "closed_acknowledged", reopen_count: 0 });
    expect((await exceptionRow()).status).toBe("acknowledged");
    // The decision survives a fresh read (a reload), for anyone who can read the case.
    const view = await viewAs(marketing);
    expect(view.decision).toMatchObject({ disposition: "reviewed_no_change", actorRole: "marketing", actorLabel: "Marketing analyst", runId: Number(run.id), rationale: "The B39 number is a source correction; B44 still gets 9 of 10 calls." });
    expect(briefCopy(view)).toMatchObject({ state: "reviewed", status: { label: "Reviewed — no mapping change" }, disposition: "Reviewed — no mapping change, by Marketing analyst on Nov 2." });
    expect(view.canDecide).toBe(false);
    // The rationale names B39: withheld from the brand lead, whose scope excludes it.
    const scoped = await viewAs(brand);
    expect(scoped.decision).toMatchObject({ disposition: "reviewed_no_change", rationale: null });
    expect(JSON.stringify(scoped)).not.toContain("B39");
    // History: every transition explained, in order.
    expect((await transitions()).map((t) => `${t.from_state}→${t.to_state}`)).toEqual(["null→detected", "detected→investigating", "investigating→closed_acknowledged"]);
    expect(view.history.map((h) => h.title)).toEqual(["Case opened: a check confirmed a drift", "Needs investigation", "Reviewed — no mapping change"]);
    // Nothing else moved: not the mapping, spend, credits, source records, the change's verification, any check.
    expect(await businessState()).toEqual(before);
    expect(await runsSnapshot(Number(run.id))).toEqual(runsBefore);
    const { change: now } = await getChange(pool, marketing, change.id);
    expect(now).toMatchObject({ status: "recovery_required", verifiedAt: T0.toISOString(), lastVerifiedAt: slot(1).toISOString() });
    // The case's audit rows — which the AI tools return to anyone who can read the case — carry
    // no note and no branch beyond the released one (independent review finding #1).
    const auditRows = JSON.stringify(await caseAudit(pool, caseId, exceptionId));
    expect(auditRows).toContain("drift_review");
    expect(auditRows).not.toContain("source correction");
    expect(auditRows).not.toContain("B39");
    // ChangeGuard points to the review; it does not offer a second way to resolve it.
    const summary = await decisionSummary(pool, marketing, now, (await monitorView(pool, now, at(52)))!);
    expect(summary.next).toMatchObject({ label: "Read the review", href: `/exceptions/${exceptionId}`, primary: false });
    // A second save over the closed case is refused.
    await expect(review(engineer, { disposition: "reviewed_no_change", rationale: "Same conclusion, recorded twice" })).rejects.toMatchObject({ status: 409 });
  });
});

describe("the same evidence again leaves the reviewed case alone", () => {
  const unchangedCase = async () => {
    expect(await kase()).toMatchObject({ state: "closed_acknowledged", reopen_count: 0 });
    expect((await exceptionRow()).status).toBe("acknowledged");
    expect(await count("select count(*) as n from exceptions where kind = 'mapping_drift'")).toBe(1);
    expect(await count("select count(*) as n from cases c join exceptions e on e.id = c.exception_id where e.kind = 'mapping_drift'")).toBe(1);
    expect(await transitions()).toHaveLength(3);
  };

  it("a duplicate delivery of the revision, then an edit of a field the check does not judge", async () => {
    const before = await businessState();
    expect((await deliverCalls([revise(calls[0], { branch_tag: "B39", agent_note: "Tracking number moved to the Sage office" })], at(60))).status).toBe("succeeded");
    await reachSlot(3);
    expect((await tick()).checks.find((c) => c.changeId === change.id)?.outcome).toBe("drift");
    await unchangedCase();
    expect((await deliverCalls([revise(calls[0], { branch_tag: "B39", agent_note: "Sage office confirmed by phone" })], at(84))).status).toBe("succeeded");
    await reachSlot(4);
    expect((await tick()).checks.find((c) => c.changeId === change.id)?.outcome).toBe("drift");
    await unchangedCase();
    // The note edit is a new stored version of RV-0 (the check's raw event id moved) — and the same fact.
    const view = await viewAs(marketing);
    expect(view.checks.filter((c) => c.outcome === "drift" && c.versusReview === "same")).toHaveLength(2);
    // When it moved is the first B39 version, not the later note edit or re-delivery.
    expect(view.leads[0]).toMatchObject({ sourceLeadId: "RV-0", movedAt: at(30).toISOString() });
    expect(view.leads[0].latest.receivedAt).toBe(at(84).toISOString());
    const { rawEvents, leads, ...rest } = before;
    const { rawEvents: _r, leads: _l, ...restAfter } = await businessState();
    void [rawEvents, leads, _r, _l];
    expect(restAfter).toEqual(rest);
  });

  it("two workers on one slot and a manual re-check: new check ids, one conclusion per slot, no reopen", async () => {
    await reachSlot(5);
    const [a, b, manual] = await Promise.all([
      tick("worker-a"),
      tick("worker-b"),
      runCheck(pool, change.id, { trigger: "manual", slot: null, now: slot(5), ranBy: "engineer", actor: { subject: "demo:engineer", role: "engineer" } }),
    ]);
    const scheduled = [...a.checks, ...b.checks].filter((c) => c.changeId === change.id && c.outcome !== "skipped");
    expect(scheduled).toHaveLength(1);
    expect(manual.outcome).toBe("drift");
    await unchangedCase();
  });

  it("a failing feed and a check that errors are not new contradictions", async () => {
    // The feed's latest run failed: the stored contradiction still stands, the facts are the same.
    expect((await deliverCalls([], at(24 * 6 - 1), "HTTP 503 Service Unavailable")).status).toBe("failed");
    await setClock(slot(6));
    const result = (await tick()).checks.find((c) => c.changeId === change.id)!;
    expect(result.outcome).toBe("drift");
    const run = (await pool.query("select evidence from change_monitor_runs where id = $1", [result.runId])).rows[0];
    expect(run.evidence.reasons).toContain("FEED_STALE");
    await unchangedCase();
    // A check that cannot run concludes nothing and touches no case.
    await reachSlot(7);
    await pool.query("alter table ingestion_runs rename to ingestion_runs_offline");
    try {
      expect((await tick()).checks.find((c) => c.changeId === change.id)?.outcome).toBe("error");
    } finally {
      await pool.query("alter table ingestion_runs_offline rename to ingestion_runs");
    }
    await unchangedCase();
  });
});

describe("a materially new contradiction reopens the same case, once", () => {
  it("a second lead outside the approved branches: the SAME case reopens exactly once, with the check that found it, and the review kept", async () => {
    const before = await businessState();
    const reviewsBefore = (await pool.query("select * from case_reviews order by id")).rows;
    // RV-1 now belongs to B41 (Joshua's brand, so the brand lead may read this one).
    expect((await deliverCalls([revise(calls[1], { branch_tag: "B41", agent_note: "Tracking number moved to the Slate office" })], at(24 * 8 - 3))).status).toBe("succeeded");
    await reachSlot(8);
    // Two workers and a manual re-check at once.
    const [a, b, manual] = await Promise.all([
      tick("worker-a"),
      tick("worker-b"),
      runCheck(pool, change.id, { trigger: "manual", slot: null, now: slot(8), ranBy: "marketing", actor: { subject: "demo:marketing", role: "marketing" } }),
    ]);
    expect([...a.checks, ...b.checks, manual].filter((c) => c.changeId === change.id && c.outcome === "drift").length).toBe(2); // the slot once, the manual once
    expect(await kase()).toMatchObject({ id: String(caseId), state: "detected", reopen_count: 1 });
    expect((await exceptionRow()).status).toBe("open");
    expect(await count("select count(*) as n from exceptions where kind = 'mapping_drift'")).toBe(1);
    const reopen = (await transitions()).filter((t) => t.to_state === "detected" && t.from_state === "closed_acknowledged");
    expect(reopen).toHaveLength(1);
    expect(reopen[0]).toMatchObject({ actor: "monitor", detail: { trigger: "new_material_evidence", newFacts: 1, reviewId: Number(reviewsBefore.at(-1).id) } });
    // The case's history is branch-free: it is shown wherever B44 is in scope.
    expect(JSON.stringify(reopen[0].detail)).not.toMatch(/B39|B41/);
    // The earlier reviews are kept exactly as they were.
    expect((await pool.query("select * from case_reviews order by id")).rows).toEqual(reviewsBefore);

    const view = await viewAs(marketing);
    const brief = briefCopy(view);
    expect(brief.state).toBe("reopened");
    expect(brief.whatsNew).toBe("New since the last review: one more lead points outside the approved branches.");
    expect(brief.headline).toBe("Two leads changed branches. The mapping stayed at B44.");
    expect(view.reopened).toMatchObject({ newLeads: 1, hiddenNewLeads: 0, previous: { disposition: "reviewed_no_change", actorRole: "marketing" } });
    expect(view.leads.filter((l) => l.isNew).map((l) => [l.sourceLeadId, l.branchAtRelease, l.branchNow])).toEqual([["RV-1", "B44", "B41"]]);
    expect(view.leads[0].isNew).toBe(true); // new evidence first
    expect(view.history.at(-1)!.title).toBe("Reopened: new evidence");
    expect(view.canDecide).toBe(true);
    // The brand lead sees the new B41 lead, while B39's stays counted.
    const scoped = await viewAs(brand);
    expect(scoped.leads.map((l) => l.sourceLeadId)).toEqual(["RV-1"]);
    expect(scoped.hiddenLeads).toBe(1);
    expect(JSON.stringify(scoped)).not.toContain("B39");

    const { rawEvents, leads, ...rest } = before;
    const { rawEvents: _r, leads: _l, ...restAfter } = await businessState();
    void [rawEvents, leads, _r, _l];
    expect(restAfter).toEqual(rest);
  });

  it("the same new evidence on the next check: no second reopen", async () => {
    await reachSlot(9);
    expect((await tick()).checks.find((c) => c.changeId === change.id)?.outcome).toBe("drift");
    expect(await kase()).toMatchObject({ state: "detected", reopen_count: 1 });
    expect((await transitions()).filter((t) => t.to_state === "detected" && t.from_state === "closed_acknowledged")).toHaveLength(1);
  });
});

describe("a decision never closes over evidence its author did not see", () => {
  it("stale save: refused at the persistence boundary, nothing written; the newer check marks what is new", async () => {
    const readByReviewer = Number((await latestDrift()).id);
    // While the reviewer writes, RV-2 moves to B42 and the next check records it.
    expect((await deliverCalls([revise(calls[2], { branch_tag: "B42" })], at(24 * 10 - 3))).status).toBe("succeeded");
    await reachSlot(10);
    expect((await tick()).checks.find((c) => c.changeId === change.id)?.outcome).toBe("drift");
    const latest = Number((await latestDrift()).id);
    expect(latest).toBeGreaterThan(readByReviewer);
    const reviews = await count("select count(*) as n from case_reviews");
    const events = await count("select count(*) as n from case_events where case_id = $1", [caseId]);

    const refused = review(marketing, { disposition: "reviewed_no_change", rationale: "Both moves look like source corrections.", runId: readByReviewer });
    await expect(refused).rejects.toBeInstanceOf(StaleEvidenceError);
    await expect(refused).rejects.toMatchObject({ status: 409, conflict: { latestRunId: latest, reviewedRunId: readByReviewer, newFacts: 1 } });
    expect(await count("select count(*) as n from case_reviews")).toBe(reviews);
    expect(await count("select count(*) as n from case_events where case_id = $1", [caseId])).toBe(events);
    expect((await kase()).state).toBe("detected");
    // Through the route: the same 409, with what to read.
    const { POST } = await import("@/app/api/exceptions/[id]/review/route");
    route.viewer = marketing;
    const runRow = (await pool.query("select evidence from change_monitor_runs where id = $1", [readByReviewer])).rows[0];
    const res = await POST(
      new Request(`http://localhost/api/exceptions/${exceptionId}/review`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ disposition: "reviewed_no_change", runId: readByReviewer, evidenceKey: factsKey(factsOfRun(runRow)), rationale: "Both moves look like source corrections." }) }),
      { params: Promise.resolve({ id: String(exceptionId) }) },
    );
    expect(res.status).toBe(409);
    expect(await res.json()).toMatchObject({ conflict: { latestRunId: latest, reviewedRunId: readByReviewer, newFacts: 1 } });
    // The page, told which check the reviewer read, marks the one new lead.
    const view = await viewAs(marketing, readByReviewer);
    expect(view.sinceCheck).toMatchObject({ runId: readByReviewer, newLeads: 1 });
    expect(view.leads.filter((l) => l.isNew).map((l) => l.sourceLeadId).sort()).toEqual(["RV-1", "RV-2"]); // RV-1 since the review, RV-2 since the check

    // Saving against the newest check succeeds, and covers all three leads. On every branch's
    // scorecard the only field it moves is B44's open-incident count (reported apart from money and
    // mappings, R-50): spend, customers, CAC, collected and revenue at risk stay as they were.
    const figures = async () => new Map((await branchRows(pool, { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: null })).map((r) => [r.branchId, r]));
    const figuresBefore = await figures();
    const saved = await review(marketing, { disposition: "reviewed_no_change", rationale: "Three tracking numbers moved at the vendor; B44 still gets 7 of 10.", runId: latest });
    expect(saved.state).toBe("closed_acknowledged");
    expect(saved.review.facts).toEqual(["lead|calls|RV-0|B39", "lead|calls|RV-1|B41", "lead|calls|RV-2|B42", "verdict|split"]);
    const figuresAfter = await figures();
    for (const [branchId, row] of figuresBefore) {
      const { openExceptions: was, ...rest } = row;
      const { openExceptions: now, ...restAfter } = figuresAfter.get(branchId)!;
      expect(restAfter, branchId).toEqual(rest);
      expect(now - was, branchId).toBe(branchId === "B44" ? -1 : 0);
    }
  });

  it("a review racing a check that brings new evidence: whichever commits first, never closed over unseen facts", async () => {
    // RV-3 → B43 reopens the case (a second reopen of the same case).
    expect((await deliverCalls([revise(calls[3], { branch_tag: "B43" })], at(24 * 11 - 3))).status).toBe("succeeded");
    await reachSlot(11);
    expect((await tick()).checks.find((c) => c.changeId === change.id)?.outcome).toBe("drift");
    expect(await kase()).toMatchObject({ id: String(caseId), state: "detected", reopen_count: 2 });
    // The reviewer reads that check; meanwhile RV-4 → B40 arrives and the next slot's check runs
    // at the same moment as their save.
    const read = Number((await latestDrift()).id);
    expect((await deliverCalls([revise(calls[4], { branch_tag: "B40" })], at(24 * 12 - 3))).status).toBe("succeeded");
    await reachSlot(12);
    const [checked, saved] = await Promise.all([
      tick(),
      review(marketing, { disposition: "reviewed_no_change", rationale: "Four numbers moved at the vendor; reviewed together.", runId: read }).then(
        (r) => r,
        (e: Error) => e,
      ),
    ]);
    expect(checked.checks.find((c) => c.changeId === change.id)?.outcome).toBe("drift");
    const state = await kase();
    if (saved instanceof Error) {
      // The check committed first: the save was refused, nothing written.
      expect(saved).toBeInstanceOf(StaleEvidenceError);
      expect(state).toMatchObject({ state: "detected", reopen_count: 2 });
    } else {
      // The review committed first: the check then found RV-4, which that review had not seen.
      expect(state).toMatchObject({ state: "detected", reopen_count: 3 });
    }
    // Either way: the case is open, and RV-4 is waiting for a person.
    const latest = (await pool.query("select evidence from change_monitor_runs where id = $1", [(await latestDrift()).id])).rows[0];
    expect(factsOfRun(latest)).toContain("lead|calls|RV-4|B40");
    expect((await exceptionRow()).status).toBe("open");
  });
});

describe("a split release: what a scoped viewer may see, and what is not new evidence", () => {
  // Released to B44 on 6 calls at B44 and 6 at B43 (verdict "split"). A viewer scoped to B41 and
  // B44 (no demo role is this) can read the case: it is B44's.
  const scoped: Viewer = { ...guest, subject: "test:b41-b44", label: "Analyst · B41, B44", branchIds: ["B41", "B44"], brandIds: null };
  const sp = Array.from({ length: 12 }, (_, i) => call(`SP-${i}`, i < 6 ? "B44" : "B43", `+1480556${String(5000 + i)}`, new Date(`${day(2 + (i % 9))}T17:00:00Z`), "Google Ads", { campaign: "sp-B44" }));
  let c0: Date;
  let spChange: number;
  let spException: number;
  let spCase: number;
  const spSlot = (k: number) => new Date(c0.getTime() + 24 * k * HOUR + 5 * 60_000);
  const spReach = async (k: number) => {
    expect((await deliverCalls([], new Date(spSlot(k).getTime() - HOUR))).status).toBe("succeeded");
    await setClock(spSlot(k));
    return (await tick()).checks.find((c) => c.changeId === spChange);
  };
  const spCaseRow = async () => one<{ state: string; reopen_count: number }>(pool, "select state, reopen_count from cases where id = $1", [spCase]);
  const spView = async (viewer: Viewer) => driftCase(pool, viewer, (await getException(pool, spException))!);
  const spReview = async (rationale: string) => {
    const run = (await pool.query("select id, evidence from change_monitor_runs where exception_id = $1 and outcome = 'drift' order by id desc limit 1", [spException])).rows[0];
    return recordDriftReview(pool, marketing, { exceptionId: spException, runId: Number(run.id), evidenceKey: factsKey(factsOfRun(run)), disposition: "reviewed_no_change", rationale, now: await getNowFrom() });
  };
  const getNowFrom = async () => (await one<{ now: Date }>(pool, "select now from app_clock")).now;

  beforeAll(async () => {
    c0 = new Date((await getNowFrom()).getTime() + HOUR);
    const before = new Date(c0.getTime() - 2 * HOUR);
    await ingest(pool, "ads", Array.from({ length: 10 }, (_, i) => ({ entity: "spend_day", payload: { ...(spend(i + 1).payload as object), accountId: "ACC-sp-B44", campaignId: "sp-B44", campaignName: "B44 | Search | Split" } })), { now: before });
    expect((await deliverCalls(sp, before)).status).toBe("succeeded");
    await runReconcile(pool, new Date(c0.getTime() - HOUR));
    await setClock(c0);
    const campaignId = Number((await one<{ id: string }>(pool, "select id from ad_campaigns where external_campaign_id = 'sp-B44'")).id);
    const proposed = await createChange(pool, marketing, { kind: "campaign_mapping", payload: { campaignId, branchId: "B44" }, reason: "Split calls, B44 the larger office" }, c0);
    await decideChange(pool, approver, proposed.id, { decision: "approve", reason: "Split evidence seen and accepted", configHash: proposed.configHash, preflightHash: proposed.preflightHash! }, c0);
    const released = await releaseChange(pool, marketing, proposed.id, c0);
    spChange = released.id;
    expect(released.verification!.releaseEvidence!.verdict).toBe("split");
    expect((await spReach(1))?.outcome).toBe("current");
    // A B43 call is revised to B41, a branch the approval never saw.
    expect((await deliverCalls([revise(sp[6], { branch_tag: "B41" })], new Date(c0.getTime() + 30 * HOUR))).status).toBe("succeeded");
    expect((await spReach(2))?.outcome).toBe("drift");
    spException = Number((await one<{ id: string }>(pool, "select id from exceptions where fingerprint = $1", [`mapping_drift:change:${spChange}`])).id);
    spCase = Number((await one<{ id: string }>(pool, "select id from cases where exception_id = $1", [spException])).id);
  }, 180_000);

  it("the version at release is withheld from a viewer who cannot see its branch, and so is a note about it (finding #3)", async () => {
    const view = await spView(scoped);
    expect(view.leads.map((l) => [l.sourceLeadId, l.branchNow, l.branchAtRelease, l.atReleaseWithheld])).toEqual([["SP-6", "B41", null, true]]);
    expect(view.leads[0].atRelease).toBeNull();
    expect(view.leads[0].fields.every((f) => !f.changed)).toBe(true);
    expect(JSON.stringify(view)).not.toContain("B43");
    // A company-wide reviewer sees both versions, B43 → B41.
    expect((await spView(marketing)).leads[0]).toMatchObject({ branchAtRelease: "B43", atReleaseWithheld: false });
    await spReview("The B43 tracking number moved to B41; the B44 mapping stands.");
    const after = await spView(scoped);
    expect(after.decision).toMatchObject({ disposition: "reviewed_no_change", rationale: null });
    expect(JSON.stringify(after)).not.toContain("B43");
    expect((await spView(marketing)).decision!.rationale).toContain("B43");
  });

  it("a worse verdict reopens; a re-delivered or edited lead at an approved branch does not (finding #2)", async () => {
    // Two B44 calls move to B43 (approved): 4 of 12 at B44 — the verdict falls from split to disagrees.
    expect((await deliverCalls([revise(sp[0], { branch_tag: "B43" }), revise(sp[1], { branch_tag: "B43" })], new Date(c0.getTime() + 54 * HOUR))).status).toBe("succeeded");
    expect((await spReach(3))?.outcome).toBe("drift");
    expect(await spCaseRow()).toMatchObject({ state: "detected", reopen_count: 1 });
    await spReview("Two numbers moved within the split; reviewed with the vendor.");
    expect(await spCaseRow()).toMatchObject({ state: "closed_acknowledged", reopen_count: 1 });
    // A duplicate delivery of one moved call, and a note-only edit of a pre-release B43 call: the
    // check lists them (delivered after the release, verdict worsened) — and they are not new facts.
    expect((await deliverCalls([revise(sp[0], { branch_tag: "B43" }), revise(sp[7], { agent_note: "Called back about termites" })], new Date(c0.getTime() + 78 * HOUR))).status).toBe("succeeded");
    expect((await spReach(4))?.outcome).toBe("drift");
    const run = (await pool.query("select evidence from change_monitor_runs where exception_id = $1 and outcome = 'drift' order by id desc limit 1", [spException])).rows[0];
    expect(run.evidence.conflicting.map((c: { sourceLeadId: string }) => c.sourceLeadId)).toContain("SP-7");
    expect(factsOfRun(run)).toEqual(["lead|calls|SP-6|B41", "verdict|disagrees"]);
    expect(await spCaseRow()).toMatchObject({ state: "closed_acknowledged", reopen_count: 1 });
    // The page lists only the contradiction outside the approved branches.
    expect((await spView(marketing)).leads.map((l) => l.sourceLeadId)).toEqual(["SP-6"]);
  });
});
