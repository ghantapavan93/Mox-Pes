import { ActionError } from "@/lib/actions";

/**
 * The case state machine. One case per exception; this table is the only definition of
 * which moves are legal. The database stores the state, the API and the queue read it, and
 * every move goes through `assertTransition`, so an illegal move throws instead of
 * silently rewriting history.
 *
 *   detected → investigating → proposed → dry_run_verified → awaiting_approval → applied → verified → resolved
 *
 * plus the side exits:
 *   * failed — an execution failed (rolled back); a new proposal can follow;
 *   * cancelled — the case was opened by mistake or duplicates another;
 *   * closed_acknowledged — a person accepted a condition that will not change;
 *   * closed_unresolvable / closed_insufficient_evidence — closed by a person with a reason
 *     while the exception may still be open.
 *
 * Reconciliation has the last word on whether the data agrees: when an exception clears on
 * its own (a late invoice arrives) any open case resolves; when it re-appears, a resolved
 * case re-opens (detected, reopen_count + 1).
 *
 * Import note: lib/reconcile imports the sync half of the workflow, and lib/actions imports
 * lib/reconcile. This module therefore only USES ActionError at call time and never extends
 * it at load time, so the import cycle cannot observe an uninitialised class.
 */

export const CASE_STATES = [
  "detected",
  "investigating",
  "proposed",
  "dry_run_verified",
  "awaiting_approval",
  "applied",
  "verified",
  "resolved",
  "failed",
  "cancelled",
  "closed_acknowledged",
  "closed_unresolvable",
  "closed_insufficient_evidence",
] as const;

export type CaseState = (typeof CASE_STATES)[number];

/** Closed by a person with a reason; never by the system. */
export const MANUAL_CLOSE_STATES = ["cancelled", "closed_unresolvable", "closed_insufficient_evidence"] as const;
export type ManualCloseState = (typeof MANUAL_CLOSE_STATES)[number];

const MANUAL_EXITS: CaseState[] = ["closed_acknowledged", ...MANUAL_CLOSE_STATES];

/** from → legal targets. */
export const TRANSITIONS: Readonly<Record<CaseState, readonly CaseState[]>> = {
  detected: ["investigating", "proposed", "resolved", ...MANUAL_EXITS],
  investigating: ["proposed", "resolved", ...MANUAL_EXITS],
  proposed: ["dry_run_verified", "investigating", "resolved", ...MANUAL_EXITS],
  dry_run_verified: ["awaiting_approval", "proposed", "resolved", ...MANUAL_EXITS],
  // proposed: the dry run went stale or a new proposal replaced this one;
  // investigating: the proposal was rejected.
  awaiting_approval: ["applied", "failed", "proposed", "investigating", "resolved", ...MANUAL_EXITS],
  // applied and verified happen inside the execution transaction; a failure there is rolled
  // back as a whole, so the case moves awaiting_approval → failed, never applied → failed.
  applied: ["verified"],
  // verified → (stays) when the action's effect is asynchronous (a sync job was queued):
  // reconciliation resolves it once the data agrees.
  verified: ["resolved", "closed_acknowledged"],
  failed: ["investigating", "proposed", "resolved", ...MANUAL_EXITS],
  resolved: ["detected"],
  // the acknowledged condition cleared (→ resolved) or the exception re-opened (→ detected)
  closed_acknowledged: ["resolved", "detected"],
  closed_unresolvable: ["resolved"],
  closed_insufficient_evidence: ["resolved"],
  cancelled: [],
};

/** States in which a case still needs someone (not closed, not mid-execution). */
export const ACTIVE_STATES: readonly CaseState[] = ["detected", "investigating", "proposed", "dry_run_verified", "awaiting_approval", "failed", "verified"];

/** States that set closed_at. */
export const CLOSED_STATES: readonly CaseState[] = ["resolved", "cancelled", "closed_acknowledged", "closed_unresolvable", "closed_insufficient_evidence"];

export function isCaseState(value: string): value is CaseState {
  return (CASE_STATES as readonly string[]).includes(value);
}

export function canTransition(from: CaseState, to: CaseState): boolean {
  return TRANSITIONS[from].includes(to);
}

/** Throws a 409 ActionError naming both states when the move is not in the table. */
export function assertTransition(from: CaseState, to: CaseState): void {
  if (!canTransition(from, to)) {
    throw new ActionError(`Illegal case transition ${from} → ${to}`, 409);
  }
}

/** Every state that may move to `to` (used to build set-based updates from the same table). */
export function statesThatReach(to: CaseState): CaseState[] {
  return CASE_STATES.filter((from) => canTransition(from, to));
}

export const STATE_LABEL: Record<CaseState, string> = {
  detected: "Detected",
  investigating: "Investigating",
  proposed: "Proposed",
  dry_run_verified: "Dry run verified",
  awaiting_approval: "Awaiting approval",
  applied: "Applied",
  verified: "Verified",
  resolved: "Resolved",
  failed: "Failed",
  cancelled: "Cancelled",
  closed_acknowledged: "Closed · acknowledged",
  closed_unresolvable: "Closed · unresolvable",
  closed_insufficient_evidence: "Closed · insufficient evidence",
};

/** Status semantics shared by every badge: needs attention = warn, broken = bad, done = good. */
export const STATE_TONE: Record<CaseState, "good" | "warn" | "bad" | "neutral" | "accent"> = {
  detected: "warn",
  investigating: "warn",
  proposed: "accent",
  dry_run_verified: "accent",
  awaiting_approval: "accent",
  applied: "accent",
  verified: "good",
  resolved: "good",
  failed: "bad",
  cancelled: "neutral",
  closed_acknowledged: "good",
  closed_unresolvable: "neutral",
  closed_insufficient_evidence: "neutral",
};
