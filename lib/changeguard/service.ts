import type { Pool, PoolClient } from "pg";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { getNow, withRollback, withTransaction, type Queryable } from "@/lib/db";
import { money } from "@/lib/format";
import { ForbiddenError, type Viewer } from "@/lib/viewer";
import {
  assertChangeTransition,
  CampaignMappingPayload,
  configHash,
  preflightHashOf,
  SourceContractPayload,
  type ChangeKind,
  type ChangeStatus,
  type NewChange,
  type PreflightResult,
} from "./model";
import { applyCampaignMapping, baseHashOf, preflightCampaignMapping, preflightSourceContract, readCampaignBase } from "./preflight";

export interface ChangeRow {
  id: number;
  kind: ChangeKind;
  status: ChangeStatus;
  title: string;
  supersedes: number | null;
  payload: unknown;
  configHash: string;
  base: Record<string, unknown>;
  authorSubject: string;
  authorRole: string;
  createdAt: string;
  preflight: PreflightResult | null;
  preflightHash: string | null;
  baseHash: string | null;
  preflightedAt: string | null;
  approvedSubject: string | null;
  approvedRole: string | null;
  approvedAt: string | null;
  decisionReason: string | null;
  releasedBy: string | null;
  releasedAt: string | null;
  verification: Verification | null;
  verifiedAt: string | null;
}

export interface VerificationCheck {
  id: string;
  /** Which kind of success this check speaks for. */
  layer: "configuration" | "data_integrity" | "operational";
  passed: boolean;
  detail: string;
}

export interface Verification {
  checks: VerificationCheck[];
  /** Never claimed by this system: a measured business improvement needs an experiment. */
  businessImprovement: "not measured";
  at: string;
}

const iso = (d: Date | null) => (d ? new Date(d).toISOString() : null);

function toRow(r: Record<string, unknown>): ChangeRow {
  return {
    id: Number(r.id),
    kind: r.kind as ChangeKind,
    status: r.status as ChangeStatus,
    title: r.title as string,
    supersedes: r.supersedes === null ? null : Number(r.supersedes),
    payload: r.payload,
    configHash: r.config_hash as string,
    base: r.base as Record<string, unknown>,
    authorSubject: r.author_subject as string,
    authorRole: r.author_role as string,
    createdAt: iso(r.created_at as Date)!,
    preflight: (r.preflight as PreflightResult | null) ?? null,
    preflightHash: (r.preflight_hash as string | null) ?? null,
    baseHash: (r.base_hash as string | null) ?? null,
    preflightedAt: iso(r.preflighted_at as Date | null),
    approvedSubject: (r.approved_subject as string | null) ?? null,
    approvedRole: (r.approved_role as string | null) ?? null,
    approvedAt: iso(r.approved_at as Date | null),
    decisionReason: (r.decision_reason as string | null) ?? null,
    releasedBy: (r.released_by as string | null) ?? null,
    releasedAt: iso(r.released_at as Date | null),
    verification: (r.verification as Verification | null) ?? null,
    verifiedAt: iso(r.verified_at as Date | null),
  };
}

/** The branches a change touches: the mapping it replaces and the one it proposes. */
function branchesOf(row: Pick<ChangeRow, "kind" | "payload" | "base">): string[] {
  if (row.kind !== "campaign_mapping") return [];
  const p = row.payload as { branchId: string };
  const previous = (row.base.currentBranchId as string | null) ?? null;
  return [previous, p.branchId].filter((b): b is string => b !== null);
}

function assertScope(viewer: Viewer, branches: string[], action: string): void {
  if (viewer.branchIds === null) return;
  const outside = branches.filter((b) => !viewer.branchIds!.includes(b));
  if (outside.length > 0) throw new ForbiddenError(`${viewer.label} cannot ${action}: ${outside.join(", ")} is outside your branches`);
}

async function recordEvent(tx: Queryable, changeId: number, from: ChangeStatus | null, to: ChangeStatus, viewer: Viewer | { subject: string; role: string }, at: Date, detail: Record<string, unknown> = {}) {
  await tx.query("insert into config_change_events (change_id, from_status, to_status, subject, role, at, detail) values ($1, $2, $3, $4, $5, $6, $7)", [
    changeId,
    from,
    to,
    viewer.subject,
    viewer.role,
    at,
    detail,
  ]);
  await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, $3, $4, $5)", [
    at,
    viewer.role,
    `config_change_${to}`,
    `config_change:${changeId}`,
    { from, to, by: viewer.subject, ...detail },
  ]);
}

async function loadForUpdate(tx: PoolClient, id: number): Promise<ChangeRow> {
  const { rows } = await tx.query("select * from config_changes where id = $1 for update", [id]);
  if (rows.length === 0) throw new ActionError(`Change ${id} not found`, 404);
  return toRow(rows[0]);
}

/** Runs the preflight in a transaction that always rolls back; returns the result and hashes. */
async function runPreflight(pool: Pool, row: Pick<ChangeRow, "id" | "kind" | "payload">, viewer: Viewer, now: Date) {
  if (row.kind === "campaign_mapping") {
    const payload = CampaignMappingPayload.parse(row.payload);
    return withRollback(pool, async (tx) => {
      const { result, baseHash } = await preflightCampaignMapping(tx, { payload, viewer, now, changeId: row.id });
      return { result, baseHash, preflightHash: preflightHashOf(result, baseHash) };
    });
  }
  const payload = SourceContractPayload.parse(row.payload);
  const { result, baseHash } = await preflightSourceContract(pool, { payload, viewer });
  return { result, baseHash, preflightHash: preflightHashOf(result, baseHash) };
}

async function storePreflight(pool: Pool, id: number, viewer: Viewer, pre: Awaited<ReturnType<typeof runPreflight>>, now: Date): Promise<ChangeRow> {
  return withTransaction(pool, async (tx) => {
    const row = await loadForUpdate(tx, id);
    const to: ChangeStatus = pre.result.verdict === "fail" ? "preflight_failed" : "ready_for_review";
    // A failed or stale review goes back to draft first; the state machine names each step.
    if (row.status !== "draft") {
      assertChangeTransition(row.status, "draft");
      await tx.query("update config_changes set status = 'draft' where id = $1", [id]);
      await recordEvent(tx, id, row.status, "draft", viewer, now, { why: "preflight re-run" });
    }
    try {
      await tx.query(
        `update config_changes set status = $2, preflight = $3, preflight_hash = $4, base_hash = $5, preflighted_at = $6 where id = $1`,
        [id, to, pre.result, pre.preflightHash, pre.baseHash, now],
      );
    } catch (error) {
      if ((error as { code?: string }).code === "23505") throw new ActionError("Another change for this campaign is already in review or approved", 409);
      throw error;
    }
    await recordEvent(tx, id, "draft", to, viewer, now, { verdict: pre.result.verdict, preflightHash: pre.preflightHash });
    return getChangeTx(tx, id);
  });
}

async function getChangeTx(db: Queryable, id: number): Promise<ChangeRow> {
  const { rows } = await db.query("select * from config_changes where id = $1", [id]);
  if (rows.length === 0) throw new ActionError(`Change ${id} not found`, 404);
  return toRow(rows[0]);
}

/** Proposes a change and preflights it at once. `supersedes` marks a corrected resubmission. */
export async function createChange(pool: Pool, viewer: Viewer, input: NewChange & { supersedes?: number | null }, now?: Date): Promise<ChangeRow> {
  if (!viewer.can.propose) throw new ForbiddenError(`${viewer.label} cannot propose configuration changes`);
  const at = now ?? (await getNow(pool));
  let base: Record<string, unknown> = {};
  let title: string;
  if (input.kind === "campaign_mapping") {
    const campaign = await readCampaignBase(pool, input.payload.campaignId);
    base = { currentBranchId: campaign?.currentBranchId ?? null, campaign: campaign ? { externalId: campaign.externalCampaignId, name: campaign.name, platform: campaign.platform } : null };
    assertScope(viewer, [input.payload.branchId, ...(campaign?.currentBranchId ? [campaign.currentBranchId] : [])], "propose this change");
    title = `${campaign?.externalCampaignId ?? `campaign ${input.payload.campaignId}`}: ${campaign?.currentBranchId ?? "unmapped"} → ${input.payload.branchId}`;
  } else {
    title = `${input.payload.source} ${input.payload.entity}: ${input.payload.samples.length} sample payload(s) of a changed shape`;
  }
  const id = await withTransaction(pool, async (tx) => {
    if (input.supersedes) {
      const old = await loadForUpdate(tx, input.supersedes);
      if (old.kind !== input.kind) throw new ActionError("A resubmission must keep the change kind", 400);
      assertChangeTransition(old.status, "superseded");
      await tx.query("update config_changes set status = 'superseded' where id = $1", [old.id]);
      await recordEvent(tx, old.id, old.status, "superseded", viewer, at);
    }
    const { rows } = await tx.query<{ id: string }>(
      `insert into config_changes (kind, status, title, supersedes, payload, config_hash, base, author_subject, author_role, created_at, decision_reason)
       values ($1, 'draft', $2, $3, $4, $5, $6, $7, $8, $9, null) returning id`,
      [input.kind, title, input.supersedes ?? null, input.payload, configHash(input.kind, input.payload), base, viewer.subject, viewer.role, at],
    );
    const changeId = Number(rows[0].id);
    await recordEvent(tx, changeId, null, "draft", viewer, at, { reason: input.reason, configHash: configHash(input.kind, input.payload) });
    return changeId;
  });
  const row = await getChangeTx(pool, id);
  return storePreflight(pool, id, viewer, await runPreflight(pool, row, viewer, at), at);
}

/** Re-runs the preflight (after a dependency changed, or to refresh a stale review). */
export async function rerunPreflight(pool: Pool, viewer: Viewer, id: number, now?: Date): Promise<ChangeRow> {
  if (!viewer.can.propose) throw new ForbiddenError(`${viewer.label} cannot run preflights`);
  const at = now ?? (await getNow(pool));
  const row = await getChangeTx(pool, id);
  assertScope(viewer, branchesOf(row), "preflight this change");
  if (!["draft", "preflight_failed", "ready_for_review"].includes(row.status)) throw new ActionError(`A ${row.status} change cannot be preflighted again`, 409);
  return storePreflight(pool, id, viewer, await runPreflight(pool, row, viewer, at), at);
}

export const DecisionSchema = z.strictObject({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().trim().min(10).max(1000),
  /** What the reviewer saw. The server refuses an approval whose hashes differ from the stored ones. */
  configHash: z.string().regex(/^[0-9a-f]{64}$/),
  preflightHash: z.string().regex(/^[0-9a-f]{64}$/),
});

/**
 * Approve or reject. Bound to the exact configuration, preflight and base: the reviewer's
 * hashes must equal the stored ones, and the base is re-read now; if it moved, the approval is
 * refused as stale. The author can never decide their own change (also a database constraint).
 */
export async function decideChange(pool: Pool, viewer: Viewer, id: number, input: z.infer<typeof DecisionSchema>, now?: Date): Promise<ChangeRow> {
  if (!viewer.can.approve) throw new ForbiddenError(`${viewer.label} cannot approve configuration changes`);
  const at = now ?? (await getNow(pool));
  return withTransaction(pool, async (tx) => {
    const row = await loadForUpdate(tx, id);
    assertScope(viewer, branchesOf(row), "decide this change");
    if (row.authorSubject === viewer.subject) throw new ForbiddenError("You proposed this change; a different person must decide it");
    if (row.status !== "ready_for_review") throw new ActionError(`Only a change ready for review can be decided (this one is ${row.status})`, 409);
    if (input.configHash !== row.configHash || input.preflightHash !== row.preflightHash) {
      throw new ActionError("What you reviewed is not what is stored: reload the change and review it again", 409);
    }
    if (input.decision === "approve" && row.kind === "source_contract") {
      throw new ActionError("A source contract check stops at review: activating a mapper version is a code deploy", 409);
    }
    if (input.decision === "approve" && row.kind === "campaign_mapping") {
      const base = await readCampaignBase(tx, CampaignMappingPayload.parse(row.payload).campaignId);
      if (!base || baseHashOf(base) !== row.baseHash) throw new ActionError("The mapping or its evidence changed since the preflight: re-run it before approving", 409);
    }
    const to: ChangeStatus = input.decision === "approve" ? "approved" : "rejected";
    assertChangeTransition(row.status, to);
    await tx.query(
      "update config_changes set status = $2, approved_subject = $3, approved_role = $4, approved_at = $5, decision_reason = $6 where id = $1",
      [id, to, viewer.subject, viewer.role, at, input.reason],
    );
    await recordEvent(tx, id, row.status, to, viewer, at, { reason: input.reason, configHash: row.configHash, preflightHash: row.preflightHash });
    return getChangeTx(tx, id);
  });
}

async function liveBranchState(tx: Queryable, campaignId: number) {
  const { rows } = await tx.query<{ branch_id: string | null; total: string | null }>(
    `select (select branch_id from campaign_branch_map where campaign_id = $1) as branch_id, (select sum(cost_cents) from ad_spend_daily) as total`,
    [campaignId],
  );
  return { branchId: rows[0].branch_id, totalSpendCents: Number(rows[0].total ?? 0) };
}

/**
 * Releases an approved campaign mapping inside the synthetic environment, then verifies it in
 * the same transaction. The approval's bindings are re-checked under the row lock: the payload
 * still hashes to the approved configuration, and the base still hashes to what was reviewed.
 * If the base moved, the approval is invalidated (back to draft) instead of releasing.
 */
export async function releaseChange(pool: Pool, viewer: Viewer, id: number, now?: Date): Promise<ChangeRow> {
  if (!viewer.can.propose) throw new ForbiddenError(`${viewer.label} cannot release configuration changes`);
  const at = now ?? (await getNow(pool));
  const outcome = await withTransaction(pool, async (tx) => {
    const row = await loadForUpdate(tx, id);
    assertScope(viewer, branchesOf(row), "release this change");
    if (row.kind !== "campaign_mapping") throw new ActionError("Only campaign mappings can be released here", 409);
    if (row.status !== "approved") throw new ActionError(`Only an approved change can be released (this one is ${row.status})`, 409);
    const payload = CampaignMappingPayload.parse(row.payload);
    if (configHash(row.kind, payload) !== row.configHash) throw new ActionError("The stored configuration no longer matches its approved hash", 409);
    const base = await readCampaignBase(tx, payload.campaignId);
    if (!base || baseHashOf(base) !== row.baseHash) {
      assertChangeTransition("approved", "draft");
      await tx.query("update config_changes set status = 'draft', approved_subject = null, approved_role = null, approved_at = null where id = $1", [id]);
      await recordEvent(tx, id, "approved", "draft", viewer, at, { why: "approval invalidated: the mapping or its evidence changed since review" });
      return { stale: true as const };
    }
    const before = await liveBranchState(tx, payload.campaignId);
    const versions = await tx.query<{ v: number | null }>("select max(version) as v from campaign_mapping_versions where campaign_id = $1", [payload.campaignId]);
    let version = versions.rows[0].v ?? 0;
    if (version === 0) {
      // First time ChangeGuard touches this campaign: record the mapping as found as version 1.
      version = 1;
      await tx.query("insert into campaign_mapping_versions (campaign_id, version, branch_id, change_id, recorded_by, recorded_at) values ($1, 1, $2, null, 'as found', $3)", [payload.campaignId, before.branchId, at]);
    }
    await applyCampaignMapping(tx, { campaignId: payload.campaignId, branchId: payload.branchId, actor: viewer.role, reason: `config change ${id}`, now: at });
    await tx.query("insert into campaign_mapping_versions (campaign_id, version, branch_id, change_id, recorded_by, recorded_at) values ($1, $2, $3, $4, $5, $6)", [
      payload.campaignId,
      version + 1,
      payload.branchId,
      id,
      viewer.subject,
      at,
    ]);
    await tx.query("update config_changes set status = 'monitoring', released_by = $2, released_at = $3 where id = $1", [id, viewer.subject, at]);
    await recordEvent(tx, id, "approved", "monitoring", viewer, at, { version: version + 1 });

    const after = await liveBranchState(tx, payload.campaignId);
    const predicted = row.preflight!;
    const open = await tx.query<{ fingerprint: string }>("select fingerprint from exceptions where status = 'open'");
    const openNow = new Set(open.rows.map((r) => r.fingerprint));
    const notCleared = predicted.exceptionsCleared.filter((e) => openNow.has(e.fingerprint));
    const audit = await tx.query("select 1 from audit_log where subject = $1 and action in ('map_campaign', 'remap_campaign') and at = $2", [`campaign:${payload.campaignId}`, at]);
    const checks: VerificationCheck[] = [
      { id: "applied", layer: "configuration", passed: after.branchId === payload.branchId, detail: `The live mapping is ${after.branchId ?? "unmapped"} (approved: ${payload.branchId}); recorded as version ${version + 1}.` },
      { id: "spend_conserved", layer: "data_integrity", passed: before.totalSpendCents === after.totalSpendCents, detail: `Company spend ${before.totalSpendCents === after.totalSpendCents ? "unchanged to the cent" : "CHANGED"} across the release (${money(before.totalSpendCents)} → ${money(after.totalSpendCents)}).` },
      { id: "predicted_exceptions_cleared", layer: "data_integrity", passed: notCleared.length === 0, detail: notCleared.length === 0 ? `${predicted.exceptionsCleared.length} exception(s) cleared as the preflight predicted.` : `${notCleared.length} exception(s) the preflight expected to clear are still open.` },
      { id: "audit", layer: "operational", passed: (audit.rowCount ?? 0) > 0, detail: "The mapping write is in the audit log with its actor and time." },
    ];
    const allPassed = checks.every((c) => c.passed);
    const hard = checks.filter((c) => !c.passed && c.layer !== "operational" && c.id !== "predicted_exceptions_cleared");
    if (hard.length > 0) {
      // A broken invariant must not stand: undo the whole release.
      throw new ActionError(`Release verification failed, nothing was applied: ${hard.map((c) => c.detail).join(" ")}`, 409);
    }
    const verification: Verification = { checks, businessImprovement: "not measured", at: at.toISOString() };
    const to: ChangeStatus = allPassed ? "verified" : "degraded";
    await tx.query("update config_changes set status = $2, verification = $3, verified_at = $4 where id = $1", [id, to, verification, at]);
    await recordEvent(tx, id, "monitoring", to, { subject: "system:verifier", role: "system" }, at, { passed: checks.filter((c) => c.passed).length, of: checks.length });
    return { stale: false as const };
  });
  if (outcome.stale) throw new ActionError("The mapping or its evidence changed since review; the approval was invalidated. Re-run the preflight.", 409);
  return getChangeTx(pool, id);
}

/**
 * Post-release monitoring: is the released configuration still in place, and does the evidence
 * that arrived since still agree with it? Either failing is RECOVERY_REQUIRED: a person must
 * propose a compensating change. Nothing is rolled back automatically.
 */
export async function monitorChange(pool: Pool, viewer: Viewer, id: number, now?: Date): Promise<ChangeRow> {
  const at = now ?? (await getNow(pool));
  return withTransaction(pool, async (tx) => {
    const row = await loadForUpdate(tx, id);
    assertScope(viewer, branchesOf(row), "monitor this change");
    if (row.status !== "verified" && row.status !== "degraded") throw new ActionError(`Only a released change can be monitored (this one is ${row.status})`, 409);
    const payload = CampaignMappingPayload.parse(row.payload);
    const base = await readCampaignBase(tx, payload.campaignId);
    const since = await tx.query<{ branch_id: string; n: string }>(
      `select l.branch_id, count(*) as n from leads l join ad_campaigns c on c.external_campaign_id = l.campaign_external_id
       where c.id = $1 and l.occurred_at >= $2 group by l.branch_id order by count(*) desc`,
      [payload.campaignId, row.releasedAt],
    );
    const total = since.rows.reduce((t, r) => t + Number(r.n), 0);
    const atTarget = Number(since.rows.find((r) => r.branch_id === payload.branchId)?.n ?? 0);
    const checks: VerificationCheck[] = [
      ...(row.verification?.checks ?? []),
      { id: "still_applied", layer: "configuration", passed: base?.currentBranchId === payload.branchId, detail: `The live mapping is ${base?.currentBranchId ?? "unmapped"} (released: ${payload.branchId}).` },
      {
        id: "evidence_since_release",
        layer: "operational",
        passed: total === 0 || atTarget / total >= 0.5,
        detail: total === 0 ? "No lead with this campaign's id has arrived since the release." : `${atTarget} of ${total} lead(s) since the release arrived at ${payload.branchId}.`,
      },
    ];
    const failing = checks.slice(-2).filter((c) => !c.passed);
    const to: ChangeStatus = failing.length > 0 ? "recovery_required" : "verified";
    assertChangeTransition(row.status, to);
    const verification: Verification = { checks, businessImprovement: "not measured", at: at.toISOString() };
    await tx.query("update config_changes set status = $2, verification = $3, verified_at = $4 where id = $1", [id, to, verification, at]);
    await recordEvent(tx, id, row.status, to, viewer, at, { failing: failing.map((c) => c.id) });
    return getChangeTx(tx, id);
  });
}

export async function getChange(db: Queryable, viewer: Viewer, id: number): Promise<{ change: ChangeRow; events: Array<{ from: string | null; to: string; subject: string; role: string; at: string; detail: unknown }> }> {
  const change = await getChangeTx(db, id);
  assertScope(viewer, branchesOf(change), "read this change");
  const { rows } = await db.query("select from_status, to_status, subject, role, at, detail from config_change_events where change_id = $1 order by id", [id]);
  return { change, events: rows.map((r) => ({ from: r.from_status, to: r.to_status, subject: r.subject, role: r.role, at: new Date(r.at).toISOString(), detail: r.detail })) };
}

/** Campaigns a person can propose a mapping for, unmapped first (the usual reason to be here). */
export async function listCampaignOptions(db: Queryable, viewer: Viewer): Promise<Array<{ id: number; label: string; currentBranchId: string | null }>> {
  const { rows } = await db.query<{ id: string; external_campaign_id: string; name: string; branch_id: string | null }>(
    `select c.id, c.external_campaign_id, c.name, m.branch_id from ad_campaigns c left join campaign_branch_map m on m.campaign_id = c.id
     order by (m.branch_id is null) desc, c.external_campaign_id`,
  );
  return rows
    .filter((r) => r.branch_id === null || viewer.branchIds === null || viewer.branchIds.includes(r.branch_id))
    .map((r) => ({ id: Number(r.id), label: `${r.external_campaign_id} · ${r.name}`, currentBranchId: r.branch_id }));
}

/** Changes the viewer may see: branch-scoped viewers see only changes touching their branches. */
export async function listChanges(db: Queryable, viewer: Viewer, limit = 50): Promise<ChangeRow[]> {
  const { rows } = await db.query("select * from config_changes order by created_at desc, id desc limit $1", [limit]);
  return rows.map(toRow).filter((r) => viewer.branchIds === null || (branchesOf(r).length > 0 && branchesOf(r).every((b) => viewer.branchIds!.includes(b))));
}
