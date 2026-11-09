import type { PoolClient } from "pg";
import { z } from "zod";
import {
  ActionError,
  acknowledgeExceptionInTransaction,
  closeExceptionInTransaction,
  mapCampaignToBranchInTransaction,
  overrideLeadBranchInTransaction,
} from "@/lib/actions";
import type { SourceName } from "@/lib/adapters/contract";
import { mapperVersions } from "@/lib/adapters/registry";
import { replay } from "@/lib/ingest/replay";
import { planReplay } from "@/lib/ingest/replay-plan";
import { PERIODS } from "@/lib/period";
import { payloadHash } from "@/lib/primitives";
import type { ExceptionRow } from "@/lib/queries";
import { nestedPool } from "./nested";
import { connectorsPort, identityPort } from "./ports";
import type { LedgerKey } from "./snapshot";

/**
 * Proposal kinds: what each fix applies to, its parameters, the records it touches (for the
 * precondition fingerprint), how it executes, and what "verified" means for it.
 *
 * Executors only call existing write paths — replay()/planReplay() for records, the decision
 * cores in lib/actions.ts, and the Identity/Connectors module ports — inside the caller's
 * transaction. A dry run and an execution run the same executor; only the transaction's
 * ending differs.
 */

export const PROPOSAL_KINDS = [
  "remap_channel",
  "replay_quarantine",
  "map_campaign",
  "override_lead_branch",
  "acknowledge_exception",
  "resolve_identity_conflict",
  "trigger_sync",
] as const;

export type ProposalKind = (typeof PROPOSAL_KINDS)[number];

export function isProposalKind(value: string): value is ProposalKind {
  return (PROPOSAL_KINDS as readonly string[]).includes(value);
}

export interface ExecutorContext {
  tx: PoolClient;
  exception: ExceptionRow;
  actor: string;
  reason: string;
  now: Date;
  /** Stable per proposal + precondition: reused for downstream idempotent writes (replays, jobs). */
  idempotencyKey: string;
}

interface KindSpec<P> {
  label: string;
  /** Exception kinds this fix applies to. */
  exceptionKinds: readonly string[];
  params: z.ZodType<P>;
  /** Business validation against the exception's evidence (beyond the param schema). */
  validate(exception: ExceptionRow, params: P): void;
  /** Branch whose metrics the snapshot shows. */
  branchFor(exception: ExceptionRow, params: P): string | null;
  /** The state of every record the fix will touch; hashed into the precondition fingerprint. */
  touches(tx: PoolClient, exception: ExceptionRow, params: P): Promise<unknown>;
  execute(ctx: ExecutorContext, params: P): Promise<Record<string, unknown>>;
  /** What the exception must be after reconciliation for the fix to count as verified; null = deferred. */
  expectedExceptionStatus(exception: ExceptionRow): string[] | null;
  /** Ledger figures this kind is defined to change. Every current kind changes none. */
  mayChange: readonly LedgerKey[];
}

const branchId = z.string().regex(/^B\d{2}$/, "a branch id like B09");
const mapperVersion = z.string().regex(/^\d+\.\d+$/, "a mapper version like 1.1");

const evidence = (e: ExceptionRow) => e.evidence as Record<string, unknown>;

/** The records a replay or re-map would claim, with the state that decides what happens to them. */
async function replayTouches(tx: PoolClient, exception: ExceptionRow, version: string) {
  const plan = await planReplay(tx, exception, version);
  const { rows } = await tx.query<{ id: string; status: string; adapter_version: string }>(
    "select id, status, adapter_version from raw_events where id = any($1::bigint[]) order by id",
    [plan.rawEventIds],
  );
  return { mode: plan.mode, fromVersion: plan.fromVersion ?? null, lineage: plan.lineage ?? null, records: rows };
}

async function runReplay(ctx: ExecutorContext, version: string, verb: string) {
  const plan = await planReplay(ctx.tx, ctx.exception, version);
  if (plan.rawEventIds.length === 0) throw new ActionError(`There are no records left to ${verb}`, 409);
  const result = await replay(nestedPool(ctx.tx), {
    ...plan,
    mapperVersion: version,
    actor: ctx.actor,
    idempotencyKey: ctx.idempotencyKey,
    dryRun: false,
    now: ctx.now,
    exceptionId: ctx.exception.id,
    scope: { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: ctx.exception.branchId ? [ctx.exception.branchId] : null },
  });
  return {
    mode: plan.mode,
    mapperVersion: version,
    requested: result.requested,
    claimed: result.claimed,
    projected: result.projected,
    stillQuarantined: result.stillQuarantined,
    errors: result.errors.slice(0, 5),
    lineage: plan.lineage ? { predecessorCampaignId: plan.lineage.predecessorCampaignId, successorCampaignId: plan.lineage.successorCampaignId, effectiveDate: plan.lineage.effectiveDate } : null,
  };
}

function checkVersion(source: SourceName, version: string) {
  if (!mapperVersions(source).includes(version)) throw new ActionError(`No mapper ${source}@${version}`, 400);
}

const remapChannel: KindSpec<{ mapperVersion: string }> = {
  label: "Re-map stored spend to the right channel",
  exceptionKinds: ["channel_coverage_gap"],
  params: z.strictObject({ mapperVersion }),
  validate(exception, params) {
    checkVersion("ads", params.mapperVersion);
    const successors = (evidence(exception).successors as unknown[] | null) ?? [];
    if (successors.length === 0) throw new ActionError("No successor campaign in the evidence: there is nothing to re-map", 409);
  },
  branchFor: (e) => e.branchId,
  touches: (tx, e, p) => replayTouches(tx, e, p.mapperVersion),
  execute: (ctx, p) => runReplay(ctx, p.mapperVersion, "re-map"),
  expectedExceptionStatus: () => ["resolved"],
  mayChange: [],
};

const replayQuarantine: KindSpec<{ mapperVersion: string }> = {
  label: "Replay held records through a fixed mapper",
  exceptionKinds: ["quarantined_source_records"],
  params: z.strictObject({ mapperVersion }),
  validate(exception, params) {
    checkVersion(String(evidence(exception).source) as SourceName, params.mapperVersion);
  },
  branchFor: (e) => e.branchId,
  touches: (tx, e, p) => replayTouches(tx, e, p.mapperVersion),
  execute: (ctx, p) => runReplay(ctx, p.mapperVersion, "replay"),
  expectedExceptionStatus: () => ["resolved"],
  mayChange: [],
};

const mapCampaign: KindSpec<{ branchId: string }> = {
  label: "Map the campaign to a branch",
  exceptionKinds: ["unmapped_spend"],
  params: z.strictObject({ branchId }),
  validate(exception) {
    if (!Number.isInteger(Number(evidence(exception).campaignId))) throw new ActionError("The evidence names no campaign", 409);
  },
  branchFor: (_e, p) => p.branchId,
  async touches(tx, exception) {
    const { rows } = await tx.query(
      `select c.id, c.platform, c.external_campaign_id, m.branch_id as mapped_to
       from ad_campaigns c left join campaign_branch_map m on m.campaign_id = c.id where c.id = $1`,
      [Number(evidence(exception).campaignId)],
    );
    return rows[0] ?? null;
  },
  async execute(ctx, p) {
    const campaignId = Number(evidence(ctx.exception).campaignId);
    await mapCampaignToBranchInTransaction(ctx.tx, { campaignId, branchId: p.branchId, actor: ctx.actor, reason: ctx.reason, now: ctx.now });
    return { campaignId, branchId: p.branchId };
  },
  expectedExceptionStatus: () => ["resolved"],
  mayChange: [],
};

const overrideLead: KindSpec<{ branchId: string }> = {
  label: "Credit the lead to the branch that services the customer",
  exceptionKinds: ["branch_mismatch"],
  params: z.strictObject({ branchId }),
  validate(exception, p) {
    const ev = evidence(exception);
    const allowed = [ev.crmBranch, ev.territoryBranch].filter(Boolean);
    if (!allowed.includes(p.branchId)) throw new ActionError(`Branch must be one the evidence supports: ${allowed.join(" or ")}`, 400);
  },
  branchFor: (e) => e.branchId,
  async touches(tx, exception) {
    const leadId = Number(evidence(exception).leadId);
    const { rows } = await tx.query(
      `select l.id, l.branch_id, o.value as override
       from leads l left join overrides o on o.subject_type = 'lead' and o.subject_id = l.id::text and o.field = 'branch_id'
       where l.id = $1`,
      [leadId],
    );
    return rows[0] ?? null;
  },
  async execute(ctx, p) {
    const leadId = Number(evidence(ctx.exception).leadId);
    await overrideLeadBranchInTransaction(ctx.tx, { leadId, branchId: p.branchId, actor: ctx.actor, reason: ctx.reason, now: ctx.now });
    return { leadId, branchId: p.branchId };
  },
  expectedExceptionStatus: () => ["resolved"],
  mayChange: [],
};

const acknowledge: KindSpec<Record<string, never>> = {
  label: "Acknowledge (D2D conflict) or close (payload conflict) with the rationale",
  exceptionKinds: ["channel_conflict", "payload_conflict"],
  params: z.strictObject({}),
  validate() {},
  branchFor: (e) => e.branchId,
  touches: async () => null,
  async execute(ctx) {
    const args = { exceptionId: ctx.exception.id, actor: ctx.actor, reason: ctx.reason, now: ctx.now };
    if (ctx.exception.kind === "channel_conflict") await acknowledgeExceptionInTransaction(ctx.tx, args);
    else await closeExceptionInTransaction(ctx.tx, args);
    return { exceptionId: ctx.exception.id, decision: ctx.exception.kind === "channel_conflict" ? "acknowledged" : "closed" };
  },
  expectedExceptionStatus: (e) => (e.kind === "channel_conflict" ? ["acknowledged"] : ["resolved"]),
  mayChange: [],
};

function requireIdentity() {
  const port = identityPort();
  if (!port) throw new ActionError("The Identity module is not connected to the Action Center yet, so this proposal cannot run", 409);
  return port;
}

function requireConnectors() {
  const port = connectorsPort();
  if (!port) throw new ActionError("The Connectors module is not connected to the Action Center yet, so this proposal cannot run", 409);
  return port;
}

/**
 * An ambiguous lead ↔ CRM customer match decides which channel and branch a customer is
 * credited to, so it is proposed from the customer-level exceptions it explains.
 */
const resolveIdentityConflict: KindSpec<{ conflictId: number; decision: "accepted" | "rejected" }> = {
  label: "Decide an ambiguous identity match",
  exceptionKinds: ["branch_mismatch", "channel_conflict"],
  params: z.strictObject({ conflictId: z.number().int().positive(), decision: z.enum(["accepted", "rejected"]) }),
  validate() {},
  branchFor: (e) => e.branchId,
  async touches(tx, _e, p) {
    const conflict = await requireIdentity().getConflict(tx, p.conflictId);
    if (!conflict) throw new ActionError(`Identity conflict ${p.conflictId} not found`, 404);
    return conflict;
  },
  async execute(ctx, p) {
    const port = requireIdentity();
    const conflict = await port.getConflict(ctx.tx, p.conflictId);
    if (!conflict) throw new ActionError(`Identity conflict ${p.conflictId} not found`, 404);
    if (conflict.status !== "pending") throw new ActionError(`Identity conflict ${p.conflictId} is already ${conflict.status}`, 409);
    if (ctx.exception.branchId && conflict.branchId && conflict.branchId !== ctx.exception.branchId) {
      throw new ActionError(`Identity conflict ${p.conflictId} belongs to ${conflict.branchId}, not ${ctx.exception.branchId}`, 400);
    }
    await port.decideIdentityConflict(nestedPool(ctx.tx), { conflictId: p.conflictId, decision: p.decision, reason: ctx.reason, actor: ctx.actor, now: ctx.now });
    const after = await port.getConflict(ctx.tx, p.conflictId);
    if (after?.status !== p.decision) throw new ActionError(`Identity conflict ${p.conflictId} is ${after?.status ?? "missing"} after the decision`, 409);
    return { conflictId: p.conflictId, decision: p.decision };
  },
  // Re-resolving identities may or may not clear the exception; reconciliation decides later.
  expectedExceptionStatus: () => null,
  mayChange: [],
};

const SYNC_ENTITIES = ["customer", "subscription", "appointment", "ticket", "payment"] as const;

/** A payment arrived for an invoice the CRM feed has not delivered: ask the connector for it. */
const triggerSync: KindSpec<{ connectorId: number; officeId: number; entity: (typeof SYNC_ENTITIES)[number] }> = {
  label: "Queue a CRM sync for the missing records",
  exceptionKinds: ["payment_without_ticket"],
  params: z.strictObject({ connectorId: z.number().int().positive(), officeId: z.number().int().positive(), entity: z.enum(SYNC_ENTITIES) }),
  validate() {},
  branchFor: (e) => e.branchId,
  async touches(tx, _e, p) {
    const connector = await requireConnectors().getConnector(tx, p.connectorId);
    if (!connector) throw new ActionError(`Connector ${p.connectorId} not found`, 404);
    return { id: connector.id, officeIds: connector.officeIds };
  },
  async execute(ctx, p) {
    const port = requireConnectors();
    const connector = await port.getConnector(ctx.tx, p.connectorId);
    if (!connector) throw new ActionError(`Connector ${p.connectorId} not found`, 404);
    if (!connector.officeIds.includes(p.officeId)) throw new ActionError(`Connector ${connector.displayName} does not sync office ${p.officeId}`, 400);
    const job = await port.enqueueSync(nestedPool(ctx.tx), { ...p, idempotencyKey: ctx.idempotencyKey, actor: ctx.actor, now: ctx.now });
    return { jobId: job.jobId, created: job.created, connectorId: p.connectorId, officeId: p.officeId, entity: p.entity };
  },
  // The job runs later; the exception resolves when the ticket arrives and reconciliation sees it.
  expectedExceptionStatus: () => null,
  mayChange: [],
};

const SPECS: { [K in ProposalKind]: KindSpec<never> } = {
  remap_channel: remapChannel as KindSpec<never>,
  replay_quarantine: replayQuarantine as KindSpec<never>,
  map_campaign: mapCampaign as KindSpec<never>,
  override_lead_branch: overrideLead as KindSpec<never>,
  acknowledge_exception: acknowledge as KindSpec<never>,
  resolve_identity_conflict: resolveIdentityConflict as KindSpec<never>,
  trigger_sync: triggerSync as KindSpec<never>,
};

/** A kind's spec with its params already validated. */
export interface BoundKind {
  kind: ProposalKind;
  label: string;
  params: Record<string, unknown>;
  branchFor(exception: ExceptionRow): string | null;
  touches(tx: PoolClient, exception: ExceptionRow): Promise<unknown>;
  execute(ctx: ExecutorContext): Promise<Record<string, unknown>>;
  expectedExceptionStatus(exception: ExceptionRow): string[] | null;
  mayChange: readonly LedgerKey[];
}

/**
 * Checks the kind applies to the exception, parses params with the kind's schema (a ZodError
 * becomes a 400 at the route), and runs the evidence checks.
 */
export function bindKind(kind: string, exception: ExceptionRow, rawParams: unknown): BoundKind {
  if (!isProposalKind(kind)) throw new ActionError(`Unknown proposal kind "${kind}"`, 400);
  const spec = SPECS[kind] as unknown as KindSpec<Record<string, unknown>>;
  if (!spec.exceptionKinds.includes(exception.kind)) {
    throw new ActionError(`A ${kind} proposal does not apply to a ${exception.kind} exception (applies to ${spec.exceptionKinds.join(", ")})`, 400);
  }
  const params = spec.params.parse(rawParams ?? {});
  spec.validate(exception, params);
  return {
    kind,
    label: spec.label,
    params,
    branchFor: (e) => spec.branchFor(e, params),
    touches: (tx, e) => spec.touches(tx, e, params),
    execute: (ctx) => spec.execute(ctx, params),
    expectedExceptionStatus: (e) => spec.expectedExceptionStatus(e),
    mayChange: spec.mayChange,
  };
}

/** Which kinds can be proposed for an exception kind, and whether their executor is connected. */
export function kindsFor(exceptionKind: string): Array<{ kind: ProposalKind; label: string; available: boolean; unavailableReason: string | null }> {
  return PROPOSAL_KINDS.filter((k) => SPECS[k].exceptionKinds.includes(exceptionKind)).map((kind) => {
    const missing =
      kind === "resolve_identity_conflict" && !identityPort()
        ? "Identity module not connected yet"
        : kind === "trigger_sync" && !connectorsPort()
          ? "Connectors module not connected yet"
          : null;
    return { kind, label: SPECS[kind].label, available: missing === null, unavailableReason: missing };
  });
}

export const KIND_TITLE: Record<ProposalKind, string> = {
  remap_channel: "Re-map channel",
  replay_quarantine: "Replay quarantine",
  map_campaign: "Map campaign",
  override_lead_branch: "Override lead branch",
  acknowledge_exception: "Acknowledge / close",
  resolve_identity_conflict: "Resolve identity conflict",
  trigger_sync: "Trigger CRM sync",
};

/**
 * The precondition fingerprint: the exception's status and evidence plus the current state
 * of every record the fix touches (ids, statuses, adapter versions, existing mappings or
 * overrides). An execution recomputes it and refuses if it differs from the dry run's.
 *
 * last_detected_at is deliberately left out: every reconciliation run refreshes it even when
 * nothing about the condition changed, which would make every dry run stale after the next
 * ingestion. The evidence carries what actually matters (record counts, sample ids, amounts).
 */
export async function preconditionFingerprint(tx: PoolClient, bound: BoundKind, exception: ExceptionRow): Promise<string> {
  const touched = await bound.touches(tx, exception);
  // JSON round trip first: dates become ISO strings, so equal states hash equally.
  return payloadHash(
    JSON.parse(
      JSON.stringify({
        kind: bound.kind,
        params: bound.params,
        exception: { id: exception.id, kind: exception.kind, status: exception.status, evidence: exception.evidence },
        touched,
      }),
    ),
  );
}
