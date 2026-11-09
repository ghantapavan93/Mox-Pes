import { ActionError } from "@/lib/actions";
import type { Queryable } from "@/lib/db";
import { lockReconcile } from "@/lib/reconcile/reconcile";
import { CLOSED_STATES, assertTransition, canTransition, type CaseState } from "./states";

/**
 * Case bookkeeping: the one place that changes `cases.state`, appends `case_events`, and
 * writes the matching `audit_log` rows. Every write happens inside a transaction the caller
 * owns, so a transition commits or rolls back together with the work that caused it.
 *
 * Audit completeness is structural: a case event and its audit row are written by the same
 * statement, and the audit row's detail carries the event id (`eventId`).
 *
 * Kept free of zod, pg pools and the proposal executors because lib/reconcile imports
 * `syncCases` from here (see the import note in ./states).
 */

export interface CaseRow {
  id: number;
  exceptionId: number;
  state: CaseState;
  owner: string | null;
  reopenCount: number;
  openedAt: Date;
  updatedAt: Date;
  closedAt: Date | null;
}

export const toCase = (r: Record<string, unknown>): CaseRow => ({
  id: Number(r.id),
  exceptionId: Number(r.exception_id),
  state: r.state as CaseState,
  owner: (r.owner as string | null) ?? null,
  reopenCount: Number(r.reopen_count),
  openedAt: r.opened_at as Date,
  updatedAt: r.updated_at as Date,
  closedAt: (r.closed_at as Date | null) ?? null,
});

/** Proposal statuses that still need a decision or an execution. At most one per case. */
export const LIVE_PROPOSAL_STATUSES = ["draft", "dry_run_failed", "dry_run_ok", "approved", "stale"] as const;

export interface TransitionRequest {
  caseId: number;
  /** The state the caller saw (and locked). The update only applies if it still holds. */
  from: CaseState;
  to: CaseState;
  reason: string;
  proposalId?: number | null;
  detail?: Record<string, unknown>;
}

/**
 * Applies transitions in one statement: state update, case event, audit row. Each move is
 * checked against the transition table first (illegal → 409, nothing written). A row whose
 * state is no longer `from` means someone else moved the case: the whole call fails with
 * 409 and the caller's transaction rolls back.
 */
export async function applyTransitions(tx: Queryable, items: TransitionRequest[], actor: string, now: Date): Promise<number[]> {
  for (const item of items) assertTransition(item.from, item.to);
  if (items.length === 0) return [];
  const { rows } = await tx.query<{ id: string }>(
    `with t as (
       select * from unnest($1::bigint[], $2::text[], $3::text[], $4::text[], $5::bigint[], $6::text[])
         as t(case_id, from_state, to_state, reason, proposal_id, detail)),
     upd as (
       update cases c set state = t.to_state, updated_at = $7::timestamptz,
         closed_at = case when t.to_state = any($9::text[]) then $7::timestamptz else null end,
         reopen_count = c.reopen_count + case when t.to_state = 'detected' then 1 else 0 end
       from t where c.id = t.case_id and c.state = t.from_state
       returning c.id, t.from_state, t.to_state, t.reason, t.proposal_id, t.detail),
     ev as (
       insert into case_events (case_id, at, actor, event, from_state, to_state, proposal_id, detail)
       select u.id, $7::timestamptz, $8::text, 'transition', u.from_state, u.to_state, u.proposal_id,
              u.detail::jsonb || jsonb_build_object('reason', u.reason)
       from upd u order by u.id
       returning id, case_id, from_state, to_state, proposal_id, detail),
     au as (
       insert into audit_log (at, actor, action, subject, detail)
       select $7::timestamptz, $8::text, 'case_transition', 'case:' || ev.case_id,
              ev.detail || jsonb_build_object('eventId', ev.id, 'from', ev.from_state, 'to', ev.to_state, 'proposalId', ev.proposal_id)
       from ev returning 1)
     select id from ev`,
    [
      items.map((i) => i.caseId),
      items.map((i) => i.from),
      items.map((i) => i.to),
      items.map((i) => i.reason),
      items.map((i) => i.proposalId ?? null),
      items.map((i) => JSON.stringify(i.detail ?? {})),
      now,
      actor,
      CLOSED_STATES,
    ],
  );
  if (rows.length !== items.length) {
    throw new ActionError("The case changed while this request was running. Reload and try again.", 409);
  }
  return rows.map((r) => Number(r.id));
}

/** Convenience for one move. */
export async function transitionCase(tx: Queryable, item: TransitionRequest, actor: string, now: Date): Promise<number> {
  const [eventId] = await applyTransitions(tx, [item], actor, now);
  return eventId;
}

export type CaseEventKind =
  | "owner_assigned"
  | "proposal_created"
  | "proposal_superseded"
  | "dry_run"
  | "approval"
  | "rejection"
  | "execution"
  | "execution_refused";

/** A non-transition event (with its audit row). `auditAction` names it in the audit log. */
export async function recordCaseEvent(
  tx: Queryable,
  e: { caseId: number; event: CaseEventKind; auditAction: string; actor: string; now: Date; proposalId?: number | null; detail?: Record<string, unknown> },
): Promise<number> {
  const { rows } = await tx.query<{ id: string }>(
    `with ev as (
       insert into case_events (case_id, at, actor, event, proposal_id, detail)
       values ($1, $2::timestamptz, $3::text, $4, $5, $6::jsonb) returning id, case_id, proposal_id, detail),
     au as (
       insert into audit_log (at, actor, action, subject, detail)
       select $2::timestamptz, $3::text, $7::text, 'case:' || ev.case_id, ev.detail || jsonb_build_object('eventId', ev.id, 'proposalId', ev.proposal_id)
       from ev returning 1)
     select id from ev`,
    [e.caseId, e.now, e.actor, e.event, e.proposalId ?? null, e.detail ?? {}, e.auditAction],
  );
  return Number(rows[0].id);
}

/** Locks and returns one case. */
export async function lockCase(tx: Queryable, caseId: number): Promise<CaseRow | null> {
  const { rows } = await tx.query("select * from cases where id = $1 for update", [caseId]);
  return rows[0] ? toCase(rows[0]) : null;
}

/**
 * Opens a case (state detected) for every exception that has none, or only for `exceptionIds`.
 * Creation is recorded as a transition from nothing to detected.
 */
export async function createMissingCases(tx: Queryable, now: Date, exceptionIds: number[] | null = null): Promise<number> {
  const { rows } = await tx.query<{ n: string }>(
    `with created as (
       insert into cases (exception_id, state, opened_at, updated_at)
       select e.id, 'detected', $1::timestamptz, $1::timestamptz from exceptions e
       where ($2::bigint[] is null or e.id = any($2::bigint[]))
         and not exists (select 1 from cases c where c.exception_id = e.id)
       order by e.id
       on conflict (exception_id) do nothing
       returning id, exception_id),
     ev as (
       insert into case_events (case_id, at, actor, event, from_state, to_state, detail)
       select id, $1::timestamptz, 'reconcile', 'transition', null, 'detected',
              jsonb_build_object('reason', 'Exception detected', 'exceptionId', exception_id)
       from created order by id
       returning id, case_id, to_state, detail),
     au as (
       insert into audit_log (at, actor, action, subject, detail)
       select $1::timestamptz, 'reconcile', 'case_transition', 'case:' || ev.case_id,
              ev.detail || jsonb_build_object('eventId', ev.id, 'from', null, 'to', ev.to_state)
       from ev returning 1)
     select count(*) as n from ev`,
    [now, exceptionIds],
  );
  return Number(rows[0].n);
}

/** The case for one exception, created (and locked) if the exception has none yet. */
export async function ensureCaseForException(tx: Queryable, exceptionId: number, now: Date): Promise<CaseRow> {
  await createMissingCases(tx, now, [exceptionId]);
  const { rows } = await tx.query("select * from cases where exception_id = $1 for update", [exceptionId]);
  if (!rows[0]) throw new ActionError("Exception not found", 404);
  return toCase(rows[0]);
}

/** Marks every live proposal of these cases superseded, with one event + audit row each. */
export async function supersedeLiveProposals(tx: Queryable, caseIds: number[], actor: string, now: Date, reason: string): Promise<number> {
  if (caseIds.length === 0) return 0;
  const { rows } = await tx.query<{ n: string }>(
    `with sup as (
       update action_proposals set status = 'superseded', updated_at = $2::timestamptz
       where case_id = any($1::bigint[]) and status = any($5::text[])
       returning id, case_id, status),
     ev as (
       insert into case_events (case_id, at, actor, event, proposal_id, detail)
       select case_id, $2::timestamptz, $3::text, 'proposal_superseded', id, jsonb_build_object('reason', $4::text)
       from sup order by id
       returning id, case_id, proposal_id, detail),
     au as (
       insert into audit_log (at, actor, action, subject, detail)
       select $2::timestamptz, $3::text, 'proposal_supersede', 'case:' || ev.case_id, ev.detail || jsonb_build_object('eventId', ev.id, 'proposalId', ev.proposal_id)
       from ev returning 1)
     select count(*) as n from ev`,
    [caseIds, now, actor, reason, LIVE_PROPOSAL_STATUSES],
  );
  return Number(rows[0].n);
}

export interface SyncCasesResult {
  created: number;
  resolved: number;
  acknowledged: number;
  reopened: number;
}

/**
 * Keeps cases in step with exceptions. Called at the end of every reconcile(), inside its
 * transaction and under its advisory lock:
 *   * every exception without a case gets one (detected);
 *   * an exception that resolved resolves its case, whatever step it was at — the data now
 *     agrees, so any live proposal is superseded rather than executed against nothing;
 *   * an exception a person acknowledged closes its case as acknowledged;
 *   * an exception that re-appeared re-opens a resolved case (detected, reopen_count + 1).
 *
 * A case in `applied` is mid-execution: the executor owns it and verifies it itself, so the
 * transition table (applied → verified only) keeps reconciliation's hands off it.
 */
export async function syncCases(tx: Queryable, now: Date): Promise<SyncCasesResult> {
  await lockReconcile(tx);
  const created = await createMissingCases(tx, now);
  const { rows } = await tx.query<{ id: string; state: CaseState; status: string; resolution: string | null }>(
    `select c.id, c.state, e.status, e.resolution
     from cases c join exceptions e on e.id = c.exception_id
     where (e.status = 'resolved' and c.state not in ('resolved', 'cancelled'))
        or (e.status = 'acknowledged' and c.state not in ('closed_acknowledged', 'resolved', 'cancelled'))
        or (e.status = 'open' and c.state in ('resolved', 'closed_acknowledged'))
     order by c.id
     for update of c`,
  );
  const items: TransitionRequest[] = [];
  for (const r of rows) {
    const from = r.state;
    const to: CaseState = r.status === "resolved" ? "resolved" : r.status === "acknowledged" ? "closed_acknowledged" : "detected";
    if (!canTransition(from, to)) continue;
    const reason =
      to === "detected" ? "Exception re-detected" : to === "resolved" ? (r.resolution ?? "Condition no longer detected") : (r.resolution ?? "Acknowledged");
    items.push({ caseId: Number(r.id), from, to, reason, detail: { source: "reconcile" } });
  }
  const closing = items.filter((i) => i.to !== "detected").map((i) => i.caseId);
  await supersedeLiveProposals(tx, closing, "reconcile", now, "The exception closed before this proposal was executed");
  await applyTransitions(tx, items, "reconcile", now);
  return {
    created,
    resolved: items.filter((i) => i.to === "resolved").length,
    acknowledged: items.filter((i) => i.to === "closed_acknowledged").length,
    reopened: items.filter((i) => i.to === "detected").length,
  };
}
