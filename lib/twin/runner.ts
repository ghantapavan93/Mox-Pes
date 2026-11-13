import { hostname } from "node:os";
import type { Pool } from "pg";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { createPool, withTransaction } from "@/lib/db";
import { ingestRecords } from "@/lib/ingest/ingest";
import { replay, type ReplayResult } from "@/lib/ingest/replay";
import { PERIODS } from "@/lib/period";
import { reconcile } from "@/lib/reconcile/reconcile";
import { BRANCH_BY_ID } from "@/lib/reference";
import { generateWorld, type SourceRecordVersion } from "@/lib/sim/world";
import { runBackfill, type BackfillReport } from "./connector";
import { attributionChanges, businessDigest, differences, evaluateGates, takeSnapshot, type DeliverReport, type Gate, type Snapshot } from "./gates";
import { referenceState } from "./oracle";
import { BASELINE_VERSION, FROM_VERSIONS, PHASE_NOW, STAGES, STEPS, TO_VERSION, buildOverlay, faultPlan, scenarioHash, type Overlay, type StageKey, type StagePlan, type StepName } from "./scenario";
import { getEvaluation, type EvaluationRow, type StageRow } from "./store";
import { STALE_AFTER_MS } from "./store";
import { assertTwinDatabase, cloneWorld, codeFingerprint, databaseUrl, dropWorld, ensureBase, listWorlds } from "./world";

/**
 * The rollout runner. It drives one evaluation through its stages in the twin database and
 * records every step in the control plane (lib/twin/store.ts). It is restartable: everything it
 * needs is durable, either in the twin (the production paths' own idempotency: replay keys, raw
 * event identity, sync requests and checkpoints) or in the control plane (acknowledged steps,
 * the snapshot taken before each stage, the generated inputs kept in the twin).
 *
 * Fail-closed: a stage starts only after the one before it PASSED. A failed gate stops the
 * rollout; the failed stage is rolled back (its branches re-projected with the old mapper) and
 * the rollback is verified against the reference; every later stage is BLOCKED and never runs.
 * Nothing is promoted automatically after a failed gate: a new evaluation is a new decision.
 *
 * What it never does: select a mapper for real traffic, write to the application's data, or call
 * an external system. The twin's per-branch mapper routing exists only in this file.
 */

/** The runner's process was lost after a step committed and before it was acknowledged. */
export class Interrupted extends Error {}
/** Another runner holds this evaluation, or it was abandoned: this runner stops and writes nothing more. */
export class LeaseLost extends Error {}

/** One run of a runner may take this long; past it the evaluation ends in ERROR instead of hanging. */
const MAX_RUN_MS = 45 * 60_000;

export interface RunOptions {
  /** The application database's URL: the twin's server, and its admin connection. */
  mainUrl: string;
  log?: (line: string) => void;
  /** Act on the scenario's planned interruptions of the runner (a supervisor restarts it). */
  interruptions?: boolean;
  /** The lease holder's name. A supervisor restarting a lost runner reuses it; another process has its own. */
  runnerId?: string;
}

/** Fences every control-plane write: the lease is still this runner's, and the run is within its time. */
type Fence = (progress?: boolean) => Promise<void>;

interface WorldAck {
  baseBuilt: boolean;
  baseBuildMs: number;
  cloneMs: number;
  preRollout: { records: number; inserted: number; projected: number };
  inputs: number;
  newCrmRecords: number;
  at: string;
}

const MINUTE = 60_000;
const officeOf = (branchId: string) => BRANCH_BY_ID.get(branchId)!.crmOfficeId;

async function deliverRouted(twin: Pool, records: RawRecord[], onNew: ReadonlySet<string>, now: Date) {
  const groups: Record<string, RawRecord[]> = { [TO_VERSION]: [], [BASELINE_VERSION]: [] };
  for (const r of records) groups[onNew.has(String((r.payload as Record<string, unknown>).branch_tag)) ? TO_VERSION : BASELINE_VERSION].push(r);
  const total = { inserted: 0, duplicates: 0, quarantined: 0, excluded: 0, projected: 0 };
  let offset = 0;
  for (const [version, group] of Object.entries(groups)) {
    if (group.length === 0) continue;
    const s = await withTransaction(twin, (tx) =>
      ingestRecords(tx, { source: "calls", records: group, mapper: mapperFor("calls", version), ctx: referenceContext, runId: null, now: new Date(now.getTime() + offset) }),
    );
    offset += group.length;
    total.inserted += s.inserted;
    total.duplicates += s.duplicates;
    total.quarantined += s.quarantined;
    total.excluded += s.excluded ?? 0;
    total.projected += s.projected;
  }
  return { stats: total, byVersion: Object.fromEntries(Object.entries(groups).map(([v, g]) => [`calls@${v}`, g.length])) };
}

async function rawDigest(twin: Pool): Promise<string> {
  const { rows } = await twin.query<{ n: string; digest: string }>("select count(*) as n, md5(string_agg(id::text || ':' || payload_hash, ',' order by id)) as digest from raw_events");
  return `${rows[0].n}:${rows[0].digest}`;
}

async function dbWork(twin: Pool) {
  const { rows } = await twin.query<{ xact_commit: string; tup_inserted: string; tup_updated: string; tup_fetched: string; blks_read: string }>(
    "select xact_commit, tup_inserted, tup_updated, tup_fetched, blks_read from pg_stat_database where datname = current_database()",
  );
  return Object.fromEntries(Object.entries(rows[0]).map(([k, v]) => [k, Number(v)]));
}

function inputKinds(records: RawRecord[]) {
  const kinds: Record<string, number> = {};
  for (const r of records) {
    const p = r.payload as Record<string, unknown>;
    const kind = !("customer_phone_number" in p) && !("caller" in p) ? "unreadable (no caller)" : p.spam === true ? "marked spam" : p.lead_status === "not_a_lead" ? "marked not a lead" : p.lead_status === "good_lead" ? "corrected to a good lead" : p.direction === "outbound" ? "outbound" : "other";
    kinds[kind] = (kinds[kind] ?? 0) + 1;
  }
  return kinds;
}

const compactReplay = (from: string, r: ReplayResult) => ({
  from, claimed: r.claimed, projected: r.projected, alreadyProcessed: r.alreadyProcessed, idempotencyKey: r.idempotencyKey,
  // Records the new version could not read: re-projection leaves them as the old version read them.
  unreadable: r.errors.length, unreadableSample: r.errors.slice(0, 5),
  paidAcquired: r.before && r.after ? [r.before.paidAcquired, r.after.paidAcquired] : null,
  googleConversionsToUpload: r.before && r.after ? [r.before.googleConversionsToUpload, r.after.googleConversionsToUpload] : null,
});

export async function runEvaluation(control: Pool, id: number, opts: RunOptions): Promise<EvaluationRow> {
  // Every line names the evaluation and says it is a simulation (review 2026-11-12, SRE M1).
  const log = (line: string) => opts.log?.(`[twin evaluation ${id} · simulated] ${line}`);
  let ev = await getEvaluation(control, id);
  if (!ev) throw new Error(`Evaluation ${id} not found`);
  if (ev.status !== "RUNNING") return ev;
  assertTwinDatabase(ev.twinDatabase);
  const evaluationId = ev.id;
  const runnerId = opts.runnerId ?? `${hostname()}:${process.pid}`;
  // The lease: taken only if free, already ours, or its holder has stopped renewing it.
  const took = await control.query(
    `update rollout_evaluations set runner_id = $2, heartbeat_at = now()
     where id = $1 and status = 'RUNNING' and (runner_id is null or runner_id = $2 or heartbeat_at < now() - make_interval(secs => $3))
     returning id`,
    [evaluationId, runnerId, STALE_AFTER_MS / 1000],
  );
  if (took.rowCount === 0) throw new LeaseLost(`Evaluation ${evaluationId} is held by another runner`);
  const twinUrl = databaseUrl(opts.mainUrl, ev.twinDatabase);
  const plan = faultPlan(ev.variant);
  const actor = `twin:evaluation:${evaluationId}`;
  const deadline = Date.now() + MAX_RUN_MS;
  let lost: LeaseLost | null = null;
  const renew = async (progress: boolean) => {
    const r = await control.query(
      `update rollout_evaluations set heartbeat_at = now()${progress ? ", progress_at = now()" : ""} where id = $1 and runner_id = $2 and status = 'RUNNING'`,
      [evaluationId, runnerId],
    );
    if (r.rowCount === 0) lost ??= new LeaseLost(`Evaluation ${evaluationId}: the lease was taken or the evaluation was abandoned`);
  };
  const fence: Fence = async (progress = false) => {
    if (lost) throw lost;
    await renew(progress);
    if (lost) throw lost;
    if (Date.now() > deadline) throw new Error(`The runner exceeded its ${MAX_RUN_MS / 60_000}-minute limit`);
  };
  let twin: Pool | null = null;
  // A long step (building the base, a 44-branch gate) must not look like a lost runner. A lost
  // runner's process is gone, so its timer is too; here the finally below stops it.
  const heartbeat = setInterval(() => void renew(false).catch(() => undefined), 30_000);

  try {
    await fence(true);
    // ── The world: a fresh copy of the base, the scenario's inputs, the history calls@1.1 counted ──
    const code = codeFingerprint();
    if (ev.summary.world && ev.codeFingerprint && ev.codeFingerprint !== code) {
      throw new Error("The code has changed since this evaluation started; resuming would mix two versions in one verdict. Start a new evaluation.");
    }
    if (!ev.summary.world) {
      await control.query("update rollout_evaluations set code_fingerprint = $2 where id = $1", [evaluationId, code]);
      const base = await ensureBase(opts.mainUrl, log);
      await fence(true);
      const cloneMs = await cloneWorld(opts.mainUrl, ev.twinDatabase);
      log(`twin ${ev.twinDatabase}: cloned in ${cloneMs} ms`);
      // Each twin is a ~200 MB copy: keep the three most recent finished ones for inspection.
      const old = await control.query<{ id: string; twin_database: string }>(
        "select id, twin_database from rollout_evaluations where status <> 'RUNNING' and id < $1 and not (summary ? 'twinDropped') order by id desc offset 3",
        [evaluationId],
      );
      for (const o of old.rows) {
        await dropWorld(opts.mainUrl, o.twin_database).catch(() => undefined);
        await control.query("update rollout_evaluations set summary = summary || jsonb_build_object('twinDropped', now()) where id = $1", [o.id]);
      }
      // Twins of this control database that no evaluation names any more (the control database was
      // reseeded under them): nothing can show or resume them, so they only hold disk.
      const prefix = ev.twinDatabase.replace(/\d+$/, "");
      const known = new Set((await control.query<{ twin_database: string }>("select twin_database from rollout_evaluations")).rows.map((r) => r.twin_database));
      for (const name of await listWorlds(opts.mainUrl, prefix)) {
        if (/^\d+$/.test(name.slice(prefix.length)) && !known.has(name)) await dropWorld(opts.mainUrl, name).catch(() => undefined);
      }
      twin = createPool(twinUrl);
      await twin.query("create table twin_inputs (variant text not null, overlay jsonb not null)");
      const overlay = await buildOverlay(twin, ev.variant);
      await twin.query("insert into twin_inputs (variant, overlay) values ($1, $2)", [ev.variant, JSON.stringify(overlay)]);
      await twin.query("update app_clock set now = $1", [PHASE_NOW.world]);
      const pre = await deliverRouted(twin, overlay.preRollout, new Set(), PHASE_NOW.world);
      await withTransaction(twin, (tx) => reconcile(tx, new Date(PHASE_NOW.world.getTime() + MINUTE)));
      const ack: WorldAck = {
        baseBuilt: base.built, baseBuildMs: base.buildMs, cloneMs,
        preRollout: { records: overlay.preRollout.length, inserted: pre.stats.inserted, projected: pre.stats.projected },
        inputs: overlay.notes.length, newCrmRecords: overlay.crm.length, at: new Date().toISOString(),
      };
      await fence(true);
      await control.query(
        "update rollout_evaluations set scenario_hash = $2, source_hash = $3, base_fingerprint = $4, summary = summary || jsonb_build_object('world', $5::jsonb), heartbeat_at = now() where id = $1",
        [evaluationId, scenarioHash(ev.variant, overlay), await rawDigest(twin), base.fingerprint, JSON.stringify(ack)],
      );
      ev = (await getEvaluation(control, evaluationId))!;
    }
    twin ??= createPool(twinUrl);
    const overlay = (await twin.query<{ overlay: Overlay }>("select overlay from twin_inputs")).rows[0].overlay;
    let worldRecords: SourceRecordVersion[] | null = null;
    const world = () => (worldRecords ??= generateWorld().records);

    // ── The stages, in order, fail-closed ──
    let onNewVersion: string[] = [];
    let stopped = false;
    for (const stage of ev.stages) {
      const planned = STAGES.find((s) => s.key === stage.key)!;
      if (stage.status === "PASSED") {
        onNewVersion = stage.branchIds;
        continue;
      }
      if (stopped || stage.status === "BLOCKED") {
        if (stage.status !== "BLOCKED") await control.query("update rollout_stages set status = 'BLOCKED' where evaluation_id = $1 and ordinal = $2", [evaluationId, stage.ordinal]);
        continue;
      }
      const kind = (stage.recovery as { kind?: string } | null)?.kind;
      if (stage.status === "RECOVERED" || (stage.status === "FAILED" && kind === "rollback")) {
        stopped = true;
        continue;
      }
      if (stage.status === "FAILED" || (stage.status === "RECOVERING" && kind === "rollback")) {
        // A failed stage whose rollback never started (the runner was lost between the two
        // writes; review 2026-11-12, data 4) or did not finish: roll it back now.
        await rollback(twin, control, evaluationId, stage, planned, onNewVersion, actor, log, fence);
        stopped = true;
        continue;
      }
      const outcome = await runStage(twin, control, { evaluationId, stage, planned, onNewVersion, overlay, plan: plan[planned.key], world, twinUrl, actor, opts, fence, log });
      if (outcome === "PASSED") {
        onNewVersion = planned.branchIds;
        continue;
      }
      const failed = (await getEvaluation(control, evaluationId))!.stages.find((s) => s.ordinal === stage.ordinal)!;
      await rollback(twin, control, evaluationId, failed, planned, onNewVersion, actor, log, fence);
      stopped = true;
    }

    await fence(true);
    const final = (await getEvaluation(control, evaluationId))!;
    const status = final.stages.every((s) => s.status === "PASSED") ? "PASSED" : "FAILED";
    await control.query(
      "update rollout_evaluations set status = $2, finished_at = now(), heartbeat_at = now(), runner_id = null, summary = summary || jsonb_build_object('outcome', $3::jsonb) where id = $1 and runner_id = $4",
      [evaluationId, status, JSON.stringify({ stages: final.stages.map((s) => ({ key: s.key, status: s.status, violated: s.violated })) }), runnerId],
    );
    await control.query("insert into audit_log (at, actor, action, subject, detail) values (now(), $1, 'rollout_evaluation.finished', $2, $3)", [
      actor, `change:${final.changeId}`, { evaluationId, status, simulated: true, stages: final.stages.map((s) => `${s.key}:${s.status}`) },
    ]);
    log(`${status} (${final.stages.map((s) => `${s.key} ${s.status}`).join(", ")})`);
    return (await getEvaluation(control, evaluationId))!;
  } catch (error) {
    if (error instanceof Interrupted) throw error; // a lost process writes nothing more
    if (error instanceof LeaseLost) {
      log(`stopped: ${error.message}`);
      return (await getEvaluation(control, evaluationId))!;
    }
    const message = error instanceof Error ? error.message : String(error);
    // No verdict: the evaluation ends in ERROR, and the stage it was in says it stopped mid-way
    // (review 2026-11-12, SRE H3). Only while this runner still holds the lease.
    const ended = await control.query(
      "update rollout_evaluations set status = 'ERROR', error = $2, finished_at = now(), runner_id = null where id = $1 and status = 'RUNNING' and runner_id = $3 returning id",
      [evaluationId, message.slice(0, 1000), runnerId],
    );
    if (ended.rowCount) {
      await control.query("update rollout_stages set status = 'INTERRUPTED' where evaluation_id = $1 and status in ('RUNNING', 'RECOVERING')", [evaluationId]);
      await control.query("insert into audit_log (at, actor, action, subject, detail) values (now(), $1, 'rollout_evaluation.error', $2, $3)", [actor, `change:${ev.changeId}`, { evaluationId, error: message.slice(0, 500), simulated: true }]);
    }
    log(`ERROR ${message}`);
    return (await getEvaluation(control, evaluationId))!;
  } finally {
    clearInterval(heartbeat);
    await twin?.end().catch(() => undefined);
  }
}

interface StageContext {
  evaluationId: number;
  stage: StageRow;
  planned: StagePlan;
  onNewVersion: string[];
  overlay: Overlay;
  plan: ReturnType<typeof faultPlan>[StageKey];
  world: () => SourceRecordVersion[];
  twinUrl: string;
  actor: string;
  opts: RunOptions;
  fence: Fence;
  log: (line: string) => void;
}

async function runStage(twin: Pool, control: Pool, c: StageContext): Promise<"PASSED" | "FAILED"> {
  const { evaluationId, stage, planned } = c;
  const key = planned.key;
  const now = PHASE_NOW[key];
  // RUNNING or RECOVERING: an earlier runner was lost mid-stage; INTERRUPTED: the evaluation
  // ended in an error mid-stage and was re-opened.
  const resumed = stage.status === "RUNNING" || stage.status === "RECOVERING" || stage.status === "INTERRUPTED";
  const started = Date.now();
  await c.fence(true);
  if (!resumed) {
    const before = await takeSnapshot(twin);
    await twin.query("update app_clock set now = $1", [now]);
    await control.query(
      `update rollout_stages set status = 'RUNNING', attempts = 1, started_at = now(), evidence = jsonb_build_object('before', $3::jsonb, 'dbAtStart', $4::jsonb, 'contract', $5::jsonb)
       where evaluation_id = $1 and ordinal = $2`,
      [evaluationId, stage.ordinal, JSON.stringify(before), JSON.stringify(await dbWork(twin)), JSON.stringify({ from: FROM_VERSIONS.map((v) => `calls@${v}`), to: `calls@${TO_VERSION}`, routing: "twin only: these branches read calls with the new version; every other branch with calls@1.1" })],
    );
  } else {
    const acked = Object.keys(stage.steps);
    c.log(`stage ${key}: resumed by a new runner; acknowledged steps: ${acked.join(", ") || "none"}`);
    const interruptions = [...(((stage.recovery as { interruptions?: unknown[] } | null)?.interruptions) ?? []), { detectedAt: new Date().toISOString(), acknowledgedSteps: acked }];
    await control.query("update rollout_stages set status = 'RECOVERING', attempts = attempts + 1, recovery = $3 where evaluation_id = $1 and ordinal = $2", [
      evaluationId, stage.ordinal, JSON.stringify({ kind: "resumed", interruptions }),
    ]);
  }
  const row = async () => (await getEvaluation(control, evaluationId))!.stages.find((s) => s.ordinal === stage.ordinal)!;
  const fresh = await row();
  const before = fresh.evidence.before as Snapshot;
  const onNew = new Set([...c.onNewVersion, ...planned.branchIds]);
  const steps: Record<string, unknown> = Object.fromEntries(Object.entries(fresh.steps).map(([k, v]) => [k, v.result]));
  const timings: Record<string, number> = { ...((fresh.metrics.stepMs as Record<string, number> | undefined) ?? {}) };
  let peakRss = Number(fresh.metrics.peakRssMb ?? 0);
  const ack = async (step: StepName, result: unknown, ms: number) => {
    // The hook sits here: the step's work has committed, its acknowledgement has not.
    if (c.opts.interruptions && !resumed && c.plan.interruptAfter === step) {
      c.log(`stage ${key}: runner lost after "${step}" committed (planned interruption)`);
      throw new Interrupted(`stage ${key}: interrupted after ${step}`);
    }
    timings[step] = ms;
    peakRss = Math.max(peakRss, Math.round(process.memoryUsage().rss / 1_048_576));
    await c.fence(true);
    await control.query(
      "update rollout_stages set steps = steps || jsonb_build_object($3::text, jsonb_build_object('at', now(), 'result', $4::jsonb)), metrics = metrics || jsonb_build_object('stepMs', $5::jsonb, 'peakRssMb', $6::int) where evaluation_id = $1 and ordinal = $2",
      [evaluationId, stage.ordinal, step, JSON.stringify(result), JSON.stringify(timings), peakRss],
    );
    steps[step] = result;
  };
  const resumedReplays: Array<{ from: string; alreadyProcessed: boolean }> = [];
  let redelivered = false;

  for (const step of STEPS.filter((s) => s !== "gates")) {
    if (step in steps) continue;
    await c.fence(true);
    const t = Date.now();
    if (step === "reproject") {
      const results = [];
      for (const from of FROM_VERSIONS) {
        const ids = (await twin.query<{ id: string }>(
          "select id from raw_events where source = 'calls' and status = 'projected' and adapter_version = $1 and payload_branch(payload) = any($2::text[]) order by id",
          [`calls@${from}`, planned.newBranchIds],
        )).rows.map((r) => Number(r.id));
        const r = await replay(twin, {
          source: "calls", rawEventIds: ids, mapperVersion: TO_VERSION, fromVersion: from, mode: "reproject", actor: c.actor,
          idempotencyKey: `twin:${evaluationId}:${key}:reproject:${from}`, dryRun: false, now, scope: { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: planned.newBranchIds },
        });
        if (resumed) resumedReplays.push({ from, alreadyProcessed: r.alreadyProcessed });
        results.push(compactReplay(from, r));
      }
      await ack(step, results, Date.now() - t);
    } else if (step === "deliver") {
      const records = c.overlay.inflight[key];
      const at = new Date(now.getTime() + 5 * MINUTE);
      const first = await deliverRouted(twin, records, onNew, at);
      const digestAfterFirst = await businessDigest(twin);
      const rawAfterFirst = Number((await twin.query<{ n: string }>("select count(*) as n from raw_events")).rows[0].n);
      // An operator re-posts the batch (the same records): it must change nothing.
      const again = await deliverRouted(twin, records, onNew, new Date(at.getTime() + MINUTE));
      const report: DeliverReport = {
        records: records.length, byVersion: first.byVersion, first: first.stats, again: { inserted: again.stats.inserted, duplicates: again.stats.duplicates },
        rawCountAfterFirst: rawAfterFirst, rawCountAfterAgain: Number((await twin.query<{ n: string }>("select count(*) as n from raw_events")).rows[0].n),
        digestAfterFirst, digestAfterAgain: await businessDigest(twin),
      };
      // A re-delivery only if the lost runner had committed this step: every record already stored.
      if (resumed && first.stats.inserted === 0 && first.stats.duplicates > 0) redelivered = true;
      await ack(step, { ...report, kinds: inputKinds(records) }, Date.now() - t);
    } else if (step === "backfill") {
      const report = await runBackfill(twin, {
        twinUrl: c.twinUrl, key: `twin:${evaluationId}:${key}:backfill`, actor: c.actor, officeIds: planned.newBranchIds.map(officeOf), plan: c.plan.backfill, world: c.world, overlay: c.overlay.crm,
      });
      await ack(step, report, Date.now() - t);
    } else if (step === "reconcile") {
      await withTransaction(twin, (tx) => reconcile(tx, new Date(now.getTime() + 30 * MINUTE)));
      await ack(step, { at: new Date(now.getTime() + 30 * MINUTE).toISOString() }, Date.now() - t);
    }
  }

  // ── Gates ──
  const t = Date.now();
  const after = await takeSnapshot(twin);
  const oracleStarted = Date.now();
  const oracle = await referenceState(twin, { onNewVersion: [...onNew], period: PERIODS.all });
  const previous = await referenceState(twin, { onNewVersion: c.onNewVersion, period: PERIODS.all });
  const oracleMs = Date.now() - oracleStarted;
  const attribution = attributionChanges(previous, oracle, planned);
  const resumedInfo = resumed ? { afterStep: Object.keys(fresh.steps).at(-1) ?? null, reproject: resumedReplays, redelivered } : null;
  const gates: Gate[] = await evaluateGates({
    twin, stage: planned, before, after, oracle, attribution,
    deliver: (steps.deliver as DeliverReport | undefined) ?? null, backfill: (steps.backfill as BackfillReport | undefined) ?? null, resumed: resumedInfo,
    reprojectUnreadable: (steps.reproject as Array<{ unreadable?: number }> | undefined)?.reduce((n, r) => n + (r.unreadable ?? 0), 0) ?? 0,
  });
  const violated = gates.filter((g) => g.status === "fail").map((g) => g.id);
  const status = violated.length === 0 ? "PASSED" : "FAILED";
  const outside = Object.keys(after.branches).filter((b) => !planned.branchIds.includes(b));
  const movedOutside = outside.filter((b) => differences(before.branches[b], after.branches[b]).length > 0);
  const dbEnd = await dbWork(twin);
  const dbStart = fresh.evidence.dbAtStart as Record<string, number>;
  const backfill = steps.backfill as BackfillReport | undefined;
  const reprojected = (steps.reproject as Array<{ claimed: number }> | undefined)?.reduce((n, r) => n + r.claimed, 0) ?? 0;
  timings.gates = Date.now() - t;
  const evidence = {
    ...fresh.evidence,
    after,
    inputs: { delivered: (steps.deliver as { kinds?: unknown } | undefined)?.kinds ?? {}, reprojected, backfillOffices: planned.newBranchIds },
    affected: [...planned.branchIds, ...movedOutside],
    unaffected: outside.filter((b) => !movedOutside.includes(b)),
    attribution,
    references: {
      twinDatabase: c.twinUrl.split("/").pop(),
      replayKeys: FROM_VERSIONS.map((v) => `twin:${evaluationId}:${key}:reproject:${v}`),
      syncRequestKey: `twin:${evaluationId}:${key}:backfill`,
      syncJobIds: backfill?.jobs.map((j) => j.id) ?? [],
      rawEventIds: after.raw.maxId > before.raw.maxId ? [before.raw.maxId + 1, after.raw.maxId] : [],
      oracleNotes: oracle.notes.slice(0, 10),
    },
  };
  const metrics = {
    stepMs: timings,
    stageMs: Date.now() - started + Number(fresh.metrics.stageMs ?? 0),
    oracleMs,
    scorecardMs: { before: before.scorecardMs, after: after.scorecardMs },
    peakRssMb: Math.max(peakRss, Math.round(process.memoryUsage().rss / 1_048_576)),
    branches: planned.newBranchIds.length,
    msPerNewBranch: Math.round((Date.now() - started) / Math.max(1, planned.newBranchIds.length)),
    records: { reprojected, delivered: (steps.deliver as DeliverReport | undefined)?.records ?? 0, backfillFetched: backfill?.jobs.reduce((n, j) => n + (j.stats.fetched ?? 0), 0) ?? 0 },
    db: Object.fromEntries(Object.keys(dbEnd).map((k) => [k, dbEnd[k] - (dbStart?.[k] ?? 0)])),
    retryOverhead: backfill ? { retriesScheduled: backfill.retriesScheduled, simulatedWaitMs: backfill.simulatedWaitMs, runbookRetries: backfill.runbookRetries.length } : null,
  };
  const recovery = resumed ? { ...((fresh.recovery as Record<string, unknown> | null) ?? {}), kind: "resumed", verified: !violated.includes("F2") && violated.length === 0, resumedSteps: STEPS.filter((s) => !(s in fresh.steps)) } : null;
  await c.fence(true);
  await control.query(
    `update rollout_stages set status = $3, completed_at = now(), gates = $4, violated = $5, evidence = $6, metrics = $7, recovery = coalesce($8::jsonb, recovery),
       steps = steps || jsonb_build_object('gates', jsonb_build_object('at', now(), 'result', jsonb_build_object('violated', $5::text[])))
     where evaluation_id = $1 and ordinal = $2`,
    [evaluationId, stage.ordinal, status, JSON.stringify(gates), violated, JSON.stringify(evidence), JSON.stringify(metrics), recovery ? JSON.stringify(recovery) : null],
  );
  c.log(`stage ${key} (${planned.label}): ${status}${violated.length ? ` — failed ${violated.join(", ")}` : ""} in ${metrics.stageMs} ms`);
  return status;
}

/**
 * Recovery of a failed stage: its new branches are re-projected with the mapper they had before
 * (calls@1.1), through the production replay, and the result is checked, not assumed.
 */
async function rollback(twin: Pool, control: Pool, evaluationId: number, stage: StageRow, planned: StagePlan, onNewVersion: string[], actor: string, log: (line: string) => void, fence: Fence): Promise<void> {
  const started = Date.now();
  await fence(true);
  await control.query("update rollout_stages set status = 'RECOVERING', recovery = jsonb_build_object('kind', 'rollback', 'startedAt', now()) where evaluation_id = $1 and ordinal = $2", [evaluationId, stage.ordinal]);
  const now = new Date(PHASE_NOW[planned.key].getTime() + 45 * MINUTE);
  const ids = (await twin.query<{ id: string }>(
    "select id from raw_events where source = 'calls' and adapter_version = $1 and status in ('projected', 'excluded') and payload_branch(payload) = any($2::text[]) order by id",
    [`calls@${TO_VERSION}`, planned.newBranchIds],
  )).rows.map((r) => Number(r.id));
  const result = await replay(twin, {
    source: "calls", rawEventIds: ids, mapperVersion: BASELINE_VERSION, fromVersion: TO_VERSION, mode: "reproject", actor: `${actor}:rollback`,
    idempotencyKey: `twin:${evaluationId}:${planned.key}:rollback`, dryRun: false, now, scope: { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: planned.newBranchIds },
  });
  // Records calls@1.2 held (could not read) during the stage are read again by calls@1.1: the
  // old version may count what the new one refused (review 2026-11-12, data 3). What neither
  // reads stays held.
  await fence(true);
  const heldIds = (await twin.query<{ id: string }>(
    "select id from raw_events where source = 'calls' and status = 'quarantined' and adapter_version = $1 and payload_branch(payload) = any($2::text[]) order by id",
    [`calls@${TO_VERSION}`, planned.newBranchIds],
  )).rows.map((r) => Number(r.id));
  const reread = await replay(twin, {
    source: "calls", rawEventIds: heldIds, mapperVersion: BASELINE_VERSION, mode: "quarantined", actor: `${actor}:rollback`,
    idempotencyKey: `twin:${evaluationId}:${planned.key}:rollback-held`, dryRun: false, now: new Date(now.getTime() + 1_000), scope: { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: planned.newBranchIds },
  });
  await withTransaction(twin, (tx) => reconcile(tx, new Date(now.getTime() + MINUTE)));
  await fence(true);

  // Verify every postcondition that applies; name the ones that cannot be checked here.
  const before = stage.evidence.before as Snapshot;
  const restored = await referenceState(twin, { onNewVersion, period: PERIODS.all });
  const after = await takeSnapshot(twin);
  const acq = await twin.query<{ crm_customer_id: string; lead_id: string | null }>("select crm_customer_id, lead_id from v_acquisitions");
  const creditMismatches = acq.rows.filter((r) => (r.lead_id === null ? null : Number(r.lead_id)) !== (restored.credit.get(Number(r.crm_customer_id)) ?? null)).length;
  const counted = new Set((await twin.query<{ id: string }>("select source_lead_id as id from v_leads where source = 'calls'")).rows.map((r) => r.id));
  const leadMismatches = [...counted].filter((x) => !restored.countedCalls.has(x)).length + [...restored.countedCalls].filter((x) => !counted.has(x)).length;
  const branchMismatches = Object.entries(after.branches).filter(([b, r]) => {
    const ref = restored.branches.get(b) ?? { prospects: 0, acquired: 0, paidAcquired: 0, unknownAcquired: 0 };
    return r.prospects !== ref.prospects || r.acquired !== ref.acquired || r.paidAcquired !== ref.paidAcquired || r.unknownAcquired !== ref.unknownAcquired;
  }).map(([b]) => b);
  const outsideRestored = Object.keys(after.branches).filter((b) => !planned.branchIds.includes(b)).filter((b) => differences(before.branches[b], after.branches[b]).length > 0);
  const kept = await twin.query<{ n: string; digest: string | null }>("select count(*) as n, md5(string_agg(id::text || ':' || payload_hash, ',' order by id)) as digest from raw_events where id <= $1", [before.raw.maxId]);
  // Records the new mapper still decides. A record it could not read (quarantined) never took
  // effect and waits for a replay; it is reported, not rolled back.
  const stamped = await twin.query<{ live: string; held: string }>(
    `select count(*) filter (where status in ('projected', 'excluded')) as live, count(*) filter (where status = 'quarantined') as held
     from raw_events where source = 'calls' and adapter_version = $1 and payload_branch(payload) = any($2::text[])`,
    [`calls@${TO_VERSION}`, planned.newBranchIds],
  );
  const stillStamped = Number(stamped.rows[0].live);
  const heldOnNewVersion = Number(stamped.rows[0].held);
  const restoredState = creditMismatches === 0 && leadMismatches === 0 && branchMismatches.length === 0 && outsideRestored.length === 0 && stillStamped === 0;
  const preserved = Number(kept.rows[0].n) === before.raw.count && kept.rows[0].digest === before.raw.digest && after.history.audit > before.history.audit && after.history.replays > before.history.replays;
  const recovery = {
    kind: "rollback",
    action: `Re-projected ${result.claimed} stored call record(s) of ${planned.newBranchIds.join(", ")} from calls@${TO_VERSION} back to calls@${BASELINE_VERSION} (replay ${result.idempotencyKey}${result.alreadyProcessed ? ", already done: stored result" : ""}), and gave the ${reread.claimed} record(s) calls@${TO_VERSION} had held to calls@${BASELINE_VERSION}: ${reread.projected} read, ${reread.stillQuarantined} still unreadable.`,
    restoredBusinessState: {
      verified: restoredState,
      detail: restoredState
        ? `Every customer's credit, every counted call and every branch's figures equal the reference with ${onNewVersion.length ? onNewVersion.join(", ") : "no branch"} on calls@${TO_VERSION} and the rest on calls@${BASELINE_VERSION}; every branch outside the stage is back to its figures before the stage.`
        : `${creditMismatches} credit(s), ${leadMismatches} call(s) and ${branchMismatches.length} branch(es) differ from the restored reference; branches outside the stage still moved: ${outsideRestored.join(", ") || "none"}.`,
      mismatches: { credit: creditMismatches, calls: leadMismatches, branches: branchMismatches, outside: outsideRestored },
      recordsStillOnNewVersion: stillStamped,
      heldUnreadable: heldOnNewVersion,
    },
    preservedAuditHistory: {
      verified: preserved,
      detail: preserved
        ? `All ${before.raw.count} records stored before the stage are unchanged and the ${after.raw.count - before.raw.count} received during it are kept; the rollback is one more replay and audit entry (${after.history.replays} replays, ${after.history.audit} audit entries); the failed stage's gates stay on record.`
        : "Stored evidence or history changed during the rollback.",
    },
    unreversedExternalEffects: {
      inTwin: "None: the twin calls no external system.",
      inProduction: [
        "In a real rollout, offline conversions uploaded to Google Ads while a stage ran would not be withdrawn by a rollback (here the conversion feedback ledger is a dry run, and nothing was uploaded).",
        "In a real rollout, what people did on the numbers a stage showed (budget moves, reports sent) would be outside any rollback.",
      ],
    },
    unverified: [
      "Figures outside the scorecard and traces (Decision Lab verdicts, exports, investigations) were not re-checked after the rollback.",
      "Identity-review conflicts opened against excluded calls during the stage stay as they are.",
    ],
    ms: Date.now() - started,
  };
  const status = restoredState && preserved ? "RECOVERED" : "FAILED";
  await fence(true);
  await control.query("update rollout_stages set status = $3, recovery = $4, completed_at = now() where evaluation_id = $1 and ordinal = $2", [evaluationId, stage.ordinal, status, JSON.stringify(recovery)]);
  log(`stage ${planned.key}: rollback ${status} in ${recovery.ms} ms`);
}

/**
 * Runs an evaluation to its end, restarting the runner when it is lost after a commit, as a
 * process supervisor would. Each restart gets new connection pools and only durable state.
 */
export async function superviseEvaluation(controlUrl: string, id: number, opts: RunOptions & { maxRestarts?: number }): Promise<EvaluationRow> {
  // The supervised slot keeps one lease name across restarts, as a restarted worker keeps its name.
  const slot: RunOptions = { ...opts, runnerId: opts.runnerId ?? `${hostname()}:${process.pid}:supervisor` };
  for (let restarts = 0; ; restarts++) {
    const control = createPool(controlUrl);
    try {
      return await runEvaluation(control, id, slot);
    } catch (error) {
      if (error instanceof LeaseLost) {
        const ev = await getEvaluation(control, id);
        if (ev) return ev;
      }
      if (!(error instanceof Interrupted) || restarts >= (opts.maxRestarts ?? 3)) throw error;
      opts.log?.(`[twin evaluation ${id} · simulated] ${error.message}; restarting the runner from durable state`);
    } finally {
      await control.end();
    }
  }
}
