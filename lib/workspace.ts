import { randomBytes } from "node:crypto";
import type { Pool, PoolClient } from "pg";
import { withTransaction, type Queryable } from "@/lib/db";
import { dateTime } from "@/lib/format";
import { LIMITS } from "@/lib/onboarding/limits";
import { sha256 } from "@/lib/primitives";

/**
 * The visitor workspace (docs/agent-work/release/RELEASE-DESIGN.md §5.1–§5.2): a guest's own uploads
 * and investigations on the hosted demo. Private to its owner, deleted 24 hours after each item
 * starts (wall clock), never counted, never audited. This module holds the limits, the owner key,
 * the quotas and the deletions; it has no server-only import, so tests use it directly.
 */

export const WORKSPACE = {
  retentionHours: 24,
  /**
   * How long deleted rows stay in the hosted database's change history: Neon's history window on
   * the release project (Settings, Postgres, History window: 6 hours, the free plan's longest),
   * read 2026-11-18. Only the operator can restore from it.
   */
  hostHistoryHours: 6,
  /** Below Vercel's 4.5 MB request-body limit, so the app's own refusal is the one a visitor sees. */
  maxBytes: 4 * 1024 * 1024,
  maxRows: 10_000,
  maxMappingsPerUpload: 10,
  /** Held rows across every workspace upload; each upload counts twice its rows (staged + results). */
  heldRowBudget: 100_000,
  /** Another visitor's item younger than this is never evicted to make room. */
  minResidencyMinutes: 30,
  rowsWrittenPerMinute: 50_000,
  rowsWrittenPerDay: 500_000,
  uploadsPerMinute: 30,
  investigationsPerMinute: 30,
  /**
   * The built-in sample (public/samples/demo-calls.csv), exempt from the row caps so "Try the sample"
   * keeps working after a flood. The same form as onboarding_uploads.file_sha256: sha256 of the file's
   * base64 text. .gitattributes pins the file's bytes; tests/unit/workspace-sample-hash.test.ts
   * recomputes it.
   */
  sampleSha256: "e2ca3e2e298dcbab39e9279764a3e718d427ec9b6f1fd1af1c4b419554b8e8a4",
} as const;

/** Where a visitor learns to run the local demo, the only place a file is counted (README.md). */
export const LOCAL_DEMO_URL = "https://github.com/ghantapavan93/Mox-Pes#run-the-demo-locally";

export const VISITOR_COOKIE = "rs_visitor";
const OWNER_PREFIX = "visitor:";
const TOKEN = /^[A-Za-z0-9_-]{43}$/;

/** A new visitor token: 32 random bytes, base64url (43 characters). */
export function newVisitorToken(): string {
  return randomBytes(32).toString("base64url");
}

/** The owner a token stands for, `visitor:` + the token's sha256 hex; null for a missing or malformed token. */
export function subjectOf(token: string | undefined | null): string | null {
  return token && TOKEN.test(token) ? `${OWNER_PREFIX}${sha256(token)}` : null;
}

export function isWorkspaceOwner(subject: string): boolean {
  return subject.startsWith(OWNER_PREFIX);
}

/** The one sentence used wherever a workspace item's lifetime is stated. */
export function availabilitySentence(startedAt: Date | string): string {
  const until = new Date(new Date(startedAt).getTime() + WORKSPACE.retentionHours * 3_600_000);
  return `Available until ${dateTime(until)}, then deleted within a day (sooner if the demo is full).`;
}

export type QuotaRefusal = { status: 413 | 422 | 429 | 503; message: string };

const CAPACITY = {
  upload: "The public demo is at capacity for uploads. Try again in a minute.",
  investigation: "The public demo is at capacity for questions. Try again in a minute.",
} as const;

/**
 * Counts one start of `kind` in its minute and day buckets (database clock, UTC) and commits the
 * count before any work, so a refused start is counted too; counts never go down. Refuses past the
 * per-minute limit.
 */
export async function countStart(pool: Pool, kind: "upload" | "investigation"): Promise<QuotaRefusal | null> {
  const limit = kind === "upload" ? WORKSPACE.uploadsPerMinute : WORKSPACE.investigationsPerMinute;
  const minute = await withTransaction(pool, async (tx) => {
    const { rows } = await tx.query<{ bucket: string; items: number }>(
      `insert into workspace_quota (kind, bucket, starts_at, items)
       values ($1, 'minute', date_trunc('minute', now()), 1), ($1, 'day', date_trunc('day', now()), 1)
       on conflict (kind, bucket, starts_at) do update set items = workspace_quota.items + 1
       returning bucket, items`,
      [kind],
    );
    return rows.find((r) => r.bucket === "minute")!.items;
  });
  return minute > limit ? { status: 429, message: CAPACITY[kind] } : null;
}

/**
 * Counts rows a workspace file makes the database write (staging and every dry run), per minute and
 * per day, committed before the work. The built-in sample is exempt, so it keeps working after a
 * flood.
 */
export async function countRows(pool: Pool, rows: number, isSample: boolean): Promise<QuotaRefusal | null> {
  if (isSample || rows <= 0) return null;
  const totals = await withTransaction(pool, async (tx) => {
    const { rows: out } = await tx.query<{ bucket: string; rows: number }>(
      `insert into workspace_quota (kind, bucket, starts_at, rows)
       values ('upload', 'minute', date_trunc('minute', now()), $1), ('upload', 'day', date_trunc('day', now()), $1)
       on conflict (kind, bucket, starts_at) do update set rows = workspace_quota.rows + excluded.rows
       returning bucket, rows`,
      [rows],
    );
    return Object.fromEntries(out.map((r) => [r.bucket, r.rows])) as { minute: number; day: number };
  });
  if (totals.day > WORKSPACE.rowsWrittenPerDay) {
    return { status: 429, message: "The public demo has handled its share of files for today; the built-in sample still works. Try again after midnight UTC." };
  }
  if (totals.minute > WORKSPACE.rowsWrittenPerMinute) return { status: 429, message: CAPACITY.upload };
  return null;
}

/** The advisory lock that serialises the budget check with the insert (inside one transaction). */
export const BUDGET_LOCK = "workspace:budget";

/**
 * Makes room for an upload of `rows` rows within the held-row budget, inside the staging
 * transaction, after `pg_advisory_xact_lock(hashtext(BUDGET_LOCK))`: deletes the oldest workspace
 * uploads that are older than the residency, just enough of them for the new one to fit. When even
 * all of those would not free enough, it deletes nothing and refuses (503). Returns null when there
 * is room.
 */
export async function makeRoomForUpload(tx: PoolClient, rows: number): Promise<QuotaRefusal | null> {
  await tx.query("select pg_advisory_xact_lock(hashtext($1))", [BUDGET_LOCK]);
  const held = Number(
    (await tx.query<{ held: string }>("select coalesce(sum(row_count), 0) * 2 as held from onboarding_uploads where workspace_owner is not null")).rows[0].held,
  );
  const toFree = held + rows * 2 - WORKSPACE.heldRowBudget;
  if (toFree <= 0) return null;
  // Oldest first, each with the rows freed once it and every older one are gone; an upload is
  // taken while the ones before it have not freed enough yet.
  const oldest = (
    await tx.query<{ id: string; freed: string }>(
      `select id, freed from (
         select id, row_count, sum(row_count::bigint * 2) over (order by workspace_started_at, id) as freed
         from onboarding_uploads
         where workspace_owner is not null and workspace_started_at <= now() - make_interval(mins => $1)
       ) c
       where freed - row_count * 2 < $2
       order by freed`,
      [WORKSPACE.minResidencyMinutes, toFree],
    )
  ).rows;
  const freed = oldest.length > 0 ? Number(oldest[oldest.length - 1].freed) : 0;
  if (freed < toFree) return { status: 503, message: "The public demo is full right now. Try again in a few minutes." };
  await deleteWorkspaceUploads(tx, oldest.map((r) => Number(r.id)));
  return null;
}

/**
 * Deletes workspace uploads whole, children first: their dry runs (row results cascade), their
 * mappings, then the uploads (rows cascade). Company uploads among the ids are left alone.
 */
export async function deleteWorkspaceUploads(db: Queryable, uploadIds: number[]): Promise<void> {
  if (uploadIds.length === 0) return;
  const owned = "select id from onboarding_uploads where id = any($1::bigint[]) and workspace_owner is not null";
  await db.query(`delete from onboarding_dry_runs where upload_id in (${owned})`, [uploadIds]);
  await db.query(`delete from onboarding_mappings where drafted_on_upload in (${owned}) and workspace_owner is not null`, [uploadIds]);
  await db.query("delete from onboarding_uploads where id = any($1::bigint[]) and workspace_owner is not null", [uploadIds]);
}

export async function deleteWorkspaceUpload(db: Queryable, uploadId: number): Promise<void> {
  await deleteWorkspaceUploads(db, [uploadId]);
}

/** The row-limit refusal for a workspace file; `rows` is null when the parser stopped at its own bound. */
export function tooManyRowsMessage(rows: number | null): string {
  const has = rows === null ? `more than ${LIMITS.maxRows.toLocaleString("en-US")}` : rows.toLocaleString("en-US");
  return `The public demo takes files up to ${WORKSPACE.maxRows.toLocaleString("en-US")} rows; this file has ${has}. Upload one month at a time, or run the local demo for files up to ${LIMITS.maxRows.toLocaleString("en-US")} rows.`;
}

/** Deletes one workspace investigation; its steps cascade. */
export async function deleteWorkspaceInvestigation(db: Queryable, investigationId: number): Promise<void> {
  await db.query("delete from workspace_investigations where id = $1", [investigationId]);
}

/**
 * Deletes every workspace item past its retention (wall clock), whole, and quota rows older than two
 * days. Runs at the start of every onboarding and investigator request, and daily from Vercel Cron
 * (GET /api/workspace/cleanup).
 */
export async function deleteExpiredWorkspace(pool: Pool): Promise<{ uploads: number; investigations: number; quotaRows: number }> {
  return withTransaction(pool, async (tx) => {
    const expired = (
      await tx.query<{ id: string }>(
        "select id from onboarding_uploads where workspace_owner is not null and workspace_started_at <= now() - make_interval(hours => $1) for update skip locked",
        [WORKSPACE.retentionHours],
      )
    ).rows.map((r) => Number(r.id));
    await deleteWorkspaceUploads(tx, expired);
    const investigations = await tx.query("delete from workspace_investigations where workspace_started_at <= now() - make_interval(hours => $1)", [WORKSPACE.retentionHours]);
    const quota = await tx.query("delete from workspace_quota where starts_at < now() - interval '2 days'");
    return { uploads: expired.length, investigations: investigations.rowCount ?? 0, quotaRows: quota.rowCount ?? 0 };
  });
}
