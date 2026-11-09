import type { Pool } from "pg";
import { ActionError } from "@/lib/actions";
import { withTransaction, type Queryable } from "@/lib/db";
import { resolveInTransaction, lockIdentity, type ResolveStats } from "./resolve";
import type { ConflictKind, ConflictStatus, IdentityRule } from "./types";

/**
 * Ambiguous identity matches and the human decisions on them.
 *
 * A conflict is one (lead, candidate CRM customer) pair. Accepting it links the lead to that
 * customer with rule `reviewer_accepted`; a lead is one person, so accepting one candidate also
 * rejects the lead's other pending candidates, in the same transaction and audit entry.
 * Rejecting says "this lead is not this customer"; once every candidate of a lead is rejected the
 * lead becomes a prospect. Every decision is bound to the evidence fingerprint it was made on.
 */

export interface IdentityConflict {
  id: number;
  kind: ConflictKind;
  status: ConflictStatus;
  pairKey: string;
  leadId: number;
  leadSource: string;
  leadSourceRecordId: string;
  leadBranchId: string | null;
  crmCustomerId: number;
  customerBranchId: string | null;
  evidence: {
    matchedOn: string[];
    candidateCount: number;
    candidates: Array<{ crmCustomerId: number; viaPhone: boolean; viaEmail: boolean }>;
    leadPhoneHash?: string | null;
    leadEmailHash?: string | null;
    customerPhoneHash?: string | null;
    customerEmailHash?: string | null;
  };
  evidenceFingerprint: string;
  detectedAt: string;
  decidedBy: string | null;
  decidedAt: string | null;
  decisionReason: string | null;
  supersedesId: number | null;
  priorDecision: { id: number; status: ConflictStatus; decidedBy: string | null; decidedAt: string | null; reason: string | null } | null;
}

export interface ConflictFilters {
  status?: ConflictStatus | "all";
  crmCustomerId?: number;
  leadIds?: number[];
  limit?: number;
  offset?: number;
}

const SELECT_CONFLICT = `
  select k.id, k.kind, k.status, k.pair_key, k.lead_id, k.crm_customer_id,
         k.left_record->>'source' as lead_source, k.left_record->>'sourceRecordId' as lead_source_record_id,
         k.left_record->>'branchId' as lead_branch_id, k.right_record->>'branchId' as customer_branch_id,
         k.evidence, k.evidence_fingerprint, k.detected_at, k.decided_by, k.decided_at, k.decision_reason,
         k.supersedes_id, k.branch_ids,
         p.id as prior_id, p.status as prior_status, p.decided_by as prior_decided_by, p.decided_at as prior_decided_at,
         p.decision_reason as prior_reason
  from identity_conflicts k
  left join identity_conflicts p on p.id = k.prior_decision_id`;

/**
 * A scoped viewer sees a conflict only when EVERY branch it involves is in scope: the lead's and
 * the candidate customer's. An unknown branch (null element) is visible to all-branch roles only.
 */
const SCOPE_SQL = (param: string) => `(${param}::text[] is null or k.branch_ids <@ ${param}::text[])`;

interface ConflictRow {
  id: string;
  kind: ConflictKind;
  status: ConflictStatus;
  pair_key: string;
  lead_id: string;
  crm_customer_id: string;
  lead_source: string;
  lead_source_record_id: string;
  lead_branch_id: string | null;
  customer_branch_id: string | null;
  evidence: IdentityConflict["evidence"];
  evidence_fingerprint: string;
  detected_at: Date;
  decided_by: string | null;
  decided_at: Date | null;
  decision_reason: string | null;
  supersedes_id: string | null;
  prior_id: string | null;
  prior_status: ConflictStatus | null;
  prior_decided_by: string | null;
  prior_decided_at: Date | null;
  prior_reason: string | null;
}

function toConflict(r: ConflictRow): IdentityConflict {
  return {
    id: Number(r.id),
    kind: r.kind,
    status: r.status,
    pairKey: r.pair_key,
    leadId: Number(r.lead_id),
    leadSource: r.lead_source,
    leadSourceRecordId: r.lead_source_record_id,
    leadBranchId: r.lead_branch_id,
    crmCustomerId: Number(r.crm_customer_id),
    customerBranchId: r.customer_branch_id,
    evidence: r.evidence,
    evidenceFingerprint: r.evidence_fingerprint,
    detectedAt: r.detected_at.toISOString(),
    decidedBy: r.decided_by,
    decidedAt: r.decided_at?.toISOString() ?? null,
    decisionReason: r.decision_reason,
    supersedesId: r.supersedes_id === null ? null : Number(r.supersedes_id),
    priorDecision:
      r.prior_id === null
        ? null
        : {
            id: Number(r.prior_id),
            status: r.prior_status as ConflictStatus,
            decidedBy: r.prior_decided_by,
            decidedAt: r.prior_decided_at?.toISOString() ?? null,
            reason: r.prior_reason,
          },
  };
}

/** Conflicts in the viewer's scope, newest first, with the total for paging. */
export async function listIdentityConflicts(
  db: Queryable,
  filters: ConflictFilters,
  scope: string[] | null,
): Promise<{ rows: IdentityConflict[]; total: number }> {
  const status = filters.status ?? "pending";
  const params = [scope, status === "all" ? null : status, filters.crmCustomerId ?? null, filters.leadIds ?? null];
  const where = `where ${SCOPE_SQL("$1")}
      and ($2::text is null or k.status = $2)
      and ($3::bigint is null or k.crm_customer_id = $3)
      and ($4::bigint[] is null or k.lead_id = any($4::bigint[]))`;
  const [rows, total] = await Promise.all([
    db.query<ConflictRow>(`${SELECT_CONFLICT} ${where} order by k.detected_at desc, k.id desc limit $5 offset $6`, [
      ...params,
      Math.min(filters.limit ?? 50, 200),
      filters.offset ?? 0,
    ]),
    db.query<{ n: string }>(`select count(*) as n from identity_conflicts k ${where}`, params),
  ]);
  return { rows: rows.rows.map(toConflict), total: Number(total.rows[0].n) };
}

/** One conflict, or null when it does not exist or is outside the viewer's scope. */
export async function getIdentityConflict(db: Queryable, id: number, scope: string[] | null): Promise<IdentityConflict | null> {
  const { rows } = await db.query<ConflictRow>(`${SELECT_CONFLICT} where k.id = $2 and ${SCOPE_SQL("$1")}`, [scope, id]);
  return rows[0] ? toConflict(rows[0]) : null;
}

export interface DecisionArgs {
  conflictId: number;
  decision: "accept" | "reject";
  reason: string;
  /** Who decided (the viewer's role in the demo; an SSO subject in production). */
  actor: string;
  now: Date;
  /**
   * The deciding viewer's branch scope (resolveScope). Out-of-scope conflicts are reported as not
   * found. Omit only for system callers that act for all branches.
   */
  scope?: string[] | null;
}

export interface DecisionResult {
  conflict: IdentityConflict;
  /** Other pending candidates of the same lead, rejected because the lead was accepted elsewhere. */
  autoRejectedIds: number[];
  /** The lead's link after the decision, if it has one. */
  link: { identityId: number; rule: IdentityRule; crmCustomerId: number | null } | null;
  resolution: ResolveStats;
}

/**
 * Records a reviewer decision, then re-resolves that lead in the same transaction, so the
 * conflict, the link and the audit row commit together or not at all.
 * Permission (`reviewIdentity`) is checked by the caller, which knows the viewer.
 */
export async function decideIdentityConflict(pool: Pool, args: DecisionArgs): Promise<DecisionResult> {
  const reason = args.reason.trim();
  if (reason.length < 5) throw new ActionError("A reason of at least 5 characters is required", 400);
  return withTransaction(pool, async (tx) => {
    await lockIdentity(tx);
    const scope = args.scope ?? null;
    const found = await tx.query<{ id: string; status: ConflictStatus; lead_id: string; crm_customer_id: string; pair_key: string; evidence_fingerprint: string }>(
      `select k.id, k.status, k.lead_id, k.crm_customer_id, k.pair_key, k.evidence_fingerprint
       from identity_conflicts k where k.id = $2 and ${SCOPE_SQL("$1")} for update`,
      [scope, args.conflictId],
    );
    const row = found.rows[0];
    if (!row) throw new ActionError("Identity conflict not found", 404);
    if (row.status !== "pending") throw new ActionError(`This conflict is already ${row.status}`, 409);

    const status = args.decision === "accept" ? "accepted" : "rejected";
    await tx.query(
      `update identity_conflicts set status = $2, decided_by = $3, decided_at = $4, decision_reason = $5 where id = $1`,
      [row.id, status, args.actor, args.now, reason],
    );

    let autoRejectedIds: number[] = [];
    if (args.decision === "accept") {
      const siblings = await tx.query<{ id: string }>(
        `update identity_conflicts set status = 'rejected', decided_by = $3, decided_at = $4, decision_reason = $5
         where lead_id = $1 and id <> $2 and status = 'pending'
         returning id`,
        [row.lead_id, row.id, args.actor, args.now, `Implied by accepting conflict #${row.id}: the lead belongs to CRM customer ${row.crm_customer_id}`],
      );
      autoRejectedIds = siblings.rows.map((s) => Number(s.id)).sort((a, b) => a - b);
    }

    await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, $3, $4, $5)", [
      args.now,
      args.actor,
      args.decision === "accept" ? "identity_conflict_accept" : "identity_conflict_reject",
      `identity_conflict:${row.id}`,
      {
        pairKey: row.pair_key,
        leadId: Number(row.lead_id),
        crmCustomerId: Number(row.crm_customer_id),
        evidenceFingerprint: row.evidence_fingerprint,
        reason,
        autoRejectedConflictIds: autoRejectedIds,
      },
    ]);

    const resolution = await resolveInTransaction(tx, args.now, { leadIds: [Number(row.lead_id)] });
    const conflict = (await tx.query<ConflictRow>(`${SELECT_CONFLICT} where k.id = $1`, [row.id])).rows[0];
    const link = await tx.query<{ identity_id: string; rule: IdentityRule; crm_customer_id: string | null }>(
      `select k.identity_id, k.rule, i.crm_customer_id
       from identity_links k join identities i on i.id = k.identity_id
       where k.record_table = 'leads' and k.record_id = $1`,
      [row.lead_id],
    );
    const l = link.rows[0];
    return {
      conflict: toConflict(conflict),
      autoRejectedIds,
      link: l ? { identityId: Number(l.identity_id), rule: l.rule, crmCustomerId: l.crm_customer_id === null ? null : Number(l.crm_customer_id) } : null,
      resolution,
    };
  });
}
