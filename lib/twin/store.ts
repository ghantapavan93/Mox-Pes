import type { Pool } from "pg";
import { ActionError } from "@/lib/actions";
import type { Queryable } from "@/lib/db";
import { sha256 } from "@/lib/primitives";
import { ForbiddenError, type Viewer } from "@/lib/viewer";
import { FROM_VERSIONS, STAGES, TO_VERSION, TWIN_SCENARIO_ID, isVariant, type Variant } from "./scenario";

/**
 * The twin's control plane (migration 0025), in the application's database. Reads are for the
 * change page; writes are the runner's (lib/twin/runner.ts).
 */

export type EvaluationStatus = "RUNNING" | "PASSED" | "FAILED" | "ERROR";
export type StageStatus = "PENDING" | "RUNNING" | "PASSED" | "FAILED" | "BLOCKED" | "RECOVERING" | "RECOVERED" | "INTERRUPTED";

export interface StageRow {
  ordinal: number;
  key: string;
  label: string;
  branchIds: string[];
  newBranchIds: string[];
  status: StageStatus;
  startedAt: string | null;
  completedAt: string | null;
  attempts: number;
  steps: Record<string, { at: string; result: unknown }>;
  gates: Array<{ id: string; label: string; status: "pass" | "fail" | "not_applicable"; detail: string; evidence?: Record<string, unknown> }>;
  violated: string[];
  faults: unknown[];
  recovery: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
  metrics: Record<string, unknown>;
}

export interface EvaluationRow {
  id: number;
  changeId: number;
  scenarioId: string;
  variant: Variant;
  scenarioHash: string | null;
  sourceHash: string | null;
  baseFingerprint: string | null;
  codeFingerprint: string | null;
  fromVersions: string[];
  toVersion: string;
  twinDatabase: string;
  status: EvaluationStatus;
  startedBy: string;
  startedAt: string;
  runnerId: string | null;
  heartbeatAt: string;
  progressAt: string;
  finishedAt: string | null;
  error: string | null;
  summary: Record<string, unknown>;
  stages: StageRow[];
}

/** A RUNNING evaluation whose runner has not renewed its lease for this long has lost its process. */
export const STALE_AFTER_MS = 3 * 60_000;
/** A runner that holds its lease but has not started or finished a step for this long is stuck. */
export const STALL_AFTER_MS = 10 * 60_000;

const iso = (d: Date | null) => (d ? d.toISOString() : null);

async function stagesOf(db: Queryable, ids: number[]): Promise<Map<number, StageRow[]>> {
  const { rows } = await db.query<Record<string, unknown> & { evaluation_id: string }>("select * from rollout_stages where evaluation_id = any($1::bigint[]) order by evaluation_id, ordinal", [ids]);
  const out = new Map<number, StageRow[]>();
  for (const r of rows) {
    const list = out.get(Number(r.evaluation_id)) ?? [];
    list.push({
      ordinal: r.ordinal as number, key: r.key as string, label: r.label as string, branchIds: r.branch_ids as string[], newBranchIds: r.new_branch_ids as string[],
      status: r.status as StageStatus, startedAt: iso(r.started_at as Date | null), completedAt: iso(r.completed_at as Date | null), attempts: r.attempts as number,
      steps: r.steps as StageRow["steps"], gates: r.gates as StageRow["gates"], violated: r.violated as string[], faults: r.faults as unknown[],
      recovery: r.recovery as StageRow["recovery"], evidence: r.evidence as StageRow["evidence"], metrics: r.metrics as StageRow["metrics"],
    });
    out.set(Number(r.evaluation_id), list);
  }
  return out;
}

function toEvaluation(r: Record<string, unknown>, stages: StageRow[]): EvaluationRow {
  return {
    id: Number(r.id), changeId: Number(r.change_id), scenarioId: r.scenario_id as string, variant: r.variant as Variant, scenarioHash: r.scenario_hash as string | null,
    sourceHash: r.source_hash as string | null, baseFingerprint: r.base_fingerprint as string | null, codeFingerprint: r.code_fingerprint as string | null,
    fromVersions: r.from_versions as string[], toVersion: r.to_version as string,
    twinDatabase: r.twin_database as string, status: r.status as EvaluationStatus, startedBy: r.started_by as string, startedAt: iso(r.started_at as Date)!,
    runnerId: r.runner_id as string | null, heartbeatAt: iso(r.heartbeat_at as Date)!, progressAt: iso(r.progress_at as Date)!,
    finishedAt: iso(r.finished_at as Date | null), error: r.error as string | null, summary: r.summary as Record<string, unknown>, stages,
  };
}

export async function getEvaluation(db: Queryable, id: number): Promise<EvaluationRow | null> {
  const { rows } = await db.query("select * from rollout_evaluations where id = $1", [id]);
  if (!rows[0]) return null;
  return toEvaluation(rows[0], (await stagesOf(db, [id])).get(id) ?? []);
}

/** Only a viewer with every branch in scope sees an evaluation: its stages span all 44. */
export function assertCanSeeEvaluations(viewer: Viewer): void {
  if (viewer.branchIds !== null) throw new ForbiddenError(`${viewer.label} cannot see a rollout evaluation: it covers branches outside your scope`);
}

export async function listEvaluations(db: Queryable, viewer: Viewer, changeId: number, limit = 6): Promise<EvaluationRow[]> {
  assertCanSeeEvaluations(viewer);
  const { rows } = await db.query("select * from rollout_evaluations where change_id = $1 order by id desc limit $2", [changeId, limit]);
  const stages = await stagesOf(db, rows.map((r) => Number(r.id)));
  return rows.map((r) => toEvaluation(r, stages.get(Number(r.id)) ?? []));
}

/** A running evaluation whose runner stopped renewing its lease: shown with a Resume action. */
export const isStale = (e: Pick<EvaluationRow, "status" | "heartbeatAt">, now: number) => e.status === "RUNNING" && now - Date.parse(e.heartbeatAt) > STALE_AFTER_MS;
/** A running evaluation whose runner is alive but has made no progress: shown with an Abandon action. */
export const isStalled = (e: Pick<EvaluationRow, "status" | "heartbeatAt" | "progressAt">, now: number) =>
  e.status === "RUNNING" && !isStale(e, now) && now - Date.parse(e.progressAt) > STALL_AFTER_MS;

export type EvaluationView = EvaluationRow & { stale: boolean; stalled: boolean; outdated: boolean };

/** The change page's view: each evaluation, whether its runner is lost or stuck, and whether the code has changed since. */
export async function evaluationsForPage(db: Queryable, viewer: Viewer, changeId: number, currentCode: string | null): Promise<EvaluationView[]> {
  const now = Date.now();
  return (await listEvaluations(db, viewer, changeId)).map((e) => ({
    ...e,
    stale: isStale(e, now),
    stalled: isStalled(e, now),
    outdated: currentCode !== null && e.codeFingerprint !== null && e.codeFingerprint !== currentCode,
  }));
}

/**
 * Ends a RUNNING evaluation that cannot finish (stuck, or its runner gone): ERROR, the stage in
 * flight INTERRUPTED (no verdict), the lease released. A runner still holding the lease loses it:
 * its next write is refused. Requires the propose permission and every branch in scope.
 */
export async function abandonEvaluation(pool: Pool, viewer: Viewer, args: { changeId: number; evaluationId: number; now: Date }): Promise<void> {
  if (!viewer.can.propose) throw new ForbiddenError(`${viewer.label} cannot abandon a rollout evaluation`);
  assertCanSeeEvaluations(viewer);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const ended = await client.query(
      "update rollout_evaluations set status = 'ERROR', error = $3, finished_at = $4, runner_id = null where id = $1 and change_id = $2 and status = 'RUNNING' returning id",
      [args.evaluationId, args.changeId, `Abandoned by ${viewer.subject}: it was not finishing`, args.now],
    );
    if (ended.rowCount === 0) throw new ActionError("No running evaluation with that id on this change", 409);
    await client.query("update rollout_stages set status = 'INTERRUPTED' where evaluation_id = $1 and status in ('RUNNING', 'RECOVERING')", [args.evaluationId]);
    await client.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'rollout_evaluation.abandoned', $3, $4)", [
      args.now, viewer.subject, `change:${args.changeId}`, { evaluationId: args.evaluationId, simulated: true },
    ]);
    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  } finally {
    client.release();
  }
}

/**
 * Re-opens an evaluation that ended in ERROR so a runner can resume it from its acknowledged
 * steps: only while its twin database is kept, and only on the code that started it. One
 * evaluation of a change runs at a time.
 */
export async function reopenEvaluation(pool: Pool, viewer: Viewer, args: { changeId: number; evaluationId: number; currentCode: string; now: Date }): Promise<void> {
  if (!viewer.can.propose) throw new ForbiddenError(`${viewer.label} cannot resume a rollout evaluation`);
  assertCanSeeEvaluations(viewer);
  const ev = await getEvaluation(pool, args.evaluationId);
  if (!ev || ev.changeId !== args.changeId) throw new ActionError("Evaluation not found", 404);
  if (ev.status !== "ERROR") throw new ActionError(`Evaluation ${ev.id} is ${ev.status}; only one that ended in an error can be re-opened`, 409);
  if (!ev.summary.world || ev.summary.twinDropped) throw new ActionError("Its twin database is gone; start a new evaluation", 409);
  if (ev.codeFingerprint && ev.codeFingerprint !== args.currentCode) throw new ActionError("The code has changed since this evaluation started; start a new one", 409);
  try {
    await pool.query(
      `update rollout_evaluations set status = 'RUNNING', finished_at = null, runner_id = null, heartbeat_at = $2, progress_at = $2,
         summary = summary || jsonb_build_object('errors', coalesce(summary -> 'errors', '[]'::jsonb) || jsonb_build_array(jsonb_build_object('error', error, 'reopenedAt', $2::timestamptz, 'by', $3::text))),
         error = null
       where id = $1 and status = 'ERROR'`,
      [ev.id, args.now, viewer.subject],
    );
  } catch (error) {
    if ((error as { code?: string }).code === "23505") throw new ActionError("Another evaluation of this change is running", 409);
    throw error;
  }
}

/** The twin evaluates one change: a calls source-contract check (the calls@1.2 upgrade). */
export async function assertEvaluable(db: Queryable, changeId: number): Promise<void> {
  const { rows } = await db.query<{ kind: string; payload: { source?: string } }>("select kind, payload from config_changes where id = $1", [changeId]);
  if (!rows[0]) throw new ActionError(`Change ${changeId} not found`, 404);
  if (rows[0].kind !== "source_contract" || rows[0].payload.source !== "calls") {
    throw new ActionError(`The twin evaluates the calls source-contract upgrade (calls@${FROM_VERSIONS.at(-1)} → calls@${TO_VERSION}); change ${changeId} is not one`, 409);
  }
}

/**
 * Records a new evaluation and its stages, all PENDING. Requires the propose permission and
 * every branch in scope. One evaluation of a change runs at a time (a unique index).
 */
export async function createEvaluation(pool: Pool, viewer: Viewer, args: { changeId: number; variant: unknown; controlDatabase: string; now: Date }): Promise<number> {
  if (!viewer.can.propose) throw new ForbiddenError(`${viewer.label} cannot start a rollout evaluation`);
  assertCanSeeEvaluations(viewer);
  if (!isVariant(args.variant)) throw new ActionError(`Unknown variant "${String(args.variant)}"`, 400);
  await assertEvaluable(pool, args.changeId);
  const client = await pool.connect();
  try {
    await client.query("begin");
    const inserted = await client.query<{ id: string }>(
      `insert into rollout_evaluations (change_id, scenario_id, variant, from_versions, to_version, twin_database, status, started_by, started_at, heartbeat_at, progress_at)
       values ($1, $2, $3, $4, $5, 'pending', 'RUNNING', $6, $7, $7, $7) returning id`,
      [args.changeId, TWIN_SCENARIO_ID, args.variant, [...FROM_VERSIONS], TO_VERSION, viewer.subject, args.now],
    );
    const id = Number(inserted.rows[0].id);
    // The control database's full name, hashed, keeps two applications on one server (or names
    // that sanitise or truncate alike) from naming the same twin (review 2026-11-12, financial 7).
    const twin = `rso_twin_${args.controlDatabase.toLowerCase().replace(/[^a-z0-9]/g, "_").slice(0, 20)}_${sha256(args.controlDatabase).slice(0, 8)}_${id}`;
    await client.query("update rollout_evaluations set twin_database = $2 where id = $1", [id, twin]);
    for (const [i, s] of STAGES.entries()) {
      await client.query("insert into rollout_stages (evaluation_id, ordinal, key, label, branch_ids, new_branch_ids, status) values ($1, $2, $3, $4, $5, $6, 'PENDING')", [id, i + 1, s.key, s.label, s.branchIds, s.newBranchIds]);
    }
    await client.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'rollout_evaluation.started', $3, $4)", [
      args.now, viewer.subject, `change:${args.changeId}`, { evaluationId: id, variant: args.variant, twinDatabase: twin, simulated: true },
    ]);
    await client.query("commit");
    return id;
  } catch (error) {
    await client.query("rollback");
    if ((error as { code?: string }).code === "23505") throw new ActionError("An evaluation of this change is already running", 409);
    throw error;
  } finally {
    client.release();
  }
}
