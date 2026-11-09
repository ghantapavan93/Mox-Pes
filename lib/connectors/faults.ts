import type { Pool } from "pg";
import { z } from "zod";
import { ActionError } from "@/lib/actions";
import { withTransaction, type Queryable } from "@/lib/db";
import { AMOUNT_FIELD, FAULT_KINDS, type FaultKind } from "./mock-fieldroutes";
import { CRM_ENTITIES, type CrmEntity } from "./types";

/**
 * Fault injection for the MOCK FieldRoutes server (engineers, `sync` permission). Faults only
 * change what the local mock answers; they never touch a real system. Every change is audited.
 */

export const faultInputSchema = z
  .object({
    kind: z.enum(FAULT_KINDS),
    officeId: z.number().int().positive().nullable().default(null),
    entity: z.enum(CRM_ENTITIES).nullable().default(null),
    action: z.enum(["search", "get"]).nullable().default(null),
    recordId: z.number().int().positive().nullable().default(null),
    /** How many times it fires; null = until cleared. */
    remaining: z.number().int().min(1).max(1_000).nullable().default(1),
    /** Matching requests to let through before it starts firing (e.g. fail the 2nd get). */
    skip: z.number().int().min(0).max(1_000).default(0),
    retryAfterSeconds: z.number().int().min(0).max(3_600).optional(),
    delayMs: z.number().int().min(1).max(120_000).optional(),
  })
  .superRefine((f, ctx) => {
    if (f.kind === "malformed_record" && f.entity !== null && !AMOUNT_FIELD[f.entity]) {
      ctx.addIssue({ code: "custom", path: ["entity"], message: "malformed_record corrupts an amount: use subscription, ticket or payment" });
    }
    if (f.kind === "disappeared_record" && f.action === "get") {
      ctx.addIssue({ code: "custom", path: ["action"], message: "disappeared_record removes an id from search results" });
    }
  });

export type FaultInput = z.input<typeof faultInputSchema>;

export interface FaultRow {
  id: number;
  kind: FaultKind;
  officeId: number | null;
  entity: CrmEntity | null;
  action: "search" | "get" | null;
  recordId: number | null;
  remaining: number | null;
  skipRemaining: number;
  params: Record<string, unknown>;
  active: boolean;
  exhausted: boolean;
  fired: number;
  createdBy: string;
  createdAt: Date;
}

export async function listFaults(db: Queryable, opts: { includeCleared?: boolean } = {}): Promise<FaultRow[]> {
  const { rows } = await db.query<{
    id: string; kind: FaultKind; office_id: number | null; entity: CrmEntity | null; action: "search" | "get" | null; record_id: string | null;
    remaining: number | null; skip_remaining: number; params: Record<string, unknown>; active: boolean; fired: number; created_by: string; created_at: Date;
  }>(
    `select * from mock_fieldroutes_faults where $1 or active order by active desc, id desc limit 50`,
    [opts.includeCleared ?? false],
  );
  return rows.map((r) => ({
    id: Number(r.id),
    kind: r.kind,
    officeId: r.office_id,
    entity: r.entity,
    action: r.action,
    recordId: r.record_id === null ? null : Number(r.record_id),
    remaining: r.remaining,
    skipRemaining: r.skip_remaining,
    params: r.params,
    active: r.active,
    exhausted: r.remaining !== null && r.remaining <= 0,
    fired: r.fired,
    createdBy: r.created_by,
    createdAt: r.created_at,
  }));
}

export async function createFault(pool: Pool, args: { input: FaultInput; actor: string; now: Date; auditAt: Date }): Promise<number> {
  const f = faultInputSchema.parse(args.input);
  const params = {
    ...(f.retryAfterSeconds !== undefined ? { retryAfterSeconds: f.retryAfterSeconds } : {}),
    ...(f.delayMs !== undefined ? { delayMs: f.delayMs } : {}),
  };
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      `insert into mock_fieldroutes_faults (kind, office_id, entity, action, record_id, remaining, skip_remaining, params, created_by, created_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
      [f.kind, f.officeId, f.entity, f.action, f.recordId, f.remaining, f.skip, params, args.actor, args.now],
    );
    const id = Number(rows[0].id);
    await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'mock_fault.created', $3, $4)", [
      args.auditAt, args.actor, `mock_fault:${id}`, { ...f },
    ]);
    return id;
  });
}

/** Clears one fault, or every active fault when faultId is null. Returns how many were cleared. */
export async function clearFaults(pool: Pool, args: { faultId: number | null; actor: string; now: Date; auditAt: Date }): Promise<number> {
  return withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ id: string }>(
      "update mock_fieldroutes_faults set active = false, cleared_at = $2 where active and ($1::bigint is null or id = $1) returning id",
      [args.faultId, args.now],
    );
    if (args.faultId !== null && rows.length === 0) throw new ActionError(`Fault ${args.faultId} not found or already cleared`, 404);
    for (const r of rows) {
      await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'mock_fault.cleared', $3, '{}'::jsonb)", [
        args.auditAt, args.actor, `mock_fault:${r.id}`,
      ]);
    }
    return rows.length;
  });
}
