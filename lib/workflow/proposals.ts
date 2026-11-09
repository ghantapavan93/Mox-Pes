import type { Pool, PoolClient } from "pg";
import { ActionError } from "@/lib/actions";
import { getNow, withRollback, withTransaction, type Queryable } from "@/lib/db";
import { recordEvent } from "@/lib/events/outbox";
import { getException, type ExceptionRow } from "@/lib/queries";
import { lockReconcile, reconcile } from "@/lib/reconcile/reconcile";
import { ForbiddenError, ROLES, VIEWERS, canSeeBranch, requirePermission, type Role, type Viewer } from "@/lib/viewer";
import {
  LIVE_PROPOSAL_STATUSES,
  applyTransitions,
  ensureCaseForException,
  lockCase,
  recordCaseEvent,
  supersedeLiveProposals,
  transitionCase,
  type CaseRow,
  type TransitionRequest,
} from "./cases";
import { payloadHash } from "@/lib/primitives";
import { bindKind, preconditionFingerprint, type BoundKind, type ProposalKind } from "./kinds";
import { captureState, verify, type StateSnapshot, type Verification } from "./snapshot";
import { MANUAL_CLOSE_STATES, canTransition, type CaseState, type ManualCloseState } from "./states";

/**
 * The Action Center application service: proposals and their lifecycle.
 *
 *   createProposal → dryRunProposal → approveProposal | rejectProposal → executeProposal
 *
 * Separation of duties (lib/viewer.ts): a role with `propose` proposes, a role with `dryRun`
 * dry-runs, a role with `approve` approves — never the proposer's role — and the application
 * executes on the approver's behalf. An AI-sourced proposal is stored and processed exactly
 * like a human one; its source is a label, never a shortcut.
 *
 * Every function checks permission and branch scope on the server, and every state change
 * writes a case event and an audit row in the same transaction as the change.
 */

export type ProposalStatus =
  | "draft"
  | "dry_run_failed"
  | "dry_run_ok"
  | "approved"
  | "stale"
  | "rejected"
  | "superseded"
  | "executed"
  | "failed";

export interface DryRunRecord {
  ok: boolean;
  at: string;
  by: string;
  fingerprint: string | null;
  before: StateSnapshot | null;
  after: StateSnapshot | null;
  verification: Verification | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

export interface ProposalRow {
  id: number;
  caseId: number;
  exceptionId: number;
  kind: ProposalKind;
  params: Record<string, unknown>;
  rationale: string;
  source: "human" | "ai";
  proposedBy: string;
  proposedRole: string;
  status: ProposalStatus;
  createdAt: Date;
  updatedAt: Date;
  dryRun: DryRunRecord | null;
  dryRunAt: Date | null;
  dryRunBy: string | null;
  preconditionFingerprint: string | null;
}

export const toProposal = (r: Record<string, unknown>): ProposalRow => ({
  id: Number(r.id),
  caseId: Number(r.case_id),
  exceptionId: Number(r.exception_id),
  kind: r.kind as ProposalKind,
  params: r.params as Record<string, unknown>,
  rationale: r.rationale as string,
  source: r.source as "human" | "ai",
  proposedBy: r.proposed_by as string,
  proposedRole: r.proposed_role as string,
  status: r.status as ProposalStatus,
  createdAt: r.created_at as Date,
  updatedAt: r.updated_at as Date,
  dryRun: (r.dry_run as DryRunRecord | null) ?? null,
  dryRunAt: (r.dry_run_at as Date | null) ?? null,
  dryRunBy: (r.dry_run_by as string | null) ?? null,
  preconditionFingerprint: (r.precondition_fingerprint as string | null) ?? null,
});

export interface ExecutionRecord {
  id: number;
  proposalId: number;
  idempotencyKey: string;
  requestFingerprint: string;
  actor: string;
  status: "succeeded" | "failed";
  before: StateSnapshot | null;
  after: StateSnapshot | null;
  verification: Verification | null;
  result: Record<string, unknown> | null;
  error: string | null;
  startedAt: Date;
  finishedAt: Date;
}

export const toExecution = (r: Record<string, unknown>): ExecutionRecord => ({
  id: Number(r.id),
  proposalId: Number(r.proposal_id),
  idempotencyKey: r.idempotency_key as string,
  requestFingerprint: r.request_fingerprint as string,
  actor: r.actor as string,
  status: r.status as "succeeded" | "failed",
  before: (r.before as StateSnapshot | null) ?? null,
  after: (r.after as StateSnapshot | null) ?? null,
  verification: (r.verification as Verification | null) ?? null,
  result: (r.result as Record<string, unknown> | null) ?? null,
  error: (r.error as string | null) ?? null,
  startedAt: r.started_at as Date,
  finishedAt: r.finished_at as Date,
});

export interface ExecuteResult {
  /** true when this proposal had already been executed: the stored execution is returned. */
  alreadyProcessed: boolean;
  execution: ExecutionRecord;
}

/** The application identity that performs executions. */
export const APP_ACTOR = "revenue-signal-app";
export const onBehalfOf = (approver: string) => `${APP_ACTOR} on behalf of ${approver}`;

const notFound = () => new ActionError("Exception not found", 404);
const proposalNotFound = () => new ActionError("Proposal not found", 404);

async function exceptionInScope(db: Queryable, viewer: Viewer, exceptionId: number): Promise<ExceptionRow> {
  const exception = await getException(db, exceptionId);
  // Out of scope is indistinguishable from missing, as on every other route.
  if (!exception || !canSeeBranch(viewer, exception.branchId)) throw notFound();
  return exception;
}

async function lockProposal(tx: Queryable, viewer: Viewer, proposalId: number): Promise<{ proposal: ProposalRow; exception: ExceptionRow }> {
  const { rows } = await tx.query("select * from action_proposals where id = $1 for update", [proposalId]);
  if (!rows[0]) throw proposalNotFound();
  const proposal = toProposal(rows[0]);
  const exception = await getException(tx, proposal.exceptionId);
  if (!exception || !canSeeBranch(viewer, exception.branchId)) throw proposalNotFound();
  return { proposal, exception };
}

async function setProposalStatus(tx: Queryable, proposalId: number, status: ProposalStatus, now: Date): Promise<void> {
  await tx.query("update action_proposals set status = $2, updated_at = $3 where id = $1", [proposalId, status, now]);
}

// ── create ───────────────────────────────────────────────────────────────────

export interface CreateProposalInput {
  exceptionId: number;
  kind: string;
  params: unknown;
  rationale: string;
  source: "human" | "ai";
  actor: Viewer;
  /** Business clock; defaults to app_clock. */
  now?: Date;
}

/**
 * Records a proposed fix for one exception. The kind must apply to the exception's kind and
 * its params must pass the kind's schema and evidence checks. A case has at most one live
 * proposal: a new one supersedes the previous one (and any dry run or approval it had).
 */
export async function createProposal(pool: Pool, input: CreateProposalInput): Promise<ProposalRow> {
  requirePermission(input.actor, "propose", "create proposals");
  const rationale = input.rationale.trim();
  if (rationale.length < 10) throw new ActionError("A rationale of at least 10 characters is required", 400);
  if (input.source !== "human" && input.source !== "ai") throw new ActionError("source must be human or ai", 400);

  return withTransaction(pool, async (tx) => {
    // Same lock order as reconcile (advisory lock, then rows), which also creates cases.
    await lockReconcile(tx);
    const now = input.now ?? (await getNow(tx));
    const exception = await exceptionInScope(tx, input.actor, input.exceptionId);
    if (exception.status !== "open") throw new ActionError(`The exception is ${exception.status}; there is nothing to fix`, 409);
    const bound = bindKind(input.kind, exception, input.params);
    const kase = await ensureCaseForException(tx, exception.id, now);
    if (kase.state !== "proposed" && !canTransition(kase.state, "proposed")) {
      throw new ActionError(`A case that is ${kase.state} cannot take a new proposal`, 409);
    }
    const actor = input.actor.role;
    await supersedeLiveProposals(tx, [kase.id], actor, now, "Replaced by a newer proposal");
    const { rows } = await tx.query(
      `insert into action_proposals (case_id, exception_id, kind, params, rationale, source, proposed_by, proposed_role, status, created_at, updated_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, 'draft', $9, $9) returning *`,
      [kase.id, exception.id, bound.kind, bound.params, rationale, input.source, actor, input.actor.role, now],
    );
    const proposal = toProposal(rows[0]);
    await recordCaseEvent(tx, {
      caseId: kase.id,
      event: "proposal_created",
      auditAction: "proposal_create",
      actor,
      now,
      proposalId: proposal.id,
      detail: { kind: bound.kind, params: bound.params, source: input.source, rationale },
    });
    if (kase.state !== "proposed") {
      await transitionCase(tx, { caseId: kase.id, from: kase.state, to: "proposed", reason: `${bound.label} proposed`, proposalId: proposal.id }, actor, now);
    }
    return proposal;
  });
}

// ── dry run ──────────────────────────────────────────────────────────────────

const DRY_RUNNABLE: ProposalStatus[] = ["draft", "dry_run_failed", "dry_run_ok", "stale", "approved"];

interface Measured {
  ok: boolean;
  fingerprint: string | null;
  before: StateSnapshot | null;
  after: StateSnapshot | null;
  verification: Verification | null;
  result: Record<string, unknown> | null;
  error: string | null;
}

/**
 * Runs the proposal's executor, reconciliation and verification inside a transaction that is
 * ALWAYS rolled back, then records what it saw: before/after snapshots, the verification,
 * and the precondition fingerprint the execution will be checked against. Nothing the
 * executor did survives. A successful dry run moves the case to dry_run_verified and on to
 * awaiting_approval; a new dry run of an approved proposal withdraws that approval (an
 * approval covers one dry run).
 */
export async function dryRunProposal(pool: Pool, input: { proposalId: number; actor: Viewer; now?: Date }): Promise<ProposalRow> {
  requirePermission(input.actor, "dryRun", "dry-run proposals");
  const pre = await withTransaction(pool, async (tx) => {
    const { proposal } = await lockProposal(tx, input.actor, input.proposalId);
    if (!DRY_RUNNABLE.includes(proposal.status)) throw new ActionError(`A ${proposal.status} proposal cannot be dry-run`, 409);
    return { now: input.now ?? (await getNow(tx)) };
  });
  const now = pre.now;
  const actorLabel = `${APP_ACTOR} dry run for ${input.actor.role}`;

  const measured = await withRollback(pool, async (tx): Promise<Measured> => {
    await lockReconcile(tx);
    const { proposal, exception } = await lockProposal(tx, input.actor, input.proposalId);
    let bound: BoundKind;
    let fingerprint: string;
    let before: StateSnapshot;
    try {
      bound = bindKind(proposal.kind, exception, proposal.params);
      fingerprint = await preconditionFingerprint(tx, bound, exception);
      before = await captureState(tx, exception.id, bound.branchFor(exception));
    } catch (error) {
      if (error instanceof ActionError) return failedMeasure(error, null, null);
      throw error;
    }
    await tx.query("savepoint dry_run_executor");
    try {
      const result = await bound.execute({
        tx,
        exception,
        actor: actorLabel,
        reason: proposal.rationale,
        now,
        idempotencyKey: `dry-run-${proposal.id}-${fingerprint.slice(0, 24)}`,
      });
      await reconcile(tx, now);
      const after = await captureState(tx, exception.id, bound.branchFor(exception));
      const verification = verify(before, after, bound.expectedExceptionStatus(exception), bound.mayChange);
      return { ok: verification.ok, fingerprint, before, after, verification, result, error: verification.ok ? null : verification.problems.join("; ") };
    } catch (error) {
      await tx.query("rollback to savepoint dry_run_executor");
      return failedMeasure(error, fingerprint, before);
    }
  });

  return withTransaction(pool, async (tx) => {
    const { proposal } = await lockProposal(tx, input.actor, input.proposalId);
    if (!DRY_RUNNABLE.includes(proposal.status)) throw new ActionError(`The proposal became ${proposal.status} during the dry run`, 409);
    const actor = input.actor.role;
    const record: DryRunRecord = { ...measured, at: now.toISOString(), by: actor };
    const status: ProposalStatus = measured.ok ? "dry_run_ok" : "dry_run_failed";
    const { rows } = await tx.query(
      `update action_proposals set status = $2, dry_run = $3, dry_run_at = $4, dry_run_by = $5,
         precondition_fingerprint = $6, updated_at = $4 where id = $1 returning *`,
      [proposal.id, status, record, now, actor, measured.ok ? measured.fingerprint : null],
    );
    const kase = (await lockCase(tx, proposal.caseId))!;
    await recordCaseEvent(tx, {
      caseId: kase.id,
      event: "dry_run",
      auditAction: "proposal_dry_run",
      actor,
      now,
      proposalId: proposal.id,
      detail: {
        ok: measured.ok,
        fingerprint: measured.fingerprint,
        error: measured.error,
        withdrewApproval: proposal.status === "approved",
      },
    });
    const moves: TransitionRequest[] = [];
    if (measured.ok && kase.state === "proposed") {
      moves.push({ caseId: kase.id, from: "proposed", to: "dry_run_verified", reason: "Dry run verified", proposalId: proposal.id });
      moves.push({ caseId: kase.id, from: "dry_run_verified", to: "awaiting_approval", reason: "Submitted for approval", proposalId: proposal.id });
    } else if (!measured.ok && kase.state === "awaiting_approval") {
      moves.push({ caseId: kase.id, from: "awaiting_approval", to: "proposed", reason: "Dry run no longer verifies", proposalId: proposal.id });
    }
    // Applied one at a time: the second move starts from the state the first one produced.
    for (const move of moves) await transitionCase(tx, move, actor, now);
    return toProposal(rows[0]);
  });
}

function failedMeasure(error: unknown, fingerprint: string | null, before: StateSnapshot | null): Measured {
  return { ok: false, fingerprint, before, after: null, verification: null, result: null, error: (error as Error).message };
}

// ── approve / reject ─────────────────────────────────────────────────────────

function assertSeparateRole(viewer: Viewer, proposal: ProposalRow, verb: string) {
  if (viewer.role === proposal.proposedRole) {
    throw new ForbiddenError(
      `Separation of duties: this proposal was made by the ${proposal.proposedRole} role, so a different role must ${verb} it`,
    );
  }
}

/** Approves the latest successful dry run of a proposal (its fingerprint is recorded). */
export async function approveProposal(pool: Pool, input: { proposalId: number; actor: Viewer; reason: string; now?: Date }): Promise<ProposalRow> {
  requirePermission(input.actor, "approve", "approve proposals");
  const reason = input.reason.trim();
  if (reason.length < 5) throw new ActionError("An approval reason of at least 5 characters is required", 400);
  return withTransaction(pool, async (tx) => {
    const { proposal } = await lockProposal(tx, input.actor, input.proposalId);
    assertSeparateRole(input.actor, proposal, "approve");
    if (proposal.status !== "dry_run_ok" || !proposal.preconditionFingerprint) {
      throw new ActionError(`Only a proposal with a successful dry run can be approved (this one is ${proposal.status})`, 409);
    }
    const now = input.now ?? (await getNow(tx));
    const kase = (await lockCase(tx, proposal.caseId))!;
    if (kase.state !== "awaiting_approval") throw new ActionError(`The case is ${kase.state}, not awaiting approval`, 409);
    await tx.query(
      `insert into action_approvals (proposal_id, decision, actor, role, reason, precondition_fingerprint, decided_at)
       values ($1, 'approved', $2, $3, $4, $5, $6)`,
      [proposal.id, input.actor.role, input.actor.role, reason, proposal.preconditionFingerprint, now],
    );
    await setProposalStatus(tx, proposal.id, "approved", now);
    await recordCaseEvent(tx, {
      caseId: kase.id,
      event: "approval",
      auditAction: "proposal_approve",
      actor: input.actor.role,
      now,
      proposalId: proposal.id,
      detail: { reason, fingerprint: proposal.preconditionFingerprint, proposedBy: proposal.proposedRole, source: proposal.source },
    });
    return { ...proposal, status: "approved", updatedAt: now };
  });
}

/** Rejects a live proposal with a reason; the case goes back to investigating. */
export async function rejectProposal(pool: Pool, input: { proposalId: number; actor: Viewer; reason: string; now?: Date }): Promise<ProposalRow> {
  requirePermission(input.actor, "approve", "reject proposals");
  const reason = input.reason.trim();
  if (reason.length < 5) throw new ActionError("A rejection reason of at least 5 characters is required", 400);
  return withTransaction(pool, async (tx) => {
    const { proposal } = await lockProposal(tx, input.actor, input.proposalId);
    assertSeparateRole(input.actor, proposal, "reject");
    if (!(LIVE_PROPOSAL_STATUSES as readonly string[]).includes(proposal.status)) {
      throw new ActionError(`A ${proposal.status} proposal cannot be rejected`, 409);
    }
    const now = input.now ?? (await getNow(tx));
    const kase = (await lockCase(tx, proposal.caseId))!;
    await tx.query(
      `insert into action_approvals (proposal_id, decision, actor, role, reason, precondition_fingerprint, decided_at)
       values ($1, 'rejected', $2, $3, $4, $5, $6)`,
      [proposal.id, input.actor.role, input.actor.role, reason, proposal.preconditionFingerprint, now],
    );
    await setProposalStatus(tx, proposal.id, "rejected", now);
    await recordCaseEvent(tx, {
      caseId: kase.id,
      event: "rejection",
      auditAction: "proposal_reject",
      actor: input.actor.role,
      now,
      proposalId: proposal.id,
      detail: { reason, proposedBy: proposal.proposedRole, source: proposal.source },
    });
    if (canTransition(kase.state, "investigating")) {
      await transitionCase(tx, { caseId: kase.id, from: kase.state, to: "investigating", reason: `Proposal rejected: ${reason}`, proposalId: proposal.id }, input.actor.role, now);
    }
    return { ...proposal, status: "rejected", updatedAt: now };
  });
}

// ── execute ──────────────────────────────────────────────────────────────────

async function storedExecution(db: Queryable, proposalId: number): Promise<ExecutionRecord | null> {
  const { rows } = await db.query("select * from action_executions where proposal_id = $1", [proposalId]);
  return rows[0] ? toExecution(rows[0]) : null;
}

type ExecuteOutcome = { kind: "done"; result: ExecuteResult } | { kind: "stale" };

/**
 * Applies an approved proposal, once.
 *
 *   * Serialised with reconciliation (advisory lock) and with itself (proposal row lock);
 *     a repeated or concurrent request for the same proposal returns the stored execution.
 *   * The precondition fingerprint is recomputed under the lock. If the records changed
 *     since the dry run that was approved, nothing runs: the proposal goes stale and needs a
 *     new dry run and a new approval.
 *   * Executor + reconciliation + verification + case moves (applied → verified → resolved)
 *     run inside a savepoint. Any error, or a verification that fails, rolls the savepoint
 *     back completely; the failure itself (execution row, proposal failed, case failed) is
 *     then committed in the same transaction, still under the lock, so no concurrent
 *     request can slip in between the rollback and the failure record.
 */
export async function executeProposal(pool: Pool, input: { proposalId: number; actor: Viewer; now?: Date }): Promise<ExecuteResult> {
  requirePermission(input.actor, "approve", "execute approved proposals");

  const outcome = await withTransaction(pool, async (tx): Promise<ExecuteOutcome> => {
    await lockReconcile(tx);
    const { proposal, exception } = await lockProposal(tx, input.actor, input.proposalId);
    const existing = await storedExecution(tx, proposal.id);
    if (existing) return { kind: "done", result: { alreadyProcessed: true, execution: existing } };
    if (proposal.status === "stale") throw new ActionError("The dry run is stale: run a new dry run and get it approved", 409);
    if (proposal.status !== "approved") throw new ActionError(`Only an approved proposal can be executed (this one is ${proposal.status})`, 409);

    const approval = (
      await tx.query<{ actor: string; precondition_fingerprint: string | null }>(
        "select actor, precondition_fingerprint from action_approvals where proposal_id = $1 and decision = 'approved' order by id desc limit 1",
        [proposal.id],
      )
    ).rows[0];
    if (!approval || approval.precondition_fingerprint !== proposal.preconditionFingerprint) {
      throw new ActionError("The approval does not cover the latest dry run", 409);
    }
    const now = input.now ?? (await getNow(tx));
    const kase = (await lockCase(tx, proposal.caseId))!;
    if (kase.state !== "awaiting_approval") throw new ActionError(`The case is ${kase.state}, not awaiting approval`, 409);
    const bound = bindKind(proposal.kind, exception, proposal.params);
    const fingerprint = await preconditionFingerprint(tx, bound, exception);

    if (fingerprint !== proposal.preconditionFingerprint) {
      await setProposalStatus(tx, proposal.id, "stale", now);
      await recordCaseEvent(tx, {
        caseId: kase.id,
        event: "execution_refused",
        auditAction: "proposal_execute_refused",
        actor: input.actor.role,
        now,
        proposalId: proposal.id,
        detail: { reason: "stale_dry_run", approvedFingerprint: proposal.preconditionFingerprint, currentFingerprint: fingerprint },
      });
      if (kase.state === "awaiting_approval") {
        await transitionCase(tx, { caseId: kase.id, from: kase.state, to: "proposed", reason: "Records changed since the approved dry run", proposalId: proposal.id }, input.actor.role, now);
      }
      return { kind: "stale" };
    }

    const appActor = onBehalfOf(approval.actor);
    const idempotencyKey = `proposal-${proposal.id}-${fingerprint.slice(0, 32)}`;
    const requestFingerprint = payloadHash({ proposalId: proposal.id, kind: proposal.kind, params: proposal.params, exceptionId: exception.id, precondition: fingerprint });
    const branchId = bound.branchFor(exception);
    const before = await captureState(tx, exception.id, branchId);
    let after: StateSnapshot | null = null;
    let verification: Verification | null = null;

    await tx.query("savepoint execute_proposal");
    try {
      await transitionCase(tx, { caseId: kase.id, from: "awaiting_approval", to: "applied", reason: bound.label, proposalId: proposal.id }, appActor, now);
      const result = await bound.execute({ tx, exception, actor: appActor, reason: proposal.rationale, now, idempotencyKey });
      await reconcile(tx, now);
      after = await captureState(tx, exception.id, branchId);
      verification = verify(before, after, bound.expectedExceptionStatus(exception), bound.mayChange);
      if (!verification.ok) throw new ActionError(`Verification failed: ${verification.problems.join("; ")}`, 409);

      const finalState: CaseState | null =
        after.exception.status === "resolved" ? "resolved" : after.exception.status === "acknowledged" ? "closed_acknowledged" : null;
      await applyFinalMoves(tx, kase, finalState, proposal.id, appActor, now);
      const execution = await insertExecution(tx, {
        proposalId: proposal.id, idempotencyKey, requestFingerprint, actor: appActor, status: "succeeded",
        before, after, verification, result, error: null, now,
      });
      await setProposalStatus(tx, proposal.id, "executed", now);
      await recordCaseEvent(tx, {
        caseId: kase.id, event: "execution", auditAction: "proposal_execute", actor: appActor, now, proposalId: proposal.id,
        detail: { status: "succeeded", executionId: execution.id, idempotencyKey, result, verified: true, finalState },
      });
      await recordEvent(tx, {
        type: "action_center.proposal_executed",
        subject: `proposal:${proposal.id}`,
        occurredAt: now,
        payload: { kind: proposal.kind, caseId: kase.id, exceptionId: exception.id, executionId: execution.id, finalState, source: proposal.source },
      });
      await tx.query("release savepoint execute_proposal");
      return { kind: "done", result: { alreadyProcessed: false, execution } };
    } catch (error) {
      await tx.query("rollback to savepoint execute_proposal");
      const message = (error as Error).message;
      const execution = await insertExecution(tx, {
        proposalId: proposal.id, idempotencyKey, requestFingerprint, actor: appActor, status: "failed",
        before, after, verification, result: null, error: message, now,
      });
      await setProposalStatus(tx, proposal.id, "failed", now);
      await recordCaseEvent(tx, {
        caseId: kase.id, event: "execution", auditAction: "proposal_execute", actor: appActor, now, proposalId: proposal.id,
        detail: { status: "failed", executionId: execution.id, idempotencyKey, error: message, rolledBack: true },
      });
      if (canTransition(kase.state, "failed")) {
        await transitionCase(tx, { caseId: kase.id, from: kase.state, to: "failed", reason: message, proposalId: proposal.id }, appActor, now);
      }
      return { kind: "done", result: { alreadyProcessed: false, execution } };
    }
  });

  if (outcome.kind === "stale") {
    throw new ActionError("The records changed since the approved dry run. Nothing was executed: run a new dry run and get it approved.", 409);
  }
  return outcome.result;
}

/** applied → verified, then on to the final state when the exception already shows it. */
async function applyFinalMoves(tx: Queryable, kase: CaseRow, finalState: CaseState | null, proposalId: number, actor: string, now: Date) {
  await transitionCase(tx, { caseId: kase.id, from: "applied", to: "verified", reason: "Exception and ledger verified after reconciliation", proposalId }, actor, now);
  if (finalState) {
    await transitionCase(tx, { caseId: kase.id, from: "verified", to: finalState, reason: "Verified fix closed the exception", proposalId }, actor, now);
  }
}

async function insertExecution(
  tx: Queryable,
  e: {
    proposalId: number; idempotencyKey: string; requestFingerprint: string; actor: string; status: "succeeded" | "failed";
    before: StateSnapshot | null; after: StateSnapshot | null; verification: Verification | null;
    result: Record<string, unknown> | null; error: string | null; now: Date;
  },
): Promise<ExecutionRecord> {
  const { rows } = await tx.query(
    `insert into action_executions (proposal_id, idempotency_key, request_fingerprint, actor, status, before, after, verification,
       result, error, started_at, finished_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $11) returning *`,
    [e.proposalId, e.idempotencyKey, e.requestFingerprint, e.actor, e.status, e.before, e.after, e.verification, e.result, e.error, e.now],
  );
  return toExecution(rows[0]);
}

// ── case ownership and manual closure ───────────────────────────────────────

/** Roles that can own a case: those that can propose, dry-run or approve. */
export const OWNER_ROLES: Role[] = ROLES.filter((r) => VIEWERS[r].can.propose || VIEWERS[r].can.dryRun || VIEWERS[r].can.approve);

async function lockCaseInScope(tx: PoolClient, viewer: Viewer, caseId: number): Promise<CaseRow> {
  await lockReconcile(tx);
  const kase = await lockCase(tx, caseId);
  if (!kase) throw new ActionError("Case not found", 404);
  const { rows } = await tx.query<{ branch_id: string | null }>("select branch_id from exceptions where id = $1", [kase.exceptionId]);
  if (!canSeeBranch(viewer, rows[0]?.branch_id ?? null)) throw new ActionError("Case not found", 404);
  return kase;
}

/**
 * Assigns (or clears) the role that owns the next step. Taking ownership of a freshly
 * detected case starts the investigation (detected → investigating).
 */
export async function assignCaseOwner(pool: Pool, input: { caseId: number; owner: Role | null; actor: Viewer; now?: Date }): Promise<CaseRow> {
  requirePermission(input.actor, "propose", "assign case owners");
  if (input.owner !== null && !OWNER_ROLES.includes(input.owner)) throw new ActionError(`${input.owner} cannot own a case`, 400);
  return withTransaction(pool, async (tx) => {
    const kase = await lockCaseInScope(tx, input.actor, input.caseId);
    const now = input.now ?? (await getNow(tx));
    await tx.query("update cases set owner = $2, updated_at = $3 where id = $1", [kase.id, input.owner, now]);
    await recordCaseEvent(tx, {
      caseId: kase.id, event: "owner_assigned", auditAction: "case_assign", actor: input.actor.role, now,
      detail: { from: kase.owner, to: input.owner },
    });
    let state = kase.state;
    if (input.owner && kase.state === "detected") {
      await transitionCase(tx, { caseId: kase.id, from: "detected", to: "investigating", reason: `Owned by ${input.owner}` }, input.actor.role, now);
      state = "investigating";
    }
    return { ...kase, owner: input.owner, state, updatedAt: now };
  });
}

/**
 * Closes a case without a fix: opened by mistake (cancelled), cannot be fixed from here
 * (closed_unresolvable) or not enough evidence to act (closed_insufficient_evidence). A
 * reason is required and any live proposal is superseded.
 */
export async function closeCase(
  pool: Pool,
  input: { caseId: number; outcome: ManualCloseState; reason: string; actor: Viewer; now?: Date },
): Promise<CaseRow> {
  requirePermission(input.actor, "decide", "close cases");
  if (!(MANUAL_CLOSE_STATES as readonly string[]).includes(input.outcome)) throw new ActionError(`${input.outcome} is not a manual close`, 400);
  const reason = input.reason.trim();
  if (reason.length < 10) throw new ActionError("A reason of at least 10 characters is required", 400);
  return withTransaction(pool, async (tx) => {
    const kase = await lockCaseInScope(tx, input.actor, input.caseId);
    const now = input.now ?? (await getNow(tx));
    await supersedeLiveProposals(tx, [kase.id], input.actor.role, now, `Case closed: ${reason}`);
    await applyTransitions(tx, [{ caseId: kase.id, from: kase.state, to: input.outcome, reason }], input.actor.role, now);
    return { ...kase, state: input.outcome, updatedAt: now, closedAt: now };
  });
}
