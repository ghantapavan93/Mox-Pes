import type { Pool } from "pg";
import { withTransaction, type Queryable } from "@/lib/db";
import { lockReconcile, reconcile } from "@/lib/reconcile/reconcile";

/**
 * Human decisions on exceptions. None of them writes to a source system: a decision is
 * recorded (overrides / campaign map), audited, and reconciliation re-runs so the
 * exception closes only if the rule is now actually satisfied.
 *
 * Each decision has two forms:
 *   * `xxxInTransaction(tx, args)` — the decision itself, run inside a transaction the caller
 *     owns. The Action Center executor uses these so a proposal's dry run (rolled back) and
 *     its execution (committed, with verification and case bookkeeping) run exactly the same
 *     code in one transaction;
 *   * `xxx(pool, args)` — the original entry point: the same core in its own transaction.
 */

export class ActionError extends Error {
  constructor(message: string, readonly status: 400 | 404 | 409) {
    super(message);
  }
}

export interface MapCampaignArgs {
  campaignId: number;
  branchId: string;
  actor: string;
  reason: string;
  now: Date;
}

export interface OverrideLeadBranchArgs {
  leadId: number;
  branchId: string;
  actor: string;
  reason: string;
  now: Date;
}

export interface ExceptionDecisionArgs {
  exceptionId: number;
  actor: string;
  reason: string;
  now: Date;
}

export async function mapCampaignToBranchInTransaction(tx: Queryable, args: MapCampaignArgs): Promise<void> {
  await lockReconcile(tx);
  const branch = await tx.query("select 1 from branches where id = $1", [args.branchId]);
  if (branch.rowCount === 0) throw new ActionError(`Unknown branch ${args.branchId}`, 400);
  const inserted = await tx.query(
    `insert into campaign_branch_map (campaign_id, branch_id, mapped_by, mapped_at)
     select id, $2, $3, $4 from ad_campaigns where id = $1
     on conflict (campaign_id) do nothing returning campaign_id`,
    [args.campaignId, args.branchId, args.actor, args.now],
  );
  if (inserted.rowCount === 0) throw new ActionError("Campaign not found or already mapped", 409);
  await tx.query(
    `update exceptions set resolution = $2 where fingerprint = $1 and status = 'open'`,
    [`unmapped_spend:campaign:${args.campaignId}`, `Mapped to ${args.branchId} by ${args.actor}: ${args.reason}`],
  );
  await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'map_campaign', $3, $4)", [
    args.now,
    args.actor,
    `campaign:${args.campaignId}`,
    { branchId: args.branchId, reason: args.reason },
  ]);
  await reconcile(tx, args.now);
}

export async function mapCampaignToBranch(pool: Pool, args: MapCampaignArgs): Promise<void> {
  await withTransaction(pool, (tx) => mapCampaignToBranchInTransaction(tx, args));
}

export async function overrideLeadBranchInTransaction(tx: Queryable, args: OverrideLeadBranchArgs): Promise<void> {
  await lockReconcile(tx);
  const lead = await tx.query<{ branch_id: string }>("select branch_id from leads where id = $1", [args.leadId]);
  if (lead.rowCount === 0) throw new ActionError(`Lead ${args.leadId} not found`, 404);
  const branch = await tx.query("select 1 from branches where id = $1", [args.branchId]);
  if (branch.rowCount === 0) throw new ActionError(`Unknown branch ${args.branchId}`, 400);
  await tx.query(
    `insert into overrides (subject_type, subject_id, field, value, reason, actor, created_at)
     values ('lead', $1, 'branch_id', $2, $3, $4, $5)
     on conflict (subject_type, subject_id, field) do update set value = excluded.value, reason = excluded.reason,
       actor = excluded.actor, created_at = excluded.created_at`,
    [String(args.leadId), args.branchId, args.reason, args.actor, args.now],
  );
  await tx.query(
    `update exceptions set resolution = $2 where fingerprint = $1 and status = 'open'`,
    [`branch_mismatch:lead:${args.leadId}`, `Lead branch ${lead.rows[0].branch_id} → ${args.branchId} by ${args.actor}: ${args.reason}`],
  );
  await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'override_lead_branch', $3, $4)", [
    args.now,
    args.actor,
    `lead:${args.leadId}`,
    { from: lead.rows[0].branch_id, to: args.branchId, reason: args.reason },
  ]);
  await reconcile(tx, args.now);
}

export async function overrideLeadBranch(pool: Pool, args: OverrideLeadBranchArgs): Promise<void> {
  await withTransaction(pool, (tx) => overrideLeadBranchInTransaction(tx, args));
}

/**
 * For conditions that are permanent history (a D2D rep signed a customer a paid ad reached
 * first): a person acknowledges the exception with a reason. It stays acknowledged while
 * the condition persists and no longer counts as open or at risk.
 */
export async function acknowledgeExceptionInTransaction(tx: Queryable, args: ExceptionDecisionArgs): Promise<void> {
  await lockReconcile(tx);
  const updated = await tx.query(
    `update exceptions set status = 'acknowledged', resolution = $2
     where id = $1 and status = 'open' and kind = 'channel_conflict' returning id`,
    [args.exceptionId, `Acknowledged by ${args.actor}: ${args.reason}`],
  );
  if (updated.rowCount === 0) throw new ActionError("Only open D2D/paid conflicts can be acknowledged", 409);
  await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'acknowledge_exception', $3, $4)", [
    args.now,
    args.actor,
    `exception:${args.exceptionId}`,
    { reason: args.reason },
  ]);
}

export async function acknowledgeException(pool: Pool, args: ExceptionDecisionArgs): Promise<void> {
  await withTransaction(pool, (tx) => acknowledgeExceptionInTransaction(tx, args));
}

/** Only for exceptions no detector owns (payload conflicts): a person closes them with a reason. */
export async function closeExceptionInTransaction(tx: Queryable, args: ExceptionDecisionArgs): Promise<void> {
  await lockReconcile(tx);
  const updated = await tx.query(
    `update exceptions set status = 'resolved', resolved_at = $2, resolution = $3
     where id = $1 and status = 'open' and kind = 'payload_conflict' returning id`,
    [args.exceptionId, args.now, `Closed by ${args.actor}: ${args.reason}`],
  );
  if (updated.rowCount === 0) throw new ActionError("Only open payload conflicts can be closed by hand", 409);
  await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'close_exception', $3, $4)", [
    args.now,
    args.actor,
    `exception:${args.exceptionId}`,
    { reason: args.reason },
  ]);
}

export async function closeException(pool: Pool, args: ExceptionDecisionArgs): Promise<void> {
  await withTransaction(pool, (tx) => closeExceptionInTransaction(tx, args));
}
