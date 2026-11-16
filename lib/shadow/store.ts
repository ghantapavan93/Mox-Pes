import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { getNow, withTransaction, type Queryable } from "@/lib/db";
import { BRANCHES } from "@/lib/reference";
import { ForbiddenError, type Viewer } from "@/lib/viewer";
import { assureAnswer, AnswerSchema, branchesNamedIn, type AnswerCheck, type AnswerInput } from "./answer";
import { compareSnapshot, SnapshotSchema, type Snapshot, type SnapshotCheck } from "./snapshot";

/**
 * Runs a Shadow Mode check and records it, append-only, with an audit row. The comparison and
 * the record are one transaction under REPEATABLE READ, so every figure in a result comes from
 * one consistent snapshot of the data. Nothing outside `shadow_checks` and `audit_log` is
 * written.
 */

export type ShadowInput = { kind: "snapshot"; input: Snapshot } | { kind: "answer"; input: AnswerInput };

export interface ShadowCheckRow {
  id: number;
  kind: "snapshot" | "answer";
  system: string;
  input: Snapshot | AnswerInput;
  inputHash: string;
  verdict: string;
  result: SnapshotCheck | AnswerCheck;
  actor: string;
  checkedAt: string;
}

/** JSON with keys sorted at every level: equal inputs hash equally, whatever their key order. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>).filter(([, v]) => v !== undefined);
    return `{${entries.sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)).map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

export const inputHash = (kind: string, input: unknown) => createHash("sha256").update(canonical({ kind, input })).digest("hex");

export function parseShadowInput(body: unknown): ShadowInput {
  const kind = (body as { kind?: unknown } | null)?.kind;
  const input = (body as { input?: unknown } | null)?.input;
  return kind === "answer" ? { kind, input: AnswerSchema.parse(input) } : { kind: "snapshot", input: SnapshotSchema.parse(input) };
}

/**
 * The branches a check read: a snapshot's scope, or every branch an answer read, including all the
 * branches of each brand whose metrics it read. An answer that read a brand stored with only its
 * named branches (often none) was readable by every scoped viewer, since an empty scope is inside
 * every scope (BIVE-ACCEPTANCE.md, F-1).
 */
function readScope(check: { kind: "snapshot"; result: SnapshotCheck } | { kind: "answer"; result: AnswerCheck }): { branchIds: string[]; company: boolean } {
  if (check.kind === "answer") {
    const brands = new Set<string>(check.result.entities.brands);
    const read = new Set<string>([...check.result.entities.branches, ...BRANCHES.filter((b) => brands.has(b.brandId)).map((b) => b.id)]);
    return { branchIds: [...read].sort(), company: false };
  }
  const s = check.result.scope;
  if (s.kind === "company") return { branchIds: [], company: true };
  if (s.kind === "brand") return { branchIds: BRANCHES.filter((b) => b.brandId === s.id).map((b) => b.id), company: false };
  return { branchIds: s.id ? [s.id] : [], company: false };
}

/** Every string in a stored input, wherever it was entered: whoever reads the check is shown them. */
function textsOf(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(textsOf);
  if (value && typeof value === "object") return Object.values(value).flatMap(textsOf);
  return [];
}

/**
 * Who a check concerns, stored with it and used by VISIBLE:
 * - branchIds: the branches it read (readScope);
 * - namedBranchIds: those, and every branch its stored input names anywhere (the answer, the
 *   question, the system's name), read or not. An answer naming only what the viewer may not see
 *   reads nothing; a fifth named branch is not read; neither may reach a viewer outside what the
 *   text names (BIVE-ACCEPTANCE.md R11).
 */
function scopeOf(input: unknown, check: { kind: "snapshot"; result: SnapshotCheck } | { kind: "answer"; result: AnswerCheck }): { branchIds: string[]; namedBranchIds: string[]; company: boolean } {
  const read = readScope(check);
  const named = new Set<string>([...read.branchIds, ...textsOf(input).flatMap(branchesNamedIn)]);
  return { ...read, namedBranchIds: [...named].sort() };
}

export async function runShadowCheck(pool: Pool, viewer: Viewer, request: ShadowInput, now?: Date): Promise<ShadowCheckRow> {
  if (!viewer.can.investigate) throw new ForbiddenError(`${viewer.label} cannot run checks against other systems`);
  return withTransaction(pool, async (tx) => {
    await tx.query("set transaction isolation level repeatable read");
    const at = now ?? (await getNow(tx));
    const checked =
      request.kind === "answer"
        ? ({ kind: "answer", result: await assureAnswer(tx, viewer, request.input, at) } as const)
        : ({ kind: "snapshot", result: await compareSnapshot(tx, viewer, request.input, at) } as const);
    const verdict = checked.kind === "answer" ? checked.result.overall : checked.result.verdict;
    const scope = scopeOf(request.input, checked);
    const hash = inputHash(request.kind, request.input);
    const { rows } = await tx.query<{ id: string }>(
      `insert into shadow_checks (kind, system, input, input_hash, verdict, result, branch_ids, named_branch_ids, company, actor, checked_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
      [request.kind, request.input.system, request.input, hash, verdict, checked.result, scope.branchIds, scope.namedBranchIds, scope.company, viewer.subject, at],
    );
    const id = Number(rows[0].id);
    await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'shadow_check', $3, $4)", [
      at,
      viewer.subject,
      `shadow_check:${id}`,
      { kind: request.kind, system: request.input.system, verdict, inputHash: hash },
    ]);
    return { id, kind: request.kind, system: request.input.system, input: request.input, inputHash: hash, verdict, result: checked.result, actor: viewer.subject, checkedAt: at.toISOString() };
  });
}

/**
 * Checks the viewer may see ($1: the viewer's branches, null for company-wide; $2: the viewer).
 * - A company-wide viewer sees every check.
 * - A scoped viewer sees a check when every branch it names or read is in scope, and there is at
 *   least one. A check that names nothing the product can place (an empty scope) is for company-wide
 *   viewers only, and so is one stored before migration 0033, which did not record what it names.
 * - Whoever ran a check sees it again while every branch it read is in their scope: its text may
 *   name what they may not see (those claims are OUT_OF_SCOPE), and the form opens the check at once.
 * - Company checks are for company-wide viewers only.
 */
const VISIBLE = `(($1::text[] is null)
  or (not company and named_branch_ids is not null and cardinality(named_branch_ids) > 0 and named_branch_ids <@ $1::text[])
  or (not company and actor = $2 and branch_ids <@ $1::text[]))`;

const rowOf = (r: Record<string, unknown>): ShadowCheckRow => ({
  id: Number(r.id),
  kind: r.kind as ShadowCheckRow["kind"],
  system: String(r.system),
  input: r.input as ShadowCheckRow["input"],
  inputHash: String(r.input_hash),
  verdict: String(r.verdict),
  result: r.result as ShadowCheckRow["result"],
  actor: String(r.actor),
  checkedAt: new Date(r.checked_at as string).toISOString(),
});

export async function listShadowChecks(db: Queryable, viewer: Viewer, limit = 20): Promise<ShadowCheckRow[]> {
  const { rows } = await db.query(`select * from shadow_checks where ${VISIBLE} order by checked_at desc, id desc limit $3`, [viewer.branchIds, viewer.subject, Math.min(Math.max(limit, 1), 100)]);
  return rows.map(rowOf);
}

/** One check, or null when it does not exist or the viewer may not see it (indistinguishable). */
export async function getShadowCheck(db: Queryable, viewer: Viewer, id: number): Promise<ShadowCheckRow | null> {
  const { rows } = await db.query(`select * from shadow_checks where ${VISIBLE} and id = $3`, [viewer.branchIds, viewer.subject, id]);
  return rows[0] ? rowOf(rows[0]) : null;
}
