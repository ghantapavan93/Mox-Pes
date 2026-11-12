import type { Pool } from "pg";
import { ActionError } from "@/lib/actions";
import { withTransaction, type Queryable } from "@/lib/db";
import { BRANCH_BY_ID } from "@/lib/reference";
import { requirePermission, resolveScope, type Viewer } from "@/lib/viewer";
import { testCacChange, type CacChangeResult, type HypothesisResult } from "./cac-change";

/**
 * The investigation workspace: a question kept open with its hypotheses, re-tested on demand,
 * with notes. Every test run is stored as a new version (the hypotheses as they stood), so a
 * reader can see what changed the conclusion. Scoped like the branch it is about.
 */

export interface Inquiry {
  id: number;
  kind: "cac_change";
  branchId: string;
  question: string;
  createdBy: string;
  createdAt: string;
  version: number;
  testedAt: string;
  testedBy: string;
  result: CacChangeResult;
  /** The previous version's statuses, to show what changed on a re-test. */
  previous: Array<{ code: string; status: string }> | null;
  notes: Array<{ id: number; author: string; at: string; text: string }>;
}

async function runTests(tx: Queryable, viewer: Viewer, branchId: string, now: Date): Promise<CacChangeResult> {
  // One snapshot for all six tests (the caller's transaction is repeatable read).
  return testCacChange(tx, viewer, { branchId, now });
}

/** Opens a workspace for "Why did <branch>'s paid CAC increase?" and runs the first test. */
export async function openCacInquiry(pool: Pool, viewer: Viewer, args: { branchId: string; now: Date }): Promise<number> {
  requirePermission(viewer, "investigate", "open an investigation");
  if (!BRANCH_BY_ID.has(args.branchId)) throw new ActionError(`Unknown branch ${args.branchId}`, 400);
  resolveScope(viewer, args.branchId);
  return withTransaction(pool, async (tx) => {
    await tx.query("set transaction isolation level repeatable read");
    const result = await runTests(tx, viewer, args.branchId, args.now);
    const { rows } = await tx.query<{ id: string }>(
      `insert into inquiries (kind, branch_id, question, created_by, created_at) values ('cac_change', $1, $2, $3, $4) returning id`,
      [args.branchId, result.question, viewer.subject, args.now],
    );
    const id = Number(rows[0].id);
    await storeVersion(tx, id, 1, viewer.subject, args.now, result);
    await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'inquiry_opened', $3, $4)", [args.now, viewer.subject, `inquiry:${id}`, { branchId: args.branchId, conclusion: result.conclusion.status }]);
    return id;
  });
}

/**
 * An investigation outside the viewer's branches answers exactly as a missing one does, so its
 * id cannot be used to learn which branch it is about (review 2026-11-12, A-3).
 */
function assertVisible(viewer: Viewer, branchId: string | undefined): asserts branchId is string {
  if (!branchId || (viewer.branchIds && !viewer.branchIds.includes(branchId))) throw new ActionError("Investigation not found", 404);
}

/**
 * Re-runs the tests: a new version; the old one is kept. Two re-tests at the same moment cannot
 * both write version N+1: the (inquiry, version) key refuses the second, which the route reports
 * as a conflict to retry (lib/http.ts).
 */
export async function retestInquiry(pool: Pool, viewer: Viewer, args: { id: number; now: Date }): Promise<number> {
  requirePermission(viewer, "investigate", "re-test an investigation");
  return withTransaction(pool, async (tx) => {
    await tx.query("set transaction isolation level repeatable read");
    const found = await tx.query<{ branch_id: string; version: number }>(
      "select i.branch_id, coalesce(max(v.version), 0) as version from inquiries i left join inquiry_versions v on v.inquiry_id = i.id where i.id = $1 group by i.branch_id",
      [args.id],
    );
    const row = found.rows[0];
    assertVisible(viewer, row?.branch_id);
    const result = await runTests(tx, viewer, row.branch_id, args.now);
    const version = Number(row.version) + 1;
    await storeVersion(tx, args.id, version, viewer.subject, args.now, result);
    await tx.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, 'inquiry_retested', $3, $4)", [args.now, viewer.subject, `inquiry:${args.id}`, { version, conclusion: result.conclusion.status }]);
    return version;
  });
}

export async function addInquiryNote(pool: Pool, viewer: Viewer, args: { id: number; text: string; now: Date }): Promise<void> {
  requirePermission(viewer, "investigate", "add a note");
  const text = args.text.trim();
  if (text.length < 3 || text.length > 2000) throw new ActionError("A note is 3 to 2,000 characters", 400);
  const { rows } = await pool.query<{ branch_id: string }>("select branch_id from inquiries where id = $1", [args.id]);
  assertVisible(viewer, rows[0]?.branch_id);
  await pool.query("insert into inquiry_notes (inquiry_id, author, at, text) values ($1, $2, $3, $4)", [args.id, viewer.subject, args.now, text]);
}

async function storeVersion(tx: Queryable, id: number, version: number, actor: string, now: Date, result: CacChangeResult) {
  await tx.query(
    `insert into inquiry_versions (inquiry_id, version, tested_by, tested_at, conclusion_status, result) values ($1, $2, $3, $4, $5, $6)`,
    [id, version, actor, now, result.conclusion.status, result],
  );
}

/** The workspace as the viewer may see it, or null (not found or out of scope: the same answer). */
export async function getInquiry(db: Queryable, viewer: Viewer, id: number): Promise<Inquiry | null> {
  const { rows } = await db.query(
    `select i.id, i.kind, i.branch_id, i.question, i.created_by, i.created_at,
            v.version, v.tested_at, v.tested_by, v.result,
            (select p.result from inquiry_versions p where p.inquiry_id = i.id and p.version = v.version - 1) as previous
     from inquiries i join lateral (select * from inquiry_versions x where x.inquiry_id = i.id order by x.version desc limit 1) v on true
     where i.id = $1`,
    [id],
  );
  const r = rows[0];
  if (!r) return null;
  if (viewer.branchIds && !viewer.branchIds.includes(r.branch_id)) return null;
  const notes = await db.query("select id, author, at, text from inquiry_notes where inquiry_id = $1 order by at, id", [id]);
  return {
    id: Number(r.id),
    kind: r.kind,
    branchId: r.branch_id,
    question: r.question,
    createdBy: r.created_by,
    createdAt: new Date(r.created_at).toISOString(),
    version: Number(r.version),
    testedAt: new Date(r.tested_at).toISOString(),
    testedBy: r.tested_by,
    result: r.result as CacChangeResult,
    previous: r.previous ? (r.previous as CacChangeResult).hypotheses.map((h: HypothesisResult) => ({ code: h.code, status: h.status })) : null,
    notes: notes.rows.map((n) => ({ id: Number(n.id), author: n.author, at: new Date(n.at).toISOString(), text: n.text })),
  };
}

export async function listInquiries(db: Queryable, viewer: Viewer): Promise<Array<{ id: number; branchId: string; question: string; conclusion: string; testedAt: string; version: number }>> {
  const { rows } = await db.query(
    `select i.id, i.branch_id, i.question, v.conclusion_status, v.tested_at, v.version
     from inquiries i join lateral (select * from inquiry_versions x where x.inquiry_id = i.id order by x.version desc limit 1) v on true
     where $1::text[] is null or i.branch_id = any($1::text[])
     order by v.tested_at desc limit 50`,
    [viewer.branchIds],
  );
  return rows.map((r) => ({ id: Number(r.id), branchId: r.branch_id, question: r.question, conclusion: r.conclusion_status, testedAt: new Date(r.tested_at).toISOString(), version: Number(r.version) }));
}
