import type { Pool } from "pg";
import { connectorOffices, getConnector } from "@/lib/connectors/config";
import type { CrmEntity } from "@/lib/connectors/types";
import type { Queryable } from "@/lib/db";
import { decideIdentityConflict, getIdentityConflict } from "@/lib/identity";
import { enqueueSync } from "@/lib/jobs/sync";

/**
 * What the Action Center needs from the Identity and Connectors modules (roadmap §4).
 * Proposals of kind `resolve_identity_conflict` and `trigger_sync` execute only through these
 * ports: the Action Center never writes identity or connector tables itself.
 *
 * The default ports adapt the modules' exported functions (decideIdentityConflict,
 * getIdentityConflict, getConnector/connectorOffices, enqueueSync). Tests may bind a fake or
 * disconnect a port (null): a disconnected port makes dry runs and executions of that kind
 * refuse with a 409 that says so — nothing is faked in the product.
 *
 * Pool-taking functions are handed `nestedPool(tx)` by the executor, so their own
 * transaction becomes a savepoint of the execution transaction and commits or rolls back with
 * the case bookkeeping (and is always rolled back in a dry run).
 */

export interface IdentityConflictState {
  id: number;
  /** pending | accepted | rejected | superseded */
  status: string;
  /** The conflict's evidence fingerprint: a decision binds to the evidence it saw. */
  fingerprint: string;
  /** Branch of the CRM customer in the pair (scope check); null = unknown. */
  branchId: string | null;
}

export interface IdentityPort {
  getConflict(db: Queryable, conflictId: number): Promise<IdentityConflictState | null>;
  decideIdentityConflict(
    pool: Pool,
    args: { conflictId: number; decision: "accepted" | "rejected"; reason: string; actor: string; now: Date },
  ): Promise<unknown>;
}

export interface ConnectorState {
  id: number;
  displayName: string;
  /** Offices this connector syncs (a sync for another office is refused). */
  officeIds: number[];
}

export interface ConnectorsPort {
  getConnector(db: Queryable, connectorId: number): Promise<ConnectorState | null>;
  enqueueSync(
    pool: Pool,
    args: { connectorId: number; officeId: number; entity: string; idempotencyKey: string; actor: string; now: Date },
  ): Promise<{ jobId: number; created: boolean }>;
}

export interface WorkflowPorts {
  identity: IdentityPort | null;
  connectors: ConnectorsPort | null;
}

const identityModule: IdentityPort = {
  async getConflict(db, conflictId) {
    // System read (scope null): the executor checks the conflict against the exception's branch.
    const conflict = await getIdentityConflict(db, conflictId, null);
    return conflict
      ? { id: conflict.id, status: conflict.status, fingerprint: conflict.evidenceFingerprint, branchId: conflict.customerBranchId }
      : null;
  },
  decideIdentityConflict(pool, args) {
    return decideIdentityConflict(pool, {
      conflictId: args.conflictId,
      decision: args.decision === "accepted" ? "accept" : "reject",
      reason: args.reason,
      actor: args.actor,
      now: args.now,
      scope: null,
    });
  },
};

const connectorsModule: ConnectorsPort = {
  async getConnector(db, connectorId) {
    const connector = await getConnector(db, connectorId);
    if (!connector) return null;
    const offices = await connectorOffices(db, connector);
    return { id: connector.id, displayName: connector.displayName, officeIds: offices.map((o) => o.officeId) };
  },
  async enqueueSync(pool, args) {
    const result = await enqueueSync(pool, {
      connectorId: args.connectorId,
      officeIds: [args.officeId],
      entities: [args.entity as CrmEntity],
      idempotencyKey: args.idempotencyKey,
      actor: args.actor,
      scope: null,
      now: args.now,
      auditAt: args.now,
    });
    const jobId = result.created[0] ?? result.reusedQueued[0] ?? result.jobs[0]?.id;
    if (jobId === undefined) throw new Error("enqueueSync returned no job");
    return { jobId, created: result.created.length > 0 };
  },
};

/** undefined = the module's default adapter; null = disconnected; otherwise a bound port. */
const globalForPorts = globalThis as unknown as { __rsWorkflowPorts?: Partial<WorkflowPorts> };

function overrides(): Partial<WorkflowPorts> {
  globalForPorts.__rsWorkflowPorts ??= {};
  return globalForPorts.__rsWorkflowPorts;
}

/** Binds a port, disconnects it (null), or restores the module default (undefined). */
export function bindWorkflowPorts(next: { identity?: IdentityPort | null; connectors?: ConnectorsPort | null }): void {
  const current = overrides();
  for (const key of ["identity", "connectors"] as const) {
    if (!(key in next)) continue;
    if (next[key] === undefined) delete current[key];
    else (current as Record<string, unknown>)[key] = next[key];
  }
}

export function identityPort(): IdentityPort | null {
  const o = overrides();
  return "identity" in o ? (o.identity ?? null) : identityModule;
}

export function connectorsPort(): ConnectorsPort | null {
  const o = overrides();
  return "connectors" in o ? (o.connectors ?? null) : connectorsModule;
}
