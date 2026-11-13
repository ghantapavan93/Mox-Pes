import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { ACTIVE_VERSION } from "@/lib/adapters/registry";
import { NewChangeSchema } from "@/lib/changeguard/model";
import { createChange } from "@/lib/changeguard/service";
import { createPool } from "@/lib/db";
import { evaluateGates, takeSnapshot, attributionChanges } from "@/lib/twin/gates";
import { referenceState } from "@/lib/twin/oracle";
import { superviseEvaluation } from "@/lib/twin/runner";
import { STAGES } from "@/lib/twin/scenario";
import { createEvaluation, getEvaluation, type EvaluationRow } from "@/lib/twin/store";
import { databaseName, databaseUrl, dropWorld } from "@/lib/twin/world";
import { PERIODS } from "@/lib/period";
import { VIEWERS } from "@/lib/viewer";
import { TEST_DATABASE_URL, freshDb, one, testPool } from "../helpers";

/**
 * Reliability Twin acceptance: the calls@1.1 → calls@1.2 rollout over 1 → 5 → 44 branches, run
 * end to end by the production runner against isolated twin databases (one per evaluation,
 * cloned from the base world), with this test database as the control plane.
 *
 * The first run on a machine builds the base world (about a minute); later runs clone it.
 */
const control: Pool = testPool();
const twins: string[] = [];
let changeId = 0;

beforeAll(async () => {
  await freshDb(control);
  const change = await createChange(control, VIEWERS.marketing, NewChangeSchema.parse({
    kind: "source_contract",
    reason: "Roll out calls@1.2: outbound, spam and not-a-lead calls are excluded",
    payload: { source: "calls", entity: "call", samples: [{ id: "S-1", branch_tag: "B12", start_time: "2026-10-20T15:00:00Z", tracking_phone_number: "+18885550100", source: "Google Ads", gclid: null, campaign: null, agent_note: null, customer_phone_number: "+14805551000", spam: true }] },
  }));
  changeId = change.id;
}, 120_000);

afterAll(async () => {
  for (const t of twins) await dropWorld(TEST_DATABASE_URL, t).catch(() => undefined);
  await control.end();
});

async function evaluate(variant: string): Promise<EvaluationRow> {
  const id = await createEvaluation(control, VIEWERS.engineer, { changeId, variant, controlDatabase: databaseName(TEST_DATABASE_URL), now: new Date() });
  const ev = await superviseEvaluation(TEST_DATABASE_URL, id, { mainUrl: TEST_DATABASE_URL, interruptions: true });
  twins.push(ev.twinDatabase);
  return ev;
}

const gate = (ev: EvaluationRow, stage: string, id: string) => ev.stages.find((s) => s.key === stage)!.gates.find((g) => g.id === id)!;

describe("Reliability Twin · calls@1.2 rollout, standard", () => {
  let ev: EvaluationRow;
  beforeAll(async () => {
    ev = await evaluate("standard");
  }, 900_000);

  it("runs 1 → 5 → 44 branches, each stage only after the one before passed, every gate passing", () => {
    expect(ev.status).toBe("PASSED");
    expect(ev.stages.map((s) => [s.key, s.branchIds.length, s.status])).toEqual([["A", 1, "PASSED"], ["B", 5, "PASSED"], ["C", 44, "PASSED"]]);
    for (const s of ev.stages) {
      expect(s.gates.map((g) => g.id)).toEqual(["A", "B", "C", "D", "E", "F", "G", "H", "I", "J", "F1", "F2"]);
      expect(s.gates.filter((g) => g.status === "fail")).toEqual([]);
      expect(Date.parse(s.startedAt!)).toBeLessThanOrEqual(Date.parse(s.completedAt!));
    }
    expect(Date.parse(ev.stages[0].completedAt!)).toBeLessThanOrEqual(Date.parse(ev.stages[1].startedAt!));
    expect(Date.parse(ev.stages[1].completedAt!)).toBeLessThanOrEqual(Date.parse(ev.stages[2].startedAt!));
    expect(ev.scenarioHash).toMatch(/^[0-9a-f]{64}$/);
    expect(ev.sourceHash).toMatch(/^\d+:[0-9a-f]{32}$/);
  });

  it("the change has an effect, and it is the reference's: credits move, and every one is explained", () => {
    for (const s of ev.stages) {
      const a = s.evidence.attribution as { changed: number; paidToUnpaid: number; outsideStage: number };
      expect(a.changed).toBeGreaterThan(0);
      expect(a.outsideStage).toBe(0);
    }
    expect(gate(ev, "A", "I").detail).toMatch(/All 43 branches outside the stage/);
    expect(gate(ev, "B", "I").detail).toMatch(/All 39 branches outside the stage/);
  });

  it("both fault families hit every stage and were recovered: source errors in the backfill, a process lost after a commit", () => {
    for (const s of ev.stages) {
      const bf = s.steps.backfill.result as { calls: { byStatus: Record<string, number> }; retriesScheduled: number; jobs: Array<{ state: string }> };
      expect(Object.keys(bf.calls.byStatus).some((k) => k !== "200")).toBe(true);
      expect(bf.retriesScheduled).toBeGreaterThan(0);
      expect(gate(ev, s.key, "F2").status).toBe("pass");
    }
    // A: the runner was lost after the re-projection committed; the resumed one found the replay keys.
    expect(ev.stages[0].recovery).toMatchObject({ kind: "resumed" });
    expect(gate(ev, "A", "F2").detail).toMatch(/idempotency key was found/);
    // B: a sync worker died after a committed batch; another resumed the job after its last id.
    const death = (ev.stages[1].steps.backfill.result as { workerDeath: { requeued: boolean; committedBatches: number } }).workerDeath;
    expect(death).toMatchObject({ requeued: true });
    expect(death.committedBatches).toBeGreaterThan(0);
    // C: the runner was lost after delivering; the re-delivery was absorbed as duplicates.
    expect(ev.stages[2].recovery).toMatchObject({ kind: "resumed" });
    expect(gate(ev, "C", "C").status).toBe("pass");
    // Retry exhaustion: a job used up its five attempts and the runbook retry finished it.
    const c = ev.stages[2].steps.backfill.result as { runbookRetries: number[]; jobs: Array<{ state: string; attempts: number }> };
    expect(c.runbookRetries.length).toBe(1);
    expect(c.jobs.filter((j) => j.state === "failed" && j.attempts === 5)).toHaveLength(1);
  });

  it("the persisted twin is consistent after recovery, and nothing outside the twin moved", async () => {
    const twin = createPool(databaseUrl(TEST_DATABASE_URL, ev.twinDatabase));
    try {
      expect(await one(twin, "select count(*)::int as n from sync_jobs where state in ('running', 'queued')")).toEqual({ n: 0 });
      expect(await one(twin, "select count(*)::int as n from (select lead_id from v_acquisitions where lead_id is not null group by 1 having count(*) > 1) d")).toEqual({ n: 0 });
      expect(await one(twin, "select count(*)::int as n from (select source, external_id from raw_events group by 1, 2 having count(*) > 1) d")).toEqual({ n: 0 });
      // Every counted call record is now read by calls@1.2; only held (quarantined) ones keep their old stamp.
      expect(await one(twin, "select count(*)::int as n from raw_events where source = 'calls' and status <> 'quarantined' and adapter_version <> 'calls@1.2'")).toEqual({ n: 0 });
      // The replays the runner ran once each, under their keys.
      expect(await one(twin, "select count(*)::int as n from replays where idempotency_key like $1", [`twin:${ev.id}:%`])).toEqual({ n: 6 });
    } finally {
      await twin.end();
    }
    // The control plane holds the evaluation; its own business tables are untouched, and the
    // product still selects calls@1.2 for every branch at once.
    expect(await one(control, "select count(*)::int as n from leads")).toEqual({ n: 0 });
    expect(await one(control, "select count(*)::int as n from raw_events")).toEqual({ n: 0 });
    expect(ACTIVE_VERSION.calls).toBe("1.2");
    expect(await one(control, "select count(*)::int as n from audit_log where action = 'rollout_evaluation.finished' and subject = $1", [`change:${changeId}`])).toEqual({ n: 1 });
  });

  it("the gates are not vacuous: a wrong lead, a moved dollar and a moved branch each fail theirs", async () => {
    const twin = createPool(databaseUrl(TEST_DATABASE_URL, ev.twinDatabase));
    try {
      const stage = STAGES[2];
      const all = stage.branchIds;
      const oracle = await referenceState(twin, { onNewVersion: all, period: PERIODS.all });
      const before = await takeSnapshot(twin);
      // Count one spam call again, and move one cent of September spend of a branch outside stage A.
      await twin.query("update leads set excluded_code = null where id = (select min(id) from leads where excluded_code = 'SPAM_CALL')");
      await twin.query(
        `update ad_spend_daily set cost_cents = cost_cents + 1 where (campaign_id, spend_date) = (
           select s.campaign_id, s.spend_date from ad_spend_daily s join campaign_branch_map m on m.campaign_id = s.campaign_id
           join channels ch on ch.code = s.channel_code and ch.cost_basis = 'media'
           where m.branch_id <> 'B12' and s.spend_date >= '2026-09-01' order by 1, 2 limit 1)`,
      );
      const after = await takeSnapshot(twin);
      const gates = await evaluateGates({ twin, stage: STAGES[0], before, after, oracle, attribution: attributionChanges(oracle, oracle, STAGES[0]), deliver: null, backfill: null, resumed: null });
      const byId = Object.fromEntries(gates.map((g) => [g.id, g]));
      expect(byId.B.status).toBe("fail"); // a call the reference excludes is counted
      expect(byId.E.status).toBe("fail"); // one cent of spend moved
      expect(byId.I.status).toBe("fail"); // a branch outside the stage moved
      // Fail-closed: a gate whose evidence is missing fails; it is never passed by default.
      expect([byId.C.status, byId.F1.status]).toEqual(["fail", "fail"]);
      expect(byId.C.detail).toMatch(/did not run/);
    } finally {
      await twin.end();
    }
  }, 120_000);
});

describe("Reliability Twin · a failed gate stops the rollout", () => {
  it("cross-brand credit: stage B fails I, is rolled back and verified, and stage C never runs", async () => {
    const ev = await evaluate("scope_leak");
    expect(ev.status).toBe("FAILED");
    expect(ev.stages.map((s) => s.status)).toEqual(["PASSED", "RECOVERED", "BLOCKED"]);
    const b = ev.stages[1];
    expect(b.violated).toEqual(["I"]);
    expect(gate(ev, "B", "I").detail).toMatch(/B43 \(brand joshuas/);
    expect(b.recovery).toMatchObject({ kind: "rollback", restoredBusinessState: { verified: true }, preservedAuditHistory: { verified: true } });
    const c = ev.stages[2];
    expect({ started: c.startedAt, steps: c.steps, gates: c.gates }).toEqual({ started: null, steps: {}, gates: [] });
    const twin = createPool(databaseUrl(TEST_DATABASE_URL, ev.twinDatabase));
    try {
      // Rolled back: every record in effect for stage B's new branches is read by calls@1.1 again;
      // stage A's branch keeps calls@1.2. The one record calls@1.2 could not read (B05's revision
      // without a caller) never took effect: it stays held for replay, as stored.
      expect(await one(twin, "select count(*)::int as n from raw_events where source = 'calls' and status <> 'quarantined' and adapter_version = 'calls@1.2' and payload_branch(payload) = any($1::text[])", [STAGES[1].newBranchIds])).toEqual({ n: 0 });
      expect(await one(twin, "select count(*)::int as n, min(payload_branch(payload)) as branch, min(error_code) as code from raw_events where source = 'calls' and status = 'quarantined' and adapter_version = 'calls@1.2'")).toEqual({ n: 1, branch: "B05", code: "SCHEMA_VIOLATION" });
      expect(b.recovery).toMatchObject({ restoredBusinessState: { recordsStillOnNewVersion: 0, heldUnreadable: 1 } });
      expect((await one<{ n: number }>(twin, "select count(*)::int as n from raw_events where source = 'calls' and adapter_version = 'calls@1.2' and payload_branch(payload) = 'B12'")).n).toBeGreaterThan(0);
    } finally {
      await twin.end();
    }
  }, 900_000);

  it("CRM outage: stage B's backfill cannot complete, F1 fails, the stage is rolled back, stage C never runs", async () => {
    const ev = await evaluate("source_outage");
    expect(ev.status).toBe("FAILED");
    expect(ev.stages.map((s) => s.status)).toEqual(["PASSED", "RECOVERED", "BLOCKED"]);
    expect(ev.stages[1].violated).toContain("F1");
    expect(gate(ev, "B", "F1").detail).toMatch(/Unfinished: job \d+ \(office 128 subscription: failed/);
    expect(ev.stages[2].startedAt).toBeNull();
  }, 900_000);
});

describe("Reliability Twin · who may run it", () => {
  it("refuses a scoped viewer, a viewer who cannot propose, a second concurrent run and another change kind", async () => {
    await expect(createEvaluation(control, VIEWERS.partner, { changeId, variant: "standard", controlDatabase: "t", now: new Date() })).rejects.toThrow(/cannot start/);
    await expect(createEvaluation(control, VIEWERS.brand, { changeId, variant: "standard", controlDatabase: "t", now: new Date() })).rejects.toThrow(/cannot start/);
    await expect(createEvaluation(control, VIEWERS.approver, { changeId, variant: "standard", controlDatabase: "t", now: new Date() })).rejects.toThrow(/cannot start/);
    await expect(createEvaluation(control, VIEWERS.engineer, { changeId, variant: "everything", controlDatabase: "t", now: new Date() })).rejects.toThrow(/Unknown variant/);
    const first = await createEvaluation(control, VIEWERS.engineer, { changeId, variant: "standard", controlDatabase: "t", now: new Date() });
    await expect(createEvaluation(control, VIEWERS.marketing, { changeId, variant: "standard", controlDatabase: "t", now: new Date() })).rejects.toThrow(/already running/);
    await control.query("update rollout_evaluations set status = 'ERROR', error = 'test: not run', finished_at = now() where id = $1", [first]);
    expect((await getEvaluation(control, first))!.stages.every((s) => s.status === "PENDING")).toBe(true);
    const mapping = await createChange(control, VIEWERS.marketing, NewChangeSchema.parse({ kind: "campaign_mapping", payload: { campaignId: 999_999, branchId: "B01" }, reason: "A mapping change is not a source contract" }));
    await expect(createEvaluation(control, VIEWERS.engineer, { changeId: mapping.id, variant: "standard", controlDatabase: "t", now: new Date() })).rejects.toThrow(/is not one/);
  });
});
