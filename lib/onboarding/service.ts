import type { Pool } from "pg";
import { ActionError } from "@/lib/actions";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { withRollback, withTransaction, type Queryable } from "@/lib/db";
import { LEAD_WRITE_LOCK, ingestRecords } from "@/lib/ingest/ingest";
import { compareSnapshots, dashboardSnapshot, type SnapshotChange } from "@/lib/metrics/dashboard-snapshot";
import { reconcile, tryLockReconcile } from "@/lib/reconcile/reconcile";
import { sha256 } from "@/lib/primitives";
import { ForbiddenError, canSeeBranch, type Viewer } from "@/lib/viewer";
import {
  WORKSPACE, countRows, countStart, deleteExpiredWorkspace, deleteWorkspaceUpload, isWorkspaceOwner, makeRoomForUpload, tooManyRowsMessage, type QuotaRefusal,
} from "@/lib/workspace";
import { requireOnboarding, summary, uploadFor, uploadsFor, type UploadSummary } from "./access";
import { suggestMappings, type ApprovedMappingHint, type AssistantResult } from "./assistant";
import { branchValueReport } from "./branches";
import { MappingSpecSchema, compileRows, layoutFingerprint, specHash, validateSpec, type MappingSpec, type RowOutcome, type SpecProblem } from "./compile";
import { proposeValue } from "./vocabulary";
import { branchOfProjection, compareWithLedger, ledgerHref, type LedgerComparison, type LedgerTarget } from "./ledger";
import { LIMITS, tooLargeMessage } from "./limits";
import { isRefusal, parseUpload, type ParsedTable } from "./parse";
import { profileTable, type TableProfile } from "./profile";
import { DATASETS, type DatasetId } from "./targets";

export type { UploadSummary } from "./access";

/**
 * The onboarding workflow, server side. Every step re-checks the viewer's permission here:
 *
 *   stage     propose   upload -> parse -> profile -> assistant suggestions (staging only)
 *   propose   propose   a mapping version for this export layout (never self-approved)
 *   dry run   propose | approve   compile with the deployed mapper + compare with the ledger
 *   decide    approve   approve or reject a mapping; the proposer's role cannot decide
 *   publish   approve   calls / web leads only: the dry run's eligible rows go through intake
 *
 * Who can SEE an upload: roles that can propose or approve. Branch-scoped roles cannot (an
 * export spans branches; its profile alone would leak other branches' volumes).
 *
 * The visitor workspace (release design §5.2): a guest with the workspace permission stages, maps and
 * dry-runs its own uploads, which only it can see (lib/onboarding/access.ts), which are deleted whole
 * after 24 hours, never approved or published, and never written to audit_log.
 */

export interface DryRunSummary {
  id: number;
  mappingId: number;
  mappingVersion: number;
  mappingStatus: string;
  specHash: string;
  ranAt: string;
  ranBy: string;
  total: number;
  counts: Record<string, number>;
  issues: Array<{ code: string; field: string; rows: number; safeToAutomate: boolean; example: { row: number; detail: string; suggestion: string } }>;
  ledger: { counts: LedgerComparison["counts"]; money: LedgerComparison["money"]; differences: Array<{ row: number; diffs: LedgerComparison["rows"][number]["diffs"] }> };
  authority: "publish" | "reconcile";
  publishable: number;
  accounted: boolean;
  /** Ad spend only: what the counted rows cover. Absent on dry runs stored before it existed. */
  scope?: SpendScope | null;
  /** The dashboard with this file counted in a private, rolled-back copy (previewUpload); absent until counted. */
  preview?: UploadPreview | null;
}

/** The rows an ad-spend dry run counted: their days, campaigns, accounts and currency basis. */
export interface SpendScope {
  firstDay: string;
  lastDay: string;
  campaigns: number;
  accounts: string[];
  platforms: string[];
  /** stated: the file said USD. assumed: the file stated no currency, so the mapper read US dollars. */
  currency: { stated: number; assumed: number };
}

function spendScope(outcomes: RowOutcome[]): SpendScope | null {
  const rows = outcomes.flatMap((o) => (o.disposition === "eligible" && o.projection.table === "ad_spend_daily" ? [o.projection.row] : []));
  if (rows.length === 0) return null;
  const days = rows.map((r) => r.spendDate).sort();
  return {
    firstDay: days[0],
    lastDay: days[days.length - 1],
    campaigns: new Set(rows.map((r) => `${r.platform}:${r.externalCampaignId}`)).size,
    accounts: [...new Set(rows.map((r) => r.adAccountId))].sort(),
    platforms: [...new Set(rows.map((r) => r.platform))].sort(),
    currency: { stated: rows.filter((r) => r.currencyBasis === "reported_usd").length, assumed: rows.filter((r) => r.currencyBasis !== "reported_usd").length },
  };
}

async function audit(db: Queryable, now: Date, viewer: Viewer, action: string, subject: string, detail: Record<string, unknown>) {
  // A workspace item changes no shared data, and the log is public on the demo: not audited (§5.2).
  if (viewer.can.workspace) return;
  // Never row values: counts, ids, codes and hashes only.
  await db.query("insert into audit_log (at, actor, action, subject, detail) values ($1, $2, $3, $4, $5)", [now, viewer.label, action, subject, detail]);
}

/**
 * Deletes staged cells that are past retention, and every copy of cell text derived from them
 * (row-result details and dry-run examples quote values: security review #4). Runs before
 * every onboarding read and write, and from the worker on a schedule.
 */
export async function purgeExpired(db: Queryable, now: Date): Promise<number> {
  const expired = await db.query<{ id: string }>(
    `update onboarding_uploads set rows_purged_at = $1, status = case when status = 'staged' then 'expired' else status end
     where rows_purged_at is null and expires_at <= $1 and workspace_owner is null returning id`,
    [now],
  );
  const ids = expired.rows.map((r) => Number(r.id));
  if (ids.length > 0) await scrubCellText(db, ids);
  return ids.length;
}

async function purgeRows(db: Queryable, uploadId: number, now: Date) {
  await db.query("update onboarding_uploads set rows_purged_at = coalesce(rows_purged_at, $2) where id = $1", [uploadId, now]);
  await scrubCellText(db, [uploadId]);
}

/** Cells, row-result details and dry-run examples go; codes, counts and dispositions stay. */
async function scrubCellText(db: Queryable, uploadIds: number[]) {
  await db.query("delete from onboarding_rows where upload_id = any($1::bigint[])", [uploadIds]);
  await db.query(
    `update onboarding_row_results set detail = null
     where dry_run_id in (select id from onboarding_dry_runs where upload_id = any($1::bigint[])) and detail is not null`,
    [uploadIds],
  );
  await db.query(
    `update onboarding_dry_runs d set summary = jsonb_set(d.summary, '{issues}', coalesce((
       select jsonb_agg(jsonb_set(i, '{example,detail}', '"(deleted with the staged rows)"'::jsonb)) from jsonb_array_elements(d.summary->'issues') i
     ), '[]'::jsonb))
     where d.upload_id = any($1::bigint[]) and jsonb_typeof(d.summary->'issues') = 'array'`,
    [uploadIds],
  );
}

async function approvedHint(db: Queryable, fingerprint: string): Promise<{ dataset: DatasetId; hint: ApprovedMappingHint } | null> {
  const row = (
    await db.query<{ dataset: DatasetId; version: number; decided_by: string; spec: MappingSpec }>(
      "select dataset, version, decided_by, spec from onboarding_mappings where layout_fingerprint = $1 and status = 'approved' and workspace_owner is null order by decided_at desc limit 1",
      [fingerprint],
    )
  ).rows[0];
  return row ? { dataset: row.dataset, hint: { version: row.version, approvedBy: row.decided_by, fields: row.spec.columns } } : null;
}

/** The form onboarding_uploads.file_sha256 has always used: sha256 of the file's base64 text. */
const fileHash = (bytes: Buffer) => sha256(bytes.toString("base64"));

/**
 * Writes a parsed upload and its rows; returns its id. Business fields take the business clock
 * (`now`); a workspace upload also carries its owner and starts on the database's own clock.
 */
async function insertUpload(
  tx: Queryable,
  a: { parsed: ParsedTable; bytes: Buffer; viewer: Viewer; now: Date; fingerprint: string; profile: TableProfile; assistant: AssistantResult; workspaceOwner: string | null },
): Promise<number> {
  const { parsed } = a;
  const meta = { columns: parsed.columns, sourceHeaders: parsed.sourceHeaders, rowRefs: parsed.rowRefs, raggedRows: parsed.raggedRows, warnings: parsed.warnings, encoding: parsed.encoding, delimiter: parsed.delimiter, sheet: parsed.sheet };
  const inserted = await tx.query<{ id: string }>(
    `insert into onboarding_uploads (filename, format, byte_size, file_sha256, sheet_name, uploaded_by, uploaded_role, uploaded_at, expires_at,
       layout_fingerprint, row_count, column_count, table_meta, profile, assistant, workspace_owner, workspace_started_at)
     values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16::text, case when $16::text is null then null else now() end) returning id`,
    [
      parsed.filename, parsed.format, a.bytes.length, fileHash(a.bytes), parsed.sheet?.name ?? null, a.viewer.label, a.viewer.role, a.now,
      new Date(a.now.getTime() + LIMITS.retentionHours * 3_600_000), a.fingerprint, parsed.rows.length, parsed.columns.length, meta, a.profile, a.assistant,
      a.workspaceOwner,
    ],
  );
  const id = Number(inserted.rows[0].id);
  // Rows in chunks of 1,000: bounded statement size whatever the file.
  for (let i = 0; i < parsed.rows.length; i += 1000) {
    const chunk = parsed.rows.slice(i, i + 1000).map((cells, k) => ({ ordinal: i + k, cells }));
    await tx.query(
      `insert into onboarding_rows (upload_id, ordinal, cells) select $1, r."ordinal", r."cells" from jsonb_to_recordset($2::jsonb) as r("ordinal" int, "cells" jsonb)`,
      [id, JSON.stringify(chunk)],
    );
  }
  return id;
}

/** Stages a company upload (a staff role). A workspace file goes through stageWorkspaceUpload. */
export async function stageUpload(pool: Pool, args: { viewer: Viewer; filename: string; bytes: Buffer; sheetIndex?: number; now: Date }): Promise<{ upload: UploadSummary } | { refused: { code: string; message: string } }> {
  if (requireOnboarding(args.viewer, "upload data", "propose") === "workspace") {
    throw new Error("stageUpload stages company uploads; the upload route stages a workspace file with stageWorkspaceUpload");
  }
  const parsed = parseUpload({ filename: args.filename, bytes: args.bytes, sheetIndex: args.sheetIndex });
  if (isRefusal(parsed)) {
    await withTransaction(pool, (tx) => audit(tx, args.now, args.viewer, "onboarding_upload_refused", "onboarding", { code: parsed.code, bytes: args.bytes.length }));
    return { refused: { code: parsed.code, message: parsed.message } };
  }
  const profile = profileTable(parsed);
  const fingerprint = layoutFingerprint(parsed);
  return withTransaction(pool, async (tx) => {
    const prior = await approvedHint(tx, fingerprint);
    const assistant = suggestMappings(profile, { dataset: prior?.dataset ?? null, rows: parsed.rows, approved: prior?.hint ?? null });
    const id = await insertUpload(tx, { parsed, bytes: args.bytes, viewer: args.viewer, now: args.now, fingerprint, profile, assistant, workspaceOwner: null });
    await audit(tx, args.now, args.viewer, "onboarding_upload", `onboarding:${id}`, { format: parsed.format, rows: parsed.rows.length, columns: parsed.columns.length, fingerprint, suggestedDataset: assistant.dataset.chosen });
    return { upload: await summary(tx, id) };
  });
}

export type WorkspaceStageResult =
  | { upload: UploadSummary }
  | { repeatOf: { id: number; startedAt: string } }
  | { refused: { code: string; message: string; status: QuotaRefusal["status"] } };

/** The owner's live upload of these exact bytes (and sheet), if any: a repeat stages nothing (§5.2). */
async function liveRepeat(db: Queryable, owner: string, hash: string, sheetIndex: number): Promise<{ id: number; startedAt: string } | null> {
  const r = (
    await db.query<{ id: string; workspace_started_at: Date }>(
      `select id, workspace_started_at from onboarding_uploads
       where workspace_owner = $1 and file_sha256 = $2 and coalesce((table_meta->'sheet'->>'index')::int, 0) = $3
         and workspace_started_at > now() - make_interval(hours => $4)
       order by id desc limit 1`,
      [owner, hash, sheetIndex, WORKSPACE.retentionHours],
    )
  ).rows[0];
  return r ? { id: Number(r.id), startedAt: r.workspace_started_at.toISOString() } : null;
}

/**
 * Stages a visitor's file in its own workspace (release design §5.2, WP-D step 3), in this order:
 * expired workspace items go; the start is counted; the size is checked; the same file from the same
 * owner, still live, answers `repeatOf` and stages nothing; the file is parsed and held to the
 * workspace's row limit; its rows are counted (the built-in sample is exempt); then, under the
 * budget lock, room is made and the upload is written. A refusal writes nothing but its count. The
 * suggestions come from the file alone (no company mapping's hint), and nothing is audited.
 *
 * The row limit is checked on the parsed table: the parser's own bound (LIMITS.maxRows) still caps
 * the work, and a 4 MB file is parsed in well under a second.
 */
export async function stageWorkspaceUpload(pool: Pool, args: { viewer: Viewer; filename: string; bytes: Buffer; sheetIndex?: number; now: Date }): Promise<WorkspaceStageResult> {
  if (requireOnboarding(args.viewer, "upload data", "propose") !== "workspace" || !isWorkspaceOwner(args.viewer.subject)) {
    throw new Error("stageWorkspaceUpload needs a workspace viewer that holds its own token (viewerForWorkspaceStart)");
  }
  const owner = args.viewer.subject;
  const sheetIndex = args.sheetIndex ?? 0;
  const refused = (code: string, r: QuotaRefusal): WorkspaceStageResult => ({ refused: { code, message: r.message, status: r.status } });

  await deleteExpiredWorkspace(pool);
  const capacity = await countStart(pool, "upload");
  if (capacity) return refused("AT_CAPACITY", capacity);
  if (args.bytes.length > WORKSPACE.maxBytes) return refused("TOO_LARGE", { status: 413, message: tooLargeMessage(args.bytes.length, WORKSPACE.maxBytes, "workspace") });
  const hash = fileHash(args.bytes);
  const earlier = await liveRepeat(pool, owner, hash, sheetIndex);
  if (earlier) return { repeatOf: earlier };

  const parsed = parseUpload({ filename: args.filename, bytes: args.bytes, sheetIndex });
  if (isRefusal(parsed)) {
    // The parser stops at its own bound, worded for staff: say the workspace's limit instead.
    return parsed.code === "TOO_MANY_ROWS"
      ? refused("TOO_MANY_ROWS", { status: 422, message: tooManyRowsMessage(null) })
      : refused(parsed.code, { status: 422, message: parsed.message });
  }
  if (parsed.rows.length > WORKSPACE.maxRows) return refused("TOO_MANY_ROWS", { status: 422, message: tooManyRowsMessage(parsed.rows.length) });
  const rowsCapacity = await countRows(pool, parsed.rows.length, hash === WORKSPACE.sampleSha256);
  if (rowsCapacity) return refused("AT_CAPACITY", rowsCapacity);

  const profile = profileTable(parsed);
  const fingerprint = layoutFingerprint(parsed);
  const assistant = suggestMappings(profile, { dataset: null, rows: parsed.rows, approved: null });
  return withTransaction(pool, async (tx) => {
    const full = await makeRoomForUpload(tx, parsed.rows.length);
    if (full) return refused("FULL", full);
    // Every workspace stage holds the budget lock, so a retry that raced the first request (a
    // dropped connection, a double click) finds the first one's upload here.
    const raced = await liveRepeat(tx, owner, hash, sheetIndex);
    if (raced) return { repeatOf: raced };
    const id = await insertUpload(tx, { parsed, bytes: args.bytes, viewer: args.viewer, now: args.now, fingerprint, profile, assistant, workspaceOwner: owner });
    return { upload: await summary(tx, id) };
  });
}

/**
 * Retention is enforced on every use, not only when someone opens a page (security review #4).
 * The purge itself commits on its own, BEFORE the caller's transaction: purging inside a
 * transaction that then refuses would roll the purge back (the first version did exactly that).
 */
async function enforceRetention(pool: Pool, now: Date): Promise<void> {
  await purgeExpired(pool, now);
  await deleteExpiredWorkspace(pool);
}

/**
 * The staged rows of an upload the caller has already resolved (uploadFor). A company upload's rows
 * last until its business-clock expiry; a workspace upload lives on the wall clock only, which
 * uploadFor checked.
 */
async function loadTable(db: Queryable, upload: UploadSummary, now: Date): Promise<ParsedTable> {
  const expired = upload.workspaceStartedAt === null && new Date(upload.expiresAt).getTime() <= now.getTime();
  if (upload.rowsPurged || expired) {
    throw new ActionError("This upload's rows were deleted (retention or publication). Upload the file again to work on it.", 409);
  }
  const meta = (await db.query<{ table_meta: Omit<ParsedTable, "rows" | "format" | "filename"> }>("select table_meta from onboarding_uploads where id = $1", [upload.id])).rows[0].table_meta;
  const rows = (await db.query<{ cells: Array<string | null> }>("select cells from onboarding_rows where upload_id = $1 order by ordinal", [upload.id])).rows.map((r) => r.cells);
  return { ...meta, rows, format: upload.format as ParsedTable["format"], filename: upload.filename };
}

export async function listUploads(pool: Pool, viewer: Viewer, now: Date): Promise<UploadSummary[]> {
  requireOnboarding(viewer, "see uploads");
  await enforceRetention(pool, now);
  return uploadsFor(pool, viewer);
}

export interface UploadDetail {
  upload: UploadSummary;
  table: { columns: string[]; warnings: ParsedTable["warnings"]; encoding: string; delimiter: string | null; sheet: ParsedTable["sheet"]; raggedRows: number };
  profile: TableProfile;
  assistant: AssistantResult;
  /**
   * Newest first. `ordinal` numbers a workspace upload's own mappings from 1 ("Mapping 2 of this
   * upload"); null on a company upload, whose versions are numbered per export layout.
   */
  mappings: Array<{ id: number; version: number; ordinal: number | null; status: string; specHash: string; proposedBy: string; proposedRole: string; proposedAt: string; decidedBy: string | null; decidedAt: string | null; reason: string | null; spec: MappingSpec; problems: SpecProblem[] }>;
  /** Distinct values of the columns a draft maps to enum and branch fields, with proposed translations. */
  values: Record<string, Array<{ value: string; rows: number; proposed: string | null }>>;
  dryRun: DryRunSummary | null;
  publication: { publishedBy: string; publishedAt: string; stats: Record<string, unknown> } | null;
}

export async function getUpload(pool: Pool, viewer: Viewer, id: number, now: Date, draft?: { dataset: DatasetId; columns: Record<string, string | null> }): Promise<UploadDetail> {
  const access = requireOnboarding(viewer, "see uploads");
  await enforceRetention(pool, now);
  const upload = await uploadFor(pool, viewer, id);
  if (upload.status === "deleted") throw new ActionError("Upload not found", 404);
  const row = (await pool.query<{ table_meta: ParsedTable; profile: TableProfile; assistant: AssistantResult }>("select table_meta, profile, assistant from onboarding_uploads where id = $1", [id])).rows[0];
  // A workspace upload lists only the mappings drafted on it; a company upload, the company's
  // versions for its layout, never a visitor's (§5.2).
  const mappingRows = (
    await pool.query<{ id: string; version: number; status: string; spec_hash: string; proposed_by: string; proposed_role: string; proposed_at: Date; decided_by: string | null; decided_at: Date | null; decision_reason: string | null; spec: MappingSpec }>(
      access === "workspace"
        ? "select * from onboarding_mappings where drafted_on_upload = $1 and workspace_owner = $2 order by version desc"
        : "select * from onboarding_mappings where layout_fingerprint = $1 and workspace_owner is null order by version desc",
      access === "workspace" ? [id, viewer.subject] : [upload.layoutFingerprint],
    )
  ).rows;
  let table: ParsedTable | null = null;
  if (!upload.rowsPurged) table = await loadTable(pool, upload, now);
  const mappings = mappingRows.map((m, i) => ({
    id: Number(m.id), version: m.version, ordinal: access === "workspace" ? mappingRows.length - i : null, status: m.status, specHash: m.spec_hash, proposedBy: m.proposed_by, proposedRole: m.proposed_role,
    proposedAt: m.proposed_at.toISOString(), decidedBy: m.decided_by, decidedAt: m.decided_at?.toISOString() ?? null, reason: m.decision_reason, spec: m.spec,
    // Problems are worked out for the latest few versions only: each check scans the whole table.
    problems: table && i < 3 ? validateSpec(m.spec, table) : [],
  }));
  const values: UploadDetail["values"] = {};
  const dataset = draft?.dataset ?? mappings[0]?.spec.dataset ?? row.assistant.dataset.chosen;
  const columns = draft?.columns ?? mappings[0]?.spec.columns ?? Object.fromEntries(row.assistant.fields.map((f) => [f.field, f.status === "suggested" ? f.column : null]));
  if (table && dataset) {
    for (const field of DATASETS[dataset].fields.filter((f) => f.kind === "enum" || f.kind === "branch")) {
      const column = columns[field.key];
      const index = column ? table.columns.indexOf(column) : -1;
      if (index < 0) continue;
      values[field.key] = branchValueReport(table.rows.map((r) => r[index])).slice(0, 100).map((v) => ({ value: v.value, rows: v.rows, proposed: proposeValue(dataset, field, v.value) }));
    }
  }
  const pub = (await pool.query<{ published_by: string; published_at: Date; stats: Record<string, unknown> }>("select published_by, published_at, stats from onboarding_publications where upload_id = $1", [id])).rows[0];
  return {
    upload,
    table: { columns: row.table_meta.columns, warnings: row.table_meta.warnings, encoding: row.table_meta.encoding, delimiter: row.table_meta.delimiter, sheet: row.table_meta.sheet, raggedRows: row.table_meta.raggedRows.length },
    profile: row.profile,
    assistant: row.assistant,
    mappings,
    values,
    dryRun: await latestDryRun(pool, id),
    publication: pub ? { publishedBy: pub.published_by, publishedAt: pub.published_at.toISOString(), stats: pub.stats } : null,
  };
}

export async function proposeMapping(pool: Pool, args: { viewer: Viewer; uploadId: number; spec: unknown; now: Date }): Promise<{ mappingId: number; version: number; reused: boolean; problems: SpecProblem[] }> {
  const access = requireOnboarding(args.viewer, "propose a mapping", "propose");
  const spec = MappingSpecSchema.parse(args.spec);
  await enforceRetention(pool, args.now);
  return withTransaction(pool, async (tx) => {
    const upload = await uploadFor(tx, args.viewer, args.uploadId);
    const table = await loadTable(tx, upload, args.now);
    if (upload.status !== "staged") throw new ActionError(`This upload is ${upload.status}`, 409);
    const problems = validateSpec(spec, table);
    const hash = specHash(spec);
    // Reuse within the same owner: a workspace upload's own mappings, or the company's for this layout.
    const same = (
      await tx.query<{ id: string; version: number }>(
        access === "workspace"
          ? "select id, version from onboarding_mappings where dataset = $1 and drafted_on_upload = $2 and workspace_owner = $3 and spec_hash = $4 and status = 'proposed' order by version desc limit 1"
          : "select id, version from onboarding_mappings where dataset = $1 and layout_fingerprint = $2 and workspace_owner is null and spec_hash = $3 and status in ('proposed', 'approved') order by version desc limit 1",
        access === "workspace" ? [spec.dataset, args.uploadId, args.viewer.subject, hash] : [spec.dataset, upload.layoutFingerprint, hash],
      )
    ).rows[0];
    if (same) return { mappingId: Number(same.id), version: same.version, reused: true, problems };
    if (access === "workspace") {
      const held = (await tx.query<{ n: number }>("select count(*)::int as n from onboarding_mappings where drafted_on_upload = $1 and workspace_owner = $2", [args.uploadId, args.viewer.subject])).rows[0].n;
      if (held >= WORKSPACE.maxMappingsPerUpload) {
        throw new ActionError(`This upload has reached the ${WORKSPACE.maxMappingsPerUpload}-version limit. Delete it, then upload the file again.`, 409);
      }
    }
    // Serialise version numbers per layout. Workspace mappings draw from the same sequence, so the
    // unique (dataset, layout, version) still holds; a visitor is shown its own ordinal instead.
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`onboarding:${spec.dataset}:${upload.layoutFingerprint}`]);
    const version = (await tx.query<{ v: number }>("select coalesce(max(version), 0) + 1 as v from onboarding_mappings where dataset = $1 and layout_fingerprint = $2", [spec.dataset, upload.layoutFingerprint])).rows[0].v;
    const inserted = await tx.query<{ id: string }>(
      `insert into onboarding_mappings (dataset, layout_fingerprint, version, spec, spec_hash, status, drafted_on_upload, proposed_by, proposed_role, proposed_at, proposed_subject, workspace_owner)
       values ($1, $2, $3, $4, $5, 'proposed', $6, $7, $8, $9, $10, $11) returning id`,
      [spec.dataset, upload.layoutFingerprint, version, spec, hash, args.uploadId, args.viewer.label, args.viewer.role, args.now, args.viewer.subject, access === "workspace" ? args.viewer.subject : null],
    );
    const mappingId = Number(inserted.rows[0].id);
    await audit(tx, args.now, args.viewer, "onboarding_mapping_proposed", `onboarding_mapping:${mappingId}`, { uploadId: args.uploadId, dataset: spec.dataset, version, specHash: hash, problems: problems.map((p) => p.code) });
    return { mappingId, version, reused: false, problems };
  });
}

function summarise(outcomes: RowOutcome[], ledger: LedgerComparison, authority: "publish" | "reconcile") {
  const counts: Record<string, number> = { eligible: 0, invalid: 0, quarantined: 0, duplicate_in_file: 0, conflict_in_file: 0, matches_ledger: 0, differs_from_ledger: 0 };
  const byRow = new Map(ledger.rows.map((r) => [r.row, r]));
  const issues = new Map<string, DryRunSummary["issues"][number]>();
  for (const o of outcomes) {
    const disposition = o.disposition === "eligible" ? (byRow.get(o.row)?.disposition ?? "eligible") : o.disposition;
    counts[disposition]++;
    const add = (code: string, field: string, safe: boolean, detail: string, suggestion: string) => {
      const key = `${code}:${field}`;
      const cur = issues.get(key);
      if (cur) cur.rows++;
      else issues.set(key, { code, field, rows: 1, safeToAutomate: safe, example: { row: o.row, detail, suggestion } });
    };
    if (o.disposition === "invalid") for (const i of o.issues) add(i.code, i.field, i.safeToAutomate, i.detail, i.suggestion);
    if (o.disposition === "quarantined") add(o.code, "*", false, o.detail, "Live ingestion would quarantine this record the same way");
    if (o.disposition === "conflict_in_file") add("CONFLICT_IN_FILE", "*", false, `Same record as row ${o.with} with different content`, "Keep one version in the export");
    if (o.disposition === "duplicate_in_file") add("DUPLICATE_IN_FILE", "*", true, `Exact repeat of row ${o.of}`, "Counted once");
  }
  return {
    total: outcomes.length,
    counts,
    issues: [...issues.values()].sort((a, b) => b.rows - a.rows),
    ledger: { counts: ledger.counts, money: ledger.money, differences: ledger.rows.filter((r) => r.disposition === "differs_from_ledger").slice(0, 50).map((r) => ({ row: r.row, diffs: r.diffs })) },
    authority,
    publishable: authority === "publish" ? counts.eligible : 0,
    // Every source row has exactly one disposition: nothing was dropped.
    accounted: Object.values(counts).reduce((s, n) => s + n, 0) === outcomes.length,
    scope: spendScope(outcomes),
  };
}

/** Out-of-scope rows (a branch the viewer may not act for) are refused, not hidden. */
function scoped(viewer: Viewer, dataset: DatasetId, outcomes: RowOutcome[]): RowOutcome[] {
  if (viewer.branchIds === null) return outcomes;
  return outcomes.map((o) => {
    if (o.disposition !== "eligible") return o;
    const branch = branchOfProjection(dataset, o);
    return branch && viewer.branchIds!.includes(branch) ? o : { row: o.row, disposition: "invalid" as const, issues: [{ field: "branch", column: null, code: "OUT_OF_SCOPE", detail: "This row belongs to a branch outside your scope", suggestion: "Ask someone with access to that branch", safeToAutomate: false }] };
  });
}

export async function runDryRun(pool: Pool, args: { viewer: Viewer; uploadId: number; mappingId: number; now: Date }): Promise<DryRunSummary> {
  const access = requireOnboarding(args.viewer, "dry-run an import");
  await enforceRetention(pool, args.now);
  if (access === "workspace") {
    // A dry run writes one result per row: counted before the work, as staging is (§5.2).
    const upload = await uploadFor(pool, args.viewer, args.uploadId);
    const sample = (await pool.query<{ sample: boolean }>("select file_sha256 = $2 as sample from onboarding_uploads where id = $1", [upload.id, WORKSPACE.sampleSha256])).rows[0].sample;
    const capacity = await countRows(pool, upload.rowCount, sample);
    if (capacity) throw new ActionError(capacity.message, capacity.status);
  }
  return withTransaction(pool, async (tx) => {
    const upload = await uploadFor(tx, args.viewer, args.uploadId);
    const table = await loadTable(tx, upload, args.now);
    const m = (
      await tx.query<{ spec: MappingSpec; spec_hash: string; layout_fingerprint: string; status: string; drafted_on_upload: string; workspace_owner: string | null }>(
        "select spec, spec_hash, layout_fingerprint, status, drafted_on_upload, workspace_owner from onboarding_mappings where id = $1",
        [args.mappingId],
      )
    ).rows[0];
    // Both sides must agree: a workspace upload runs only its own mappings, a company upload only
    // the company's for its layout. Anything else is not found, never "forbidden" (§5.2).
    const usable =
      m !== undefined &&
      (access === "workspace"
        ? m.workspace_owner === args.viewer.subject && Number(m.drafted_on_upload) === upload.id
        : m.workspace_owner === null && m.layout_fingerprint === upload.layoutFingerprint);
    if (!usable) throw new ActionError("Mapping not found for this upload's layout", 404);
    if (m.status === "rejected" || m.status === "superseded") throw new ActionError(`Mapping is ${m.status}`, 409);
    const problems = validateSpec(m.spec, table);
    if (problems.length > 0) throw new ActionError(`The mapping is incomplete: ${problems.map((p) => p.message).join("; ")}`, 400);
    const outcomes = scoped(args.viewer, m.spec.dataset, compileRows(table, m.spec, args.now));
    const ledger = await compareWithLedger(tx, m.spec.dataset, outcomes);
    const s = summarise(outcomes, ledger, DATASETS[m.spec.dataset].authority);
    // One result per workspace upload: a new dry run replaces the previous one (row results cascade).
    if (access === "workspace") await tx.query("delete from onboarding_dry_runs where upload_id = $1", [upload.id]);
    const inserted = await tx.query<{ id: string }>(
      "insert into onboarding_dry_runs (upload_id, mapping_id, spec_hash, ran_at, ran_by, summary, ledger) values ($1, $2, $3, $4, $5, $6, $7) returning id",
      [args.uploadId, args.mappingId, m.spec_hash, args.now, args.viewer.label, s, { money: ledger.money, counts: ledger.counts }],
    );
    const dryRunId = Number(inserted.rows[0].id);
    const byRow = new Map(ledger.rows.map((r) => [r.row, r]));
    const results = outcomes.map((o) => {
      const l = byRow.get(o.row);
      const first = o.disposition === "invalid" ? o.issues[0] : null;
      return {
        row_ref: o.row,
        disposition: o.disposition === "eligible" ? (l?.disposition ?? "eligible") : o.disposition,
        code: first?.code ?? (o.disposition === "quarantined" ? o.code : o.disposition === "duplicate_in_file" ? "DUPLICATE_IN_FILE" : o.disposition === "conflict_in_file" ? "CONFLICT_IN_FILE" : null),
        field: first?.field ?? null,
        detail: first?.detail ?? (o.disposition === "quarantined" ? o.detail : l?.diffs.length ? l.diffs.map((d) => `${d.fact}: file ${d.file}, ledger ${d.ledger}`).join("; ") : null),
        suggestion: first?.suggestion ?? null,
        safe_to_automate: first?.safeToAutomate ?? null,
        external_id: "externalId" in o ? o.externalId : null,
        ledger_target: l?.target ?? null,
      };
    });
    for (let i = 0; i < results.length; i += 1000) {
      await tx.query(
        `insert into onboarding_row_results (dry_run_id, row_ref, disposition, code, field, detail, suggestion, safe_to_automate, external_id, ledger_target)
         select $1, r."row_ref", r."disposition", r."code", r."field", r."detail", r."suggestion", r."safe_to_automate", r."external_id", r."ledger_target"
         from jsonb_to_recordset($2::jsonb) as r("row_ref" int, "disposition" text, "code" text, "field" text, "detail" text, "suggestion" text, "safe_to_automate" boolean, "external_id" text, "ledger_target" jsonb)`,
        [dryRunId, JSON.stringify(results.slice(i, i + 1000))],
      );
    }
    await audit(tx, args.now, args.viewer, "onboarding_dry_run", `onboarding:${args.uploadId}`, { dryRunId, mappingId: args.mappingId, specHash: m.spec_hash, counts: s.counts });
    return (await latestDryRun(tx, args.uploadId))!;
  });
}

async function latestDryRun(db: Queryable, uploadId: number): Promise<DryRunSummary | null> {
  const r = (
    await db.query<{ id: string; mapping_id: string; version: number; status: string; spec_hash: string; ran_at: Date; ran_by: string; summary: Omit<DryRunSummary, "id" | "mappingId" | "mappingVersion" | "mappingStatus" | "specHash" | "ranAt" | "ranBy"> }>(
      `select d.id, d.mapping_id, m.version, m.status, d.spec_hash, d.ran_at, d.ran_by, d.summary
       from onboarding_dry_runs d join onboarding_mappings m on m.id = d.mapping_id where d.upload_id = $1 order by d.id desc limit 1`,
      [uploadId],
    )
  ).rows[0];
  if (!r) return null;
  return { ...r.summary, id: Number(r.id), mappingId: Number(r.mapping_id), mappingVersion: r.version, mappingStatus: r.status, specHash: r.spec_hash, ranAt: r.ran_at.toISOString(), ranBy: r.ran_by };
}

export interface RowResult {
  row_ref: number;
  disposition: string;
  code: string | null;
  field: string | null;
  detail: string | null;
  suggestion: string | null;
  safe_to_automate: boolean | null;
  raw_event_id: string | null;
  /** The ledger record a matched or differing row was compared with, when this viewer may open it. */
  ledger_href: string | null;
}

export async function rowResults(pool: Pool, viewer: Viewer, args: { uploadId: number; disposition?: string; page: number }): Promise<{ rows: RowResult[]; total: number; pageSize: number }> {
  requireOnboarding(viewer, "see row results");
  // A deleted upload is gone for readers too (security review #4).
  const upload = await uploadFor(pool, viewer, args.uploadId);
  if (upload.status === "deleted") throw new ActionError("Upload not found", 404);
  const dry = await latestDryRun(pool, args.uploadId);
  if (!dry) return { rows: [], total: 0, pageSize: 50 };
  const where = args.disposition ? "and disposition = $2" : "and $2::text is null";
  const total = (await pool.query<{ n: number }>(`select count(*)::int as n from onboarding_row_results where dry_run_id = $1 ${where}`, [dry.id, args.disposition ?? null])).rows[0].n;
  const rows = (
    await pool.query<Omit<RowResult, "ledger_href"> & { ledger_target: LedgerTarget | null }>(
      `select row_ref, disposition, code, field, detail, suggestion, safe_to_automate, raw_event_id, ledger_target from onboarding_row_results where dry_run_id = $1 ${where} order by row_ref limit 50 offset $3`,
      [dry.id, args.disposition ?? null, Math.max(0, args.page - 1) * 50],
    )
  ).rows;
  return {
    rows: rows.map(({ ledger_target: target, ...r }) => ({ ...r, ledger_href: target && canSeeBranch(viewer, target.branchId) ? ledgerHref(target) : null })),
    total,
    pageSize: 50,
  };
}

export async function decideMapping(pool: Pool, args: { viewer: Viewer; mappingId: number; decision: "approve" | "reject"; reason: string; now: Date }): Promise<{ status: string }> {
  requireOnboarding(args.viewer, "approve a mapping", "approve");
  return withTransaction(pool, async (tx) => {
    const m = (
      await tx.query<{ status: string; proposed_role: string; proposed_subject: string; dataset: string; layout_fingerprint: string; workspace_owner: string | null }>(
        "select status, proposed_role, proposed_subject, dataset, layout_fingerprint, workspace_owner from onboarding_mappings where id = $1 for update",
        [args.mappingId],
      )
    ).rows[0];
    if (!m) throw new ActionError("Mapping not found", 404);
    if (m.workspace_owner !== null) throw new ActionError("A workspace mapping cannot be approved", 409);
    if (m.status !== "proposed") throw new ActionError(`Mapping is already ${m.status}`, 409);
    // A different person and a different role (the database refuses the same subject: 0014).
    if (m.proposed_subject === args.viewer.subject) throw new ForbiddenError("You proposed this mapping, so someone else must decide it");
    if (m.proposed_role === args.viewer.role) throw new ForbiddenError("The role that proposed a mapping cannot decide it");
    if (args.decision === "approve") {
      await tx.query("update onboarding_mappings set status = 'superseded', decided_at = coalesce(decided_at, $3) where dataset = $1 and layout_fingerprint = $2 and status = 'approved' and workspace_owner is null", [m.dataset, m.layout_fingerprint, args.now]);
    }
    const status = args.decision === "approve" ? "approved" : "rejected";
    await tx.query("update onboarding_mappings set status = $2, decided_by = $3, decided_role = $4, decided_at = $5, decision_reason = $6, decided_subject = $7 where id = $1", [args.mappingId, status, args.viewer.label, args.viewer.role, args.now, args.reason, args.viewer.subject]);
    await audit(tx, args.now, args.viewer, `onboarding_mapping_${status}`, `onboarding_mapping:${args.mappingId}`, { reason: args.reason });
    return { status };
  });
}

export interface PublishResult {
  published: number;
  skipped: { changedSinceDryRun: number; notEligible: number };
  stats: { inserted: number; duplicates: number; conflicts: number; projected: number; quarantined: number };
}

/**
 * Publishes the dry run's eligible rows through the intake path. Preconditions, all checked
 * inside the transaction: the dataset may publish; the latest dry run used the APPROVED
 * mapping (same spec hash); the approver is not the proposer; the upload has not published.
 * The rows are compiled again and compared with the ledger again: a row the ledger gained
 * since the dry run is skipped, not overwritten.
 */
/**
 * Points inside the publication transaction where a test can pause or fail it, to reproduce an
 * interleaving deterministically (tests/integration/concurrency.test.ts). Never set in the app.
 */
export interface PublishHooks {
  /** The lead-write lock is held; nothing has been compared or written yet. */
  afterLock?: () => Promise<void>;
  /** The ledger has been compared again; nothing has been written yet. */
  afterCompare?: () => Promise<void>;
  /** Rows are written but the transaction has not committed. Throwing here simulates a crash. */
  afterWrite?: () => Promise<void>;
}

export async function publishUpload(pool: Pool, args: { viewer: Viewer; uploadId: number; dryRunId: number; now: Date; hooks?: PublishHooks }): Promise<PublishResult> {
  requireOnboarding(args.viewer, "publish an import", "approve");
  await enforceRetention(pool, args.now);
  return withTransaction(pool, async (tx) => {
    await tx.query("select id from onboarding_uploads where id = $1 for update", [args.uploadId]);
    // Status before rows: a published upload's rows are gone, and "already published" is the answer.
    const current = await uploadFor(tx, args.viewer, args.uploadId);
    if (current.status !== "staged") throw new ActionError(`This upload is ${current.status}`, 409);
    const table = await loadTable(tx, current, args.now);
    const dry = await latestDryRun(tx, args.uploadId);
    if (!dry) throw new ActionError("Run a dry run first", 409);
    // The approver publishes what they reviewed: a newer dry run (another dataset, other rules)
    // since the page was opened is a different decision (security review #5).
    if (dry.id !== args.dryRunId) throw new ActionError("A newer dry run replaced the one you reviewed; review it before publishing", 409);
    // FOR SHARE: an approval that would supersede this mapping waits until the publication commits,
    // so a publication never completes under a mapping that changed during it.
    const m = (await tx.query<{ spec: MappingSpec; spec_hash: string; status: string; proposed_role: string; proposed_subject: string }>("select spec, spec_hash, status, proposed_role, proposed_subject from onboarding_mappings where id = $1 for share", [dry.mappingId])).rows[0];
    if (m.status !== "approved") throw new ActionError("The dry run's mapping is not approved", 409);
    if (m.spec_hash !== dry.specHash) throw new ActionError("The dry run used different rules than the approved mapping; run it again", 409);
    if (m.proposed_subject === args.viewer.subject || m.proposed_role === args.viewer.role) throw new ForbiddenError("Whoever proposed the mapping cannot publish with it");
    const target = DATASETS[m.spec.dataset];
    if (target.authority !== "publish") throw new ActionError(`${target.label} are reconcile-only: ${target.systemOfRecord} is the system of record, so an export can be compared but never published`, 409);

    // Hold off concurrent lead writers (live webhooks, another publication) until this commits:
    // otherwise a call the live feed delivers between the comparison and the insert would be
    // overwritten by the file's copy (data review #7). Exclusive here, shared in live intake, and
    // taken before either side touches a row, so the two can never deadlock. Live intake waits
    // seconds at most; whatever it delivers afterwards is newer and wins, as it should.
    await tx.query("select pg_advisory_xact_lock($1)", [LEAD_WRITE_LOCK]);
    await args.hooks?.afterLock?.();
    const outcomes = scoped(args.viewer, m.spec.dataset, compileRows(table, m.spec, args.now));
    const ledger = await compareWithLedger(tx, m.spec.dataset, outcomes);
    await args.hooks?.afterCompare?.();
    const stillNew = new Set(ledger.rows.filter((r) => r.disposition === "eligible").map((r) => r.row));
    const dryEligible = new Set(
      (await tx.query<{ row_ref: number }>("select row_ref from onboarding_row_results where dry_run_id = $1 and disposition = 'eligible'", [dry.id])).rows.map((r) => r.row_ref),
    );
    const toPublish = outcomes.filter((o): o is Extract<RowOutcome, { disposition: "eligible" }> => o.disposition === "eligible" && stillNew.has(o.row) && dryEligible.has(o.row));
    const mapper = mapperFor(target.source);
    const stats = toPublish.length
      ? await ingestRecords(tx, { source: target.source, records: toPublish.map((o) => o.record), mapper, ctx: referenceContext, runId: null, now: args.now })
      : { fetched: 0, inserted: 0, duplicates: 0, conflicts: 0, projected: 0, quarantined: 0 };
    // Lineage: each published source row points at the raw event it became.
    const raw = await tx.query<{ id: string; external_id: string }>("select id, external_id from raw_events where source = $1 and external_id = any($2::text[])", [target.source, toPublish.map((o) => o.externalId)]);
    const rawByExternal = new Map(raw.rows.map((r) => [r.external_id, Number(r.id)]));
    for (const o of toPublish) {
      await tx.query("update onboarding_row_results set disposition = 'published', raw_event_id = $3 where dry_run_id = $1 and row_ref = $2", [dry.id, o.row, rawByExternal.get(o.externalId) ?? null]);
    }
    const result: PublishResult = {
      published: toPublish.length,
      skipped: { changedSinceDryRun: [...dryEligible].filter((r) => !stillNew.has(r)).length, notEligible: outcomes.length - dryEligible.size },
      stats: { inserted: stats.inserted, duplicates: stats.duplicates, conflicts: stats.conflicts, projected: stats.projected, quarantined: stats.quarantined },
    };
    await tx.query(
      "insert into onboarding_publications (upload_id, mapping_id, dry_run_id, published_by, published_role, published_at, stats, published_subject) values ($1, $2, $3, $4, $5, $6, $7, $8)",
      [args.uploadId, dry.mappingId, dry.id, args.viewer.label, args.viewer.role, args.now, result, args.viewer.subject],
    );
    await tx.query("update onboarding_uploads set status = 'published' where id = $1", [args.uploadId]);
    await purgeRows(tx, args.uploadId, args.now);
    await audit(tx, args.now, args.viewer, "onboarding_published", `onboarding:${args.uploadId}`, { mappingId: dry.mappingId, dryRunId: dry.id, ...result });
    await args.hooks?.afterWrite?.();
    return result;
  });
}

/**
 * The dashboard with this file counted, privately (sharing review, 2026-11-19: "the dashboard has to
 * change along with the data that is uploaded"). Today's dry run compares a file with the ledger;
 * this counts it, in a copy that is rolled back, and keeps only the before and after figures.
 */
export interface UploadPreview {
  version: 1;
  /** The business clock when it was counted. */
  computedAt: string;
  /** The dry run it counted: a new dry run replaces it, and this with it. */
  dryRunId: number;
  dataset: DatasetId;
  authority: "publish" | "reconcile";
  counted: { rows: number; inserted: number; duplicates: number; quarantined: number; skipped: number };
  change: SnapshotChange;
}

/**
 * Counts an upload's dry-run-eligible rows in a private copy: one transaction, always rolled back.
 * Inside it, the dashboard's October figures are read (lib/metrics/dashboard-snapshot.ts), the
 * rows still new go through the intake a publication uses (ingestRecords, the same filter as
 * publishUpload: a file adds what the ledger lacks and never changes what it holds),
 * reconciliation runs, and the figures are read again. Nothing the file did survives the
 * rollback: other visitors' numbers never move, and nothing is published or audited. The before
 * and after figures are kept on the upload's own dry run (summary.preview), which a new dry run,
 * Delete now and expiry remove.
 *
 * Reconcile-only datasets (ad spend, CRM payments) are counted too: never published, but a private
 * copy may show what the dashboard would read if their new rows were counted. Their pages say so.
 *
 * It answers "busy" (503) rather than queue behind another copy or a reconciliation: it holds one
 * of a remote database's few connections while it runs, and statements are bounded.
 */
export async function previewUpload(pool: Pool, args: { viewer: Viewer; uploadId: number; now: Date }): Promise<UploadPreview> {
  const access = requireOnboarding(args.viewer, "count an import in a private copy");
  await enforceRetention(pool, args.now);
  const upload = await uploadFor(pool, args.viewer, args.uploadId);
  if (upload.status !== "staged") throw new ActionError(`This upload is ${upload.status}`, 409);
  const dry = await latestDryRun(pool, args.uploadId);
  if (!dry) throw new ActionError("Run a dry run first", 409);
  if (access === "workspace") {
    // The copy writes the file's rows before rolling them back: counted like a dry run (§5.2).
    const sample = (await pool.query<{ sample: boolean }>("select file_sha256 = $2 as sample from onboarding_uploads where id = $1", [upload.id, WORKSPACE.sampleSha256])).rows[0].sample;
    const capacity = await countRows(pool, upload.rowCount, sample);
    if (capacity) throw new ActionError(capacity.message, capacity.status);
  }
  const preview = await withRollback(pool, async (tx): Promise<UploadPreview> => {
    await tx.query("set local statement_timeout = '30s'");
    await tx.query("set local lock_timeout = '5s'");
    // First, before any row: the order every reconciling transaction keeps (lib/reconcile/reconcile.ts).
    if (!(await tryLockReconcile(tx))) throw new ActionError("Another private copy is being counted right now. Try again in a few seconds.", 503);
    const before = await dashboardSnapshot(tx);
    const table = await loadTable(tx, upload, args.now);
    const m = (await tx.query<{ spec: MappingSpec; spec_hash: string }>("select spec, spec_hash from onboarding_mappings where id = $1", [dry.mappingId])).rows[0];
    if (!m || m.spec_hash !== dry.specHash) throw new ActionError("The dry run's mapping changed since it ran; run the dry run again", 409);
    const target = DATASETS[m.spec.dataset];
    const outcomes = scoped(args.viewer, m.spec.dataset, compileRows(table, m.spec, args.now));
    const ledger = await compareWithLedger(tx, m.spec.dataset, outcomes);
    const stillNew = new Set(ledger.rows.filter((r) => r.disposition === "eligible").map((r) => r.row));
    const dryEligible = new Set(
      (await tx.query<{ row_ref: number }>("select row_ref from onboarding_row_results where dry_run_id = $1 and disposition = 'eligible'", [dry.id])).rows.map((r) => r.row_ref),
    );
    const toCount = outcomes.filter((o): o is Extract<RowOutcome, { disposition: "eligible" }> => o.disposition === "eligible" && stillNew.has(o.row) && dryEligible.has(o.row));
    const stats = toCount.length
      ? await ingestRecords(tx, { source: target.source, records: toCount.map((o) => o.record), mapper: mapperFor(target.source), ctx: referenceContext, runId: null, now: args.now })
      : { inserted: 0, duplicates: 0, quarantined: 0 };
    await reconcile(tx, args.now);
    const after = await dashboardSnapshot(tx);
    return {
      version: 1,
      computedAt: args.now.toISOString(),
      dryRunId: dry.id,
      dataset: m.spec.dataset,
      authority: target.authority,
      counted: { rows: toCount.length, inserted: stats.inserted, duplicates: stats.duplicates, quarantined: stats.quarantined, skipped: dryEligible.size - toCount.length },
      change: compareSnapshots(before, after),
    };
  });
  await pool.query("update onboarding_dry_runs set summary = summary || jsonb_build_object('preview', $2::jsonb) where id = $1 and upload_id = $3", [dry.id, JSON.stringify(preview), args.uploadId]);
  return preview;
}

/**
 * A company upload: its staged rows go now and its record stays for audit. A workspace upload
 * ("Delete it now"): everything goes, for its owner only.
 */
export async function deleteUpload(pool: Pool, args: { viewer: Viewer; uploadId: number; now: Date }): Promise<void> {
  const access = requireOnboarding(args.viewer, "delete an upload");
  await withTransaction(pool, async (tx) => {
    const upload = await uploadFor(tx, args.viewer, args.uploadId);
    if (access === "workspace") return deleteWorkspaceUpload(tx, upload.id);
    await purgeRows(tx, args.uploadId, args.now);
    if (upload.status === "staged") await tx.query("update onboarding_uploads set status = 'deleted' where id = $1", [args.uploadId]);
    await audit(tx, args.now, args.viewer, "onboarding_deleted", `onboarding:${args.uploadId}`, { previousStatus: upload.status });
  });
}
