import type { Pool } from "pg";
import { ActionError } from "@/lib/actions";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { withTransaction, type Queryable } from "@/lib/db";
import { LEAD_WRITE_LOCK, ingestRecords } from "@/lib/ingest/ingest";
import { sha256 } from "@/lib/primitives";
import { ForbiddenError, type Viewer } from "@/lib/viewer";
import { suggestMappings, type ApprovedMappingHint, type AssistantResult } from "./assistant";
import { branchValueReport } from "./branches";
import { MappingSpecSchema, compileRows, layoutFingerprint, specHash, validateSpec, type MappingSpec, type RowOutcome, type SpecProblem } from "./compile";
import { proposeValue } from "./vocabulary";
import { branchOfProjection, compareWithLedger, type LedgerComparison } from "./ledger";
import { LIMITS } from "./limits";
import { isRefusal, parseUpload, type ParsedTable } from "./parse";
import { profileTable, type TableProfile } from "./profile";
import { DATASETS, type DatasetId } from "./targets";

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
 */

export interface UploadSummary {
  id: number;
  filename: string;
  format: string;
  byteSize: number;
  rowCount: number;
  columnCount: number;
  status: string;
  uploadedBy: string;
  uploadedAt: string;
  expiresAt: string;
  rowsPurged: boolean;
  layoutFingerprint: string;
  dataset: DatasetId | null;
}

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

function requireOnboardingAccess(viewer: Viewer, action: string, kind: "propose" | "approve" | "either" = "either"): void {
  if (viewer.branchIds !== null) throw new ForbiddenError(`${viewer.label} cannot ${action}: onboarding covers every branch`);
  const ok = kind === "either" ? viewer.can.propose || viewer.can.approve : viewer.can[kind];
  if (!ok) throw new ForbiddenError(`${viewer.label} cannot ${action}`);
}

async function audit(db: Queryable, now: Date, viewer: Viewer, action: string, subject: string, detail: Record<string, unknown>) {
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
     where rows_purged_at is null and expires_at <= $1 returning id`,
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
      "select dataset, version, decided_by, spec from onboarding_mappings where layout_fingerprint = $1 and status = 'approved' order by decided_at desc limit 1",
      [fingerprint],
    )
  ).rows[0];
  return row ? { dataset: row.dataset, hint: { version: row.version, approvedBy: row.decided_by, fields: row.spec.columns } } : null;
}

export async function stageUpload(pool: Pool, args: { viewer: Viewer; filename: string; bytes: Buffer; sheetIndex?: number; now: Date }): Promise<{ upload: UploadSummary } | { refused: { code: string; message: string } }> {
  requireOnboardingAccess(args.viewer, "upload data", "propose");
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
    const meta = { columns: parsed.columns, sourceHeaders: parsed.sourceHeaders, rowRefs: parsed.rowRefs, raggedRows: parsed.raggedRows, warnings: parsed.warnings, encoding: parsed.encoding, delimiter: parsed.delimiter, sheet: parsed.sheet };
    const inserted = await tx.query<{ id: string }>(
      `insert into onboarding_uploads (filename, format, byte_size, file_sha256, sheet_name, uploaded_by, uploaded_role, uploaded_at, expires_at,
         layout_fingerprint, row_count, column_count, table_meta, profile, assistant)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15) returning id`,
      [
        parsed.filename, parsed.format, args.bytes.length, sha256(args.bytes.toString("base64")), parsed.sheet?.name ?? null, args.viewer.label, args.viewer.role, args.now,
        new Date(args.now.getTime() + LIMITS.retentionHours * 3_600_000), fingerprint, parsed.rows.length, parsed.columns.length, meta, profile, assistant,
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
    await audit(tx, args.now, args.viewer, "onboarding_upload", `onboarding:${id}`, { format: parsed.format, rows: parsed.rows.length, columns: parsed.columns.length, fingerprint, suggestedDataset: assistant.dataset.chosen });
    return { upload: await summary(tx, id) };
  });
}

async function summary(db: Queryable, id: number): Promise<UploadSummary> {
  const r = (await summaries(db, "where id = $1", [id]))[0];
  if (!r) throw new ActionError("Upload not found", 404);
  return r;
}

/** Summary columns only: the profile, assistant result and table metadata stay unread (security review #6). */
async function summaries(db: Queryable, where: string, params: unknown[]): Promise<UploadSummary[]> {
  const rows = (
    await db.query<{ id: string; filename: string; format: string; byte_size: number; row_count: number; column_count: number; status: string; uploaded_by: string; uploaded_at: Date; expires_at: Date; rows_purged_at: Date | null; layout_fingerprint: string; dataset: DatasetId | null }>(
      `select id, filename, format, byte_size, row_count, column_count, status, uploaded_by, uploaded_at, expires_at, rows_purged_at, layout_fingerprint,
         assistant->'dataset'->>'chosen' as dataset
       from onboarding_uploads ${where}`,
      params,
    )
  ).rows;
  return rows.map((r) => ({
    id: Number(r.id), filename: r.filename, format: r.format, byteSize: r.byte_size, rowCount: r.row_count, columnCount: r.column_count, status: r.status,
    uploadedBy: r.uploaded_by, uploadedAt: r.uploaded_at.toISOString(), expiresAt: r.expires_at.toISOString(), rowsPurged: r.rows_purged_at !== null,
    layoutFingerprint: r.layout_fingerprint, dataset: r.dataset,
  }));
}

/**
 * Retention is enforced on every use, not only when someone opens a page (security review #4).
 * The purge itself commits on its own, BEFORE the caller's transaction: purging inside a
 * transaction that then refuses would roll the purge back (the first version did exactly that).
 */
async function enforceRetention(pool: Pool, now: Date): Promise<void> {
  await purgeExpired(pool, now);
}

async function loadTable(db: Queryable, id: number, now: Date): Promise<{ table: ParsedTable; upload: UploadSummary }> {
  const upload = await summary(db, id);
  if (upload.rowsPurged || new Date(upload.expiresAt).getTime() <= now.getTime()) {
    throw new ActionError("This upload's rows were deleted (retention or publication). Upload the file again to work on it.", 409);
  }
  const meta = (await db.query<{ table_meta: Omit<ParsedTable, "rows" | "format" | "filename"> }>("select table_meta from onboarding_uploads where id = $1", [id])).rows[0].table_meta;
  const rows = (await db.query<{ cells: Array<string | null> }>("select cells from onboarding_rows where upload_id = $1 order by ordinal", [id])).rows.map((r) => r.cells);
  return { upload, table: { ...meta, rows, format: upload.format as ParsedTable["format"], filename: upload.filename } };
}

export async function listUploads(pool: Pool, viewer: Viewer, now: Date): Promise<UploadSummary[]> {
  requireOnboardingAccess(viewer, "see uploads");
  await purgeExpired(pool, now);
  return summaries(pool, "where status <> 'deleted' order by uploaded_at desc, id desc limit 50", []);
}

export interface UploadDetail {
  upload: UploadSummary;
  table: { columns: string[]; warnings: ParsedTable["warnings"]; encoding: string; delimiter: string | null; sheet: ParsedTable["sheet"]; raggedRows: number };
  profile: TableProfile;
  assistant: AssistantResult;
  mappings: Array<{ id: number; version: number; status: string; specHash: string; proposedBy: string; proposedRole: string; proposedAt: string; decidedBy: string | null; decidedAt: string | null; reason: string | null; spec: MappingSpec; problems: SpecProblem[] }>;
  /** Distinct values of the columns a draft maps to enum and branch fields, with proposed translations. */
  values: Record<string, Array<{ value: string; rows: number; proposed: string | null }>>;
  dryRun: DryRunSummary | null;
  publication: { publishedBy: string; publishedAt: string; stats: Record<string, unknown> } | null;
}

export async function getUpload(pool: Pool, viewer: Viewer, id: number, now: Date, draft?: { dataset: DatasetId; columns: Record<string, string | null> }): Promise<UploadDetail> {
  requireOnboardingAccess(viewer, "see uploads");
  await purgeExpired(pool, now);
  const upload = await summary(pool, id);
  if (upload.status === "deleted") throw new ActionError("Upload not found", 404);
  const row = (await pool.query<{ table_meta: ParsedTable; profile: TableProfile; assistant: AssistantResult }>("select table_meta, profile, assistant from onboarding_uploads where id = $1", [id])).rows[0];
  const mappingRows = (
    await pool.query<{ id: string; version: number; status: string; spec_hash: string; proposed_by: string; proposed_role: string; proposed_at: Date; decided_by: string | null; decided_at: Date | null; decision_reason: string | null; spec: MappingSpec }>(
      "select * from onboarding_mappings where layout_fingerprint = $1 order by version desc",
      [upload.layoutFingerprint],
    )
  ).rows;
  let table: ParsedTable | null = null;
  if (!upload.rowsPurged) table = (await loadTable(pool, id, now)).table;
  const mappings = mappingRows.map((m, i) => ({
    id: Number(m.id), version: m.version, status: m.status, specHash: m.spec_hash, proposedBy: m.proposed_by, proposedRole: m.proposed_role,
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
  requireOnboardingAccess(args.viewer, "propose a mapping", "propose");
  const spec = MappingSpecSchema.parse(args.spec);
  await enforceRetention(pool, args.now);
  return withTransaction(pool, async (tx) => {
    const { table, upload } = await loadTable(tx, args.uploadId, args.now);
    if (upload.status !== "staged") throw new ActionError(`This upload is ${upload.status}`, 409);
    const problems = validateSpec(spec, table);
    const hash = specHash(spec);
    const same = (await tx.query<{ id: string; version: number }>("select id, version from onboarding_mappings where dataset = $1 and layout_fingerprint = $2 and spec_hash = $3 and status in ('proposed', 'approved') order by version desc limit 1", [spec.dataset, upload.layoutFingerprint, hash])).rows[0];
    if (same) return { mappingId: Number(same.id), version: same.version, reused: true, problems };
    // Serialise version numbers per layout.
    await tx.query("select pg_advisory_xact_lock(hashtext($1))", [`onboarding:${spec.dataset}:${upload.layoutFingerprint}`]);
    const version = (await tx.query<{ v: number }>("select coalesce(max(version), 0) + 1 as v from onboarding_mappings where dataset = $1 and layout_fingerprint = $2", [spec.dataset, upload.layoutFingerprint])).rows[0].v;
    const inserted = await tx.query<{ id: string }>(
      `insert into onboarding_mappings (dataset, layout_fingerprint, version, spec, spec_hash, status, drafted_on_upload, proposed_by, proposed_role, proposed_at, proposed_subject)
       values ($1, $2, $3, $4, $5, 'proposed', $6, $7, $8, $9, $10) returning id`,
      [spec.dataset, upload.layoutFingerprint, version, spec, hash, args.uploadId, args.viewer.label, args.viewer.role, args.now, args.viewer.subject],
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
  requireOnboardingAccess(args.viewer, "dry-run an import");
  await enforceRetention(pool, args.now);
  return withTransaction(pool, async (tx) => {
    const { table, upload } = await loadTable(tx, args.uploadId, args.now);
    const m = (await tx.query<{ spec: MappingSpec; spec_hash: string; layout_fingerprint: string; status: string }>("select spec, spec_hash, layout_fingerprint, status from onboarding_mappings where id = $1", [args.mappingId])).rows[0];
    if (!m || m.layout_fingerprint !== upload.layoutFingerprint) throw new ActionError("Mapping not found for this upload's layout", 404);
    if (m.status === "rejected" || m.status === "superseded") throw new ActionError(`Mapping is ${m.status}`, 409);
    const problems = validateSpec(m.spec, table);
    if (problems.length > 0) throw new ActionError(`The mapping is incomplete: ${problems.map((p) => p.message).join("; ")}`, 400);
    const outcomes = scoped(args.viewer, m.spec.dataset, compileRows(table, m.spec, args.now));
    const ledger = await compareWithLedger(tx, m.spec.dataset, outcomes);
    const s = summarise(outcomes, ledger, DATASETS[m.spec.dataset].authority);
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
      };
    });
    for (let i = 0; i < results.length; i += 1000) {
      await tx.query(
        `insert into onboarding_row_results (dry_run_id, row_ref, disposition, code, field, detail, suggestion, safe_to_automate, external_id)
         select $1, r."row_ref", r."disposition", r."code", r."field", r."detail", r."suggestion", r."safe_to_automate", r."external_id"
         from jsonb_to_recordset($2::jsonb) as r("row_ref" int, "disposition" text, "code" text, "field" text, "detail" text, "suggestion" text, "safe_to_automate" boolean, "external_id" text)`,
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

export async function rowResults(pool: Pool, viewer: Viewer, args: { uploadId: number; disposition?: string; page: number }) {
  requireOnboardingAccess(viewer, "see row results");
  // A deleted upload is gone for readers too (security review #4).
  const upload = await summary(pool, args.uploadId);
  if (upload.status === "deleted") throw new ActionError("Upload not found", 404);
  const dry = await latestDryRun(pool, args.uploadId);
  if (!dry) return { rows: [], total: 0, pageSize: 50 };
  const where = args.disposition ? "and disposition = $2" : "and $2::text is null";
  const total = (await pool.query<{ n: number }>(`select count(*)::int as n from onboarding_row_results where dry_run_id = $1 ${where}`, [dry.id, args.disposition ?? null])).rows[0].n;
  const rows = (
    await pool.query(
      `select row_ref, disposition, code, field, detail, suggestion, safe_to_automate, raw_event_id from onboarding_row_results where dry_run_id = $1 ${where} order by row_ref limit 50 offset $3`,
      [dry.id, args.disposition ?? null, Math.max(0, args.page - 1) * 50],
    )
  ).rows;
  return { rows, total, pageSize: 50 };
}

export async function decideMapping(pool: Pool, args: { viewer: Viewer; mappingId: number; decision: "approve" | "reject"; reason: string; now: Date }): Promise<{ status: string }> {
  requireOnboardingAccess(args.viewer, "approve a mapping", "approve");
  return withTransaction(pool, async (tx) => {
    const m = (await tx.query<{ status: string; proposed_role: string; proposed_subject: string; dataset: string; layout_fingerprint: string }>("select status, proposed_role, proposed_subject, dataset, layout_fingerprint from onboarding_mappings where id = $1 for update", [args.mappingId])).rows[0];
    if (!m) throw new ActionError("Mapping not found", 404);
    if (m.status !== "proposed") throw new ActionError(`Mapping is already ${m.status}`, 409);
    // A different person and a different role (the database refuses the same subject: 0014).
    if (m.proposed_subject === args.viewer.subject) throw new ForbiddenError("You proposed this mapping, so someone else must decide it");
    if (m.proposed_role === args.viewer.role) throw new ForbiddenError("The role that proposed a mapping cannot decide it");
    if (args.decision === "approve") {
      await tx.query("update onboarding_mappings set status = 'superseded', decided_at = coalesce(decided_at, $3) where dataset = $1 and layout_fingerprint = $2 and status = 'approved'", [m.dataset, m.layout_fingerprint, args.now]);
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
  requireOnboardingAccess(args.viewer, "publish an import", "approve");
  await enforceRetention(pool, args.now);
  return withTransaction(pool, async (tx) => {
    await tx.query("select id from onboarding_uploads where id = $1 for update", [args.uploadId]);
    // Status before rows: a published upload's rows are gone, and "already published" is the answer.
    const current = await summary(tx, args.uploadId);
    if (current.status !== "staged") throw new ActionError(`This upload is ${current.status}`, 409);
    const { table } = await loadTable(tx, args.uploadId, args.now);
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

export async function deleteUpload(pool: Pool, args: { viewer: Viewer; uploadId: number; now: Date }): Promise<void> {
  requireOnboardingAccess(args.viewer, "delete an upload");
  await withTransaction(pool, async (tx) => {
    const upload = await summary(tx, args.uploadId);
    await purgeRows(tx, args.uploadId, args.now);
    if (upload.status === "staged") await tx.query("update onboarding_uploads set status = 'deleted' where id = $1", [args.uploadId]);
    await audit(tx, args.now, args.viewer, "onboarding_deleted", `onboarding:${args.uploadId}`, { previousStatus: upload.status });
  });
}
