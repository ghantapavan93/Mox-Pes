import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { resolveIdentities } from "@/lib/identity";
import { dataAsOf, dataTimes, freshness } from "@/lib/metrics/scorecard";
import { WORKSPACE_NOT_AVAILABLE } from "@/lib/onboarding/access";
import {
  decideMapping,
  deleteUpload,
  getUpload,
  listUploads,
  proposeMapping,
  publishUpload,
  purgeExpired,
  rowResults,
  runDryRun,
  stageUpload,
  stageWorkspaceUpload,
  type UploadDetail,
} from "@/lib/onboarding/service";
import { ForbiddenError, VIEWERS, workspaceViewer, type Viewer } from "@/lib/viewer";
import { WORKSPACE, deleteWorkspaceUploads, subjectOf } from "@/lib/workspace";
import { manyCallsCsv } from "../fixtures/onboarding/unseen";
import { call, freshDb, ingest, one, testPool } from "../helpers";

/**
 * The visitor workspace (release design §5.2): a guest's uploads are its own, are never counted or
 * audited, live 24 hours on the wall clock, and are bounded by the quotas and the held-row budget.
 * The company data is seeded once; every case removes the workspace items and quota counters it
 * made, so no case leaks into the next. Time is moved by backdating `workspace_started_at`, never
 * by waiting.
 */

const route = vi.hoisted(() => ({ pool: null as unknown as Pool, viewer: null as unknown as Viewer }));
vi.mock("@/lib/server", () => ({
  getPool: () => route.pool,
  getViewer: async () => route.viewer,
  businessNow: async () => new Date("2026-10-31T13:00:00Z"),
  viewerForWorkspaceStart: async () => ({ viewer: route.viewer, setCookie: null }),
}));
vi.mock("next/server", async (importOriginal) => ({ ...(await importOriginal<typeof import("next/server")>()), connection: async () => {} }));

import { POST as postUpload } from "@/app/api/onboarding/uploads/route";
import { GET as cleanupRoute } from "@/app/api/workspace/cleanup/route";

const pool = testPool();
route.pool = pool;
const NOW = new Date("2026-10-31T13:00:00Z");
const SAMPLE = readFileSync(path.join(process.cwd(), "public", "samples", "demo-calls.csv"));
/** The sample with one more row: the same layout, but not the built-in sample, so no exemption. */
const NOT_SAMPLE = Buffer.from(`${SAMPLE.toString("utf8")}10/22/2026 9:00 AM,Alder,(206) 555-0199,(206) 555-0150,Google Ads,,10,Answered,DEMO10099,\n`);

const visitor = (letter: string) => workspaceViewer(subjectOf(letter.repeat(43)));
const A = visitor("a");
const B = visitor("b");
const { marketing, approver } = VIEWERS;

let companyUpload = 0;
let companyMapping = 0;

function specFor(detail: UploadDetail, answers: Record<string, unknown> = {}) {
  return {
    dataset: detail.assistant.dataset.chosen,
    columns: Object.fromEntries(detail.assistant.fields.map((f) => [f.field, f.status === "suggested" ? f.column : null])),
    constants: {},
    valueMaps: Object.fromEntries(Object.entries(detail.values).map(([k, v]) => [k, Object.fromEntries(v.filter((x) => x.proposed).map((x) => [x.value, x.proposed]))])),
    dateOrder: "MDY",
    localTime: "branch_local",
    moneyMeaning: {},
    exportedAt: null,
    ...answers,
  };
}

async function stage(viewer: Viewer, bytes: Buffer = SAMPLE) {
  const staged = await stageWorkspaceUpload(pool, { viewer, filename: "demo-calls.csv", bytes, now: NOW });
  if (!("upload" in staged)) throw new Error(`not staged: ${JSON.stringify(staged)}`);
  return staged.upload.id;
}

/** Stage, answer the two questions, save the mapping and dry-run it, as a visitor does. */
async function journey(viewer: Viewer, bytes: Buffer = SAMPLE) {
  const id = await stage(viewer, bytes);
  const detail = await getUpload(pool, viewer, id, NOW);
  const mapping = await proposeMapping(pool, { viewer, uploadId: id, spec: specFor(detail), now: NOW });
  const dry = await runDryRun(pool, { viewer, uploadId: id, mappingId: mapping.mappingId, now: NOW });
  return { id, mappingId: mapping.mappingId, dryRunId: dry.id, spec: specFor(detail) };
}

const n = async (sql: string, params: unknown[] = []) => (await one<{ n: number }>(pool, `select count(*)::int as n from ${sql}`, params)).n;

/** Every row an upload left in the five onboarding tables. */
async function leftovers(uploadId: number, dryRunIds: number[]) {
  return {
    uploads: await n("onboarding_uploads where id = $1", [uploadId]),
    rows: await n("onboarding_rows where upload_id = $1", [uploadId]),
    mappings: await n("onboarding_mappings where drafted_on_upload = $1", [uploadId]),
    dryRuns: await n("onboarding_dry_runs where upload_id = $1", [uploadId]),
    rowResults: await n("onboarding_row_results where dry_run_id = any($1::bigint[])", [dryRunIds]),
  };
}
const NOTHING_LEFT = { uploads: 0, rows: 0, mappings: 0, dryRuns: 0, rowResults: 0 };

/** A workspace upload written directly, to fill the held-row budget without staging real rows. */
async function heldUpload(owner: string, rows: number, minutesAgo: number): Promise<number> {
  const r = await one<{ id: string }>(
    pool,
    `insert into onboarding_uploads (filename, format, byte_size, file_sha256, uploaded_by, uploaded_role, uploaded_at, expires_at, layout_fingerprint,
       row_count, column_count, table_meta, profile, assistant, workspace_owner, workspace_started_at)
     values ('held.csv', 'csv', 1, md5(random()::text), 'Guest · your workspace', 'guest', $1, $1::timestamptz + interval '24 hours', 'held',
       $2, 1, '{}', '{}', '{}', $3, now() - make_interval(mins => $4)) returning id`,
    [NOW, rows, owner, minutesAgo],
  );
  return Number(r.id);
}

/** Everything a visitor must never change: the ledger, the audit log, the company's onboarding, the data times. */
async function shared() {
  const counts: Record<string, number> = {};
  for (const t of ["raw_events", "leads", "ad_spend_daily", "crm_payments", "crm_customers", "audit_log"]) counts[t] = await n(t);
  counts.companyUploads = await n("onboarding_uploads where workspace_owner is null");
  counts.companyMappings = await n("onboarding_mappings where workspace_owner is null");
  counts.companyDryRuns = await n("onboarding_dry_runs d join onboarding_uploads u on u.id = d.upload_id where u.workspace_owner is null");
  counts.companyRowResults = await n("onboarding_row_results r join onboarding_dry_runs d on d.id = r.dry_run_id join onboarding_uploads u on u.id = d.upload_id where u.workspace_owner is null");
  return { counts, times: await dataTimes(pool), asOf: dataAsOf(await freshness(pool)) };
}

/** Starts a minute-sensitive case early in a minute, so the minute bucket cannot roll over mid-case. */
async function earlyInMinute() {
  const s = new Date().getUTCSeconds();
  if (s > 45) await new Promise((r) => setTimeout(r, (61 - s) * 1000));
}

beforeAll(async () => {
  await freshDb(pool);
  for (const [source, stream] of [["calls", "calls"], ["crm", "crm.customer"]] as const) {
    await pool.query(
      `insert into ingestion_runs (source, stream, adapter_version, started_at, finished_at, status)
       values ($1, $2, $3, '2026-10-31T07:55:00Z', '2026-10-31T08:00:00Z', 'succeeded')`,
      [source, stream, `${source}@1.0`],
    );
  }
  // The sample's first call is already in the ledger, with an identity: its row is compared, and links.
  await ingest(pool, "calls", [call("DEMO10001", "B01", "+12065550101", new Date("2026-10-20T16:14:00Z"), "Google Ads")]);
  await resolveIdentities(pool, NOW);
  // A company upload with a company mapping, which no visitor may open or use.
  const staged = await stageUpload(pool, { viewer: marketing, filename: "demo-calls.csv", bytes: SAMPLE, now: NOW });
  if (!("upload" in staged)) throw new Error("company upload refused");
  companyUpload = staged.upload.id;
  const detail = await getUpload(pool, marketing, companyUpload, NOW);
  companyMapping = (await proposeMapping(pool, { viewer: marketing, uploadId: companyUpload, spec: specFor(detail), now: NOW })).mappingId;
  await runDryRun(pool, { viewer: marketing, uploadId: companyUpload, mappingId: companyMapping, now: NOW });
});

afterEach(async () => {
  await pool.query("delete from workspace_quota");
  const ids = (await pool.query<{ id: string }>("select id from onboarding_uploads where workspace_owner is not null")).rows.map((r) => Number(r.id));
  await deleteWorkspaceUploads(pool, ids);
});

afterAll(async () => {
  await pool.end();
});

describe("each visitor sees only its own workspace", () => {
  it("two visitors with the same file and answers each get their own upload, mapping, ordinal and result", async () => {
    const a = await journey(A);
    const b = await journey(B);
    expect(a.id).not.toBe(b.id);
    expect(a.mappingId).not.toBe(b.mappingId);

    const da = await getUpload(pool, A, a.id, NOW);
    expect(da.mappings.map((m) => ({ id: m.id, ordinal: m.ordinal }))).toEqual([{ id: a.mappingId, ordinal: 1 }]);
    expect(da.dryRun?.id).toBe(a.dryRunId);
    expect(da.upload.workspaceStartedAt).not.toBeNull();
    const db = await getUpload(pool, B, b.id, NOW);
    expect(db.mappings.map((m) => m.ordinal)).toEqual([1]);

    // Neither resolves the other's upload, mapping, rows or delete: one 404, the same words.
    const notAvailable = { status: 404, message: WORKSPACE_NOT_AVAILABLE };
    await expect(getUpload(pool, A, b.id, NOW)).rejects.toMatchObject(notAvailable);
    await expect(getUpload(pool, B, a.id, NOW)).rejects.toMatchObject(notAvailable);
    await expect(rowResults(pool, A, { uploadId: b.id, page: 1 })).rejects.toMatchObject(notAvailable);
    await expect(runDryRun(pool, { viewer: A, uploadId: a.id, mappingId: b.mappingId, now: NOW })).rejects.toMatchObject({ status: 404 });
    await expect(runDryRun(pool, { viewer: A, uploadId: b.id, mappingId: b.mappingId, now: NOW })).rejects.toMatchObject(notAvailable);
    await expect(proposeMapping(pool, { viewer: A, uploadId: b.id, spec: b.spec, now: NOW })).rejects.toMatchObject(notAvailable);
    await expect(deleteUpload(pool, { viewer: A, uploadId: b.id, now: NOW })).rejects.toMatchObject(notAvailable);
    expect((await listUploads(pool, A, NOW)).map((u) => u.id)).toEqual([a.id]);
    expect((await listUploads(pool, B, NOW)).map((u) => u.id)).toEqual([b.id]);
    // A guest without a token owns nothing and sees nothing.
    expect(await listUploads(pool, workspaceViewer(null), NOW)).toEqual([]);
  });

  it("a row the ledger holds links to its record, which the guest may open", async () => {
    const a = await journey(A);
    const rows = await rowResults(pool, A, { uploadId: a.id, page: 1 });
    const compared = rows.rows.filter((r) => r.disposition === "matches_ledger" || r.disposition === "differs_from_ledger");
    expect(compared).toHaveLength(1);
    expect(compared[0].ledger_href).toMatch(/^\/customers\/P-\d+$/);
    expect(rows.rows.filter((r) => r.ledger_href !== null)).toHaveLength(1);
  });

  it("staff and visitors never open each other's uploads or mappings", async () => {
    const a = await journey(A);
    await expect(getUpload(pool, marketing, a.id, NOW)).rejects.toMatchObject({ status: 404, message: "Upload not found" });
    await expect(rowResults(pool, approver, { uploadId: a.id, page: 1 })).rejects.toMatchObject({ status: 404 });
    expect((await listUploads(pool, marketing, NOW)).map((u) => u.id)).not.toContain(a.id);
    await expect(getUpload(pool, A, companyUpload, NOW)).rejects.toMatchObject({ status: 404, message: WORKSPACE_NOT_AVAILABLE });
    await expect(runDryRun(pool, { viewer: A, uploadId: a.id, mappingId: companyMapping, now: NOW })).rejects.toMatchObject({ status: 404 });
    // A staff upload cannot be dry-run with a visitor's mapping either.
    await expect(runDryRun(pool, { viewer: marketing, uploadId: companyUpload, mappingId: a.mappingId, now: NOW })).rejects.toMatchObject({ status: 404 });
    await expect(decideMapping(pool, { viewer: approver, mappingId: a.mappingId, decision: "approve", reason: "looks right", now: NOW })).rejects.toMatchObject({
      status: 409,
      message: "A workspace mapping cannot be approved",
    });
    await expect(decideMapping(pool, { viewer: A, mappingId: a.mappingId, decision: "approve", reason: "mine", now: NOW })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(publishUpload(pool, { viewer: A, uploadId: a.id, dryRunId: a.dryRunId, now: NOW })).rejects.toBeInstanceOf(ForbiddenError);
    // Nothing is ever stored under the token-less guest.
    await expect(stageWorkspaceUpload(pool, { viewer: workspaceViewer(null), filename: "x.csv", bytes: SAMPLE, now: NOW })).rejects.toThrow(/its own token/);
  });

  it("a visitor's whole journey changes no shared figure, record or data time", async () => {
    const before = await shared();
    const a = await journey(A);
    await runDryRun(pool, { viewer: A, uploadId: a.id, mappingId: a.mappingId, now: NOW });
    await rowResults(pool, A, { uploadId: a.id, page: 1 });
    await deleteUpload(pool, { viewer: A, uploadId: a.id, now: NOW });
    expect(await shared()).toEqual(before);
  });
});

describe("repeats and retries", () => {
  it("the same bytes from the same visitor open the earlier upload; from another visitor they stage anew", async () => {
    const first = await stage(A);
    const again = await stageWorkspaceUpload(pool, { viewer: A, filename: "renamed.csv", bytes: SAMPLE, now: NOW });
    expect(again).toEqual({ repeatOf: { id: first, startedAt: expect.any(String) } });
    expect(await n("onboarding_uploads where workspace_owner = $1", [A.subject])).toBe(1);
    const other = await stageWorkspaceUpload(pool, { viewer: B, filename: "demo-calls.csv", bytes: SAMPLE, now: NOW });
    expect("upload" in other && other.upload.id).not.toBe(first);
  });

  it("the route answers a repeat 200 with repeatOf, and a new file 201", async () => {
    route.viewer = A;
    const send = (bytes: Buffer) => postUpload(new Request("http://localhost/api/onboarding/uploads", { method: "POST", body: new Uint8Array(bytes), headers: { "x-filename": "demo-calls.csv", "content-type": "application/octet-stream" } }));
    const created = await send(SAMPLE);
    expect(created.status).toBe(201);
    const id = ((await created.json()) as { upload: { id: number } }).upload.id;
    const repeated = await send(SAMPLE);
    expect(repeated.status).toBe(200);
    expect(((await repeated.json()) as { repeatOf: { id: number } }).repeatOf.id).toBe(id);
  });

  it("two concurrent stages of one file by one visitor stage it once", async () => {
    const results = await Promise.all([1, 2].map(() => stageWorkspaceUpload(pool, { viewer: A, filename: "demo-calls.csv", bytes: SAMPLE, now: NOW })));
    expect(results.filter((r) => "upload" in r)).toHaveLength(1);
    expect(results.filter((r) => "repeatOf" in r)).toHaveLength(1);
  });
});

describe("limits and quotas", () => {
  it("refuses a file over 4 MB at the route and in the service, naming its size", async () => {
    route.viewer = A;
    const big = Buffer.alloc(WORKSPACE.maxBytes + 1, 0x61);
    const res = await postUpload(new Request("http://localhost/api/onboarding/uploads", { method: "POST", body: new Uint8Array(big), headers: { "x-filename": "big.csv" } }));
    expect(res.status).toBe(413);
    expect(((await res.json()) as { error: string }).error).toMatch(/the public demo takes files up to 4 MB\.$/);
    const direct = await stageWorkspaceUpload(pool, { viewer: A, filename: "big.csv", bytes: big, now: NOW });
    expect(direct).toEqual({ refused: { code: "TOO_LARGE", status: 413, message: "This file is 4.1 MB; the public demo takes files up to 4 MB." } });
  });

  it("refuses a file over 10,000 rows with the count and what to do", async () => {
    const r = await stageWorkspaceUpload(pool, { viewer: A, filename: "many.csv", bytes: Buffer.from(manyCallsCsv(10_001)), now: NOW });
    expect(r).toEqual({
      refused: {
        code: "TOO_MANY_ROWS",
        status: 422,
        message: "The public demo takes files up to 10,000 rows; this file has 10,001. Upload one month at a time, or run the local demo for files up to 50,000 rows.",
      },
    });
    expect(await n("onboarding_uploads where workspace_owner = $1", [A.subject])).toBe(0);
  });

  it("refuses the 31st start in a minute, counts the refusal, and writes no audit entry", async () => {
    await earlyInMinute();
    await pool.query("insert into workspace_quota (kind, bucket, starts_at, items) values ('upload', 'minute', date_trunc('minute', now()), 29)");
    const audit = await n("audit_log");
    expect("upload" in (await stageWorkspaceUpload(pool, { viewer: A, filename: "demo-calls.csv", bytes: SAMPLE, now: NOW }))).toBe(true);
    const refused = await stageWorkspaceUpload(pool, { viewer: B, filename: "demo-calls.csv", bytes: SAMPLE, now: NOW });
    expect(refused).toEqual({ refused: { code: "AT_CAPACITY", status: 429, message: "The public demo is at capacity for uploads. Try again in a minute." } });
    expect((await one<{ items: number }>(pool, "select items from workspace_quota where kind = 'upload' and bucket = 'minute' and starts_at = date_trunc('minute', now())")).items).toBe(31);
    expect(await n("audit_log")).toBe(audit);
    expect(await n("onboarding_uploads where workspace_owner = $1", [B.subject])).toBe(0);
  });

  it("refuses a file once the day's rows are spent, while the built-in sample still stages", async () => {
    await pool.query("insert into workspace_quota (kind, bucket, starts_at, rows) values ('upload', 'day', date_trunc('day', now()), $1)", [WORKSPACE.rowsWrittenPerDay]);
    const refused = await stageWorkspaceUpload(pool, { viewer: A, filename: "calls.csv", bytes: NOT_SAMPLE, now: NOW });
    expect(refused).toMatchObject({ refused: { status: 429, message: expect.stringMatching(/handled its share of files for today; the built-in sample still works/) } });
    expect("upload" in (await stageWorkspaceUpload(pool, { viewer: A, filename: "demo-calls.csv", bytes: SAMPLE, now: NOW }))).toBe(true);
  });

  it("counts a dry run's rows too, and refuses it past the cap", async () => {
    const id = await stage(A, NOT_SAMPLE);
    const detail = await getUpload(pool, A, id, NOW);
    const { mappingId } = await proposeMapping(pool, { viewer: A, uploadId: id, spec: specFor(detail), now: NOW });
    await pool.query("insert into workspace_quota (kind, bucket, starts_at, rows) values ('upload', 'day', date_trunc('day', now()), $1) on conflict (kind, bucket, starts_at) do update set rows = excluded.rows", [WORKSPACE.rowsWrittenPerDay]);
    await expect(runDryRun(pool, { viewer: A, uploadId: id, mappingId, now: NOW })).rejects.toMatchObject({ status: 429 });
    expect(await n("onboarding_dry_runs where upload_id = $1", [id])).toBe(0);
  });

  it("makes room by deleting just enough of the oldest uploads past their 30 minutes", async () => {
    const oldest = await heldUpload(B.subject, 25_000, 90);
    const older = await heldUpload(B.subject, 25_000, 60);
    expect("upload" in (await stageWorkspaceUpload(pool, { viewer: A, filename: "demo-calls.csv", bytes: SAMPLE, now: NOW }))).toBe(true);
    expect(await n("onboarding_uploads where id = $1", [oldest])).toBe(0);
    expect(await n("onboarding_uploads where id = $1", [older])).toBe(1);
  });

  it("refuses with 503 when only uploads younger than 30 minutes hold the budget, deleting none", async () => {
    const young = [await heldUpload(B.subject, 25_000, 5), await heldUpload(B.subject, 25_000, 10)];
    const r = await stageWorkspaceUpload(pool, { viewer: A, filename: "demo-calls.csv", bytes: SAMPLE, now: NOW });
    expect(r).toEqual({ refused: { code: "FULL", status: 503, message: "The public demo is full right now. Try again in a few minutes." } });
    expect(await n("onboarding_uploads where id = any($1::bigint[])", [young])).toBe(2);
  });

  it("two concurrent stages at the budget's edge never both pass", async () => {
    // Room for exactly one sample: 12 rows count 24 against the budget.
    await heldUpload(B.subject, (WORKSPACE.heldRowBudget - 24) / 2, 5);
    const results = await Promise.all([A, visitor("c")].map((viewer) => stageWorkspaceUpload(pool, { viewer, filename: "demo-calls.csv", bytes: SAMPLE, now: NOW })));
    expect(results.filter((r) => "upload" in r)).toHaveLength(1);
    expect(results.filter((r) => "refused" in r && r.refused.status === 503)).toHaveLength(1);
  });

  it("allows 10 mappings per upload and refuses the 11th; a repeated mapping is reused, not counted", async () => {
    const a = await journey(A);
    const detail = await getUpload(pool, A, a.id, NOW);
    for (let i = 1; i <= 9; i++) {
      const r = await proposeMapping(pool, { viewer: A, uploadId: a.id, spec: specFor(detail, { exportedAt: `2026-10-31T${String(i).padStart(2, "0")}:00:00Z` }), now: NOW });
      expect(r.reused).toBe(false);
    }
    expect((await getUpload(pool, A, a.id, NOW)).mappings.map((m) => m.ordinal)).toEqual([10, 9, 8, 7, 6, 5, 4, 3, 2, 1]);
    expect((await proposeMapping(pool, { viewer: A, uploadId: a.id, spec: a.spec, now: NOW })).reused).toBe(true);
    await expect(proposeMapping(pool, { viewer: A, uploadId: a.id, spec: specFor(detail, { exportedAt: "2026-10-31T11:00:00Z" }), now: NOW })).rejects.toMatchObject({
      status: 409,
      message: "This upload has reached the 10-version limit. Delete it, then upload the file again.",
    });
  });
});

describe("one result per upload, and deletion", () => {
  it("a second dry run replaces the first", async () => {
    const a = await journey(A);
    const second = await runDryRun(pool, { viewer: A, uploadId: a.id, mappingId: a.mappingId, now: NOW });
    expect(second.id).not.toBe(a.dryRunId);
    expect(await n("onboarding_dry_runs where upload_id = $1", [a.id])).toBe(1);
    expect(await n("onboarding_row_results where dry_run_id = $1", [a.dryRunId])).toBe(0);
    expect(await n("onboarding_row_results where dry_run_id = $1", [second.id])).toBe(12);
  });

  it("\"Delete it now\" leaves nothing in any of the five tables", async () => {
    const a = await journey(A);
    await deleteUpload(pool, { viewer: A, uploadId: a.id, now: NOW });
    expect(await leftovers(a.id, [a.dryRunId])).toEqual(NOTHING_LEFT);
    await expect(getUpload(pool, A, a.id, NOW)).rejects.toMatchObject({ status: 404, message: WORKSPACE_NOT_AVAILABLE });
  });
});

describe("expiry", () => {
  it("an upload 25 hours old cannot be opened at once, and is gone after the next onboarding request", async () => {
    const a = await journey(A);
    await pool.query("update onboarding_uploads set workspace_started_at = now() - interval '25 hours' where id = $1", [a.id]);
    // rowResults runs no cleanup: the read itself refuses an expired item.
    await expect(rowResults(pool, A, { uploadId: a.id, page: 1 })).rejects.toMatchObject({ status: 404, message: WORKSPACE_NOT_AVAILABLE });
    expect((await leftovers(a.id, [a.dryRunId])).uploads).toBe(1);
    expect(await listUploads(pool, A, NOW)).toEqual([]);
    expect(await leftovers(a.id, [a.dryRunId])).toEqual(NOTHING_LEFT);
  });

  it("the daily cleanup deletes only expired items and quota rows older than two days", async () => {
    const expired = await heldUpload(A.subject, 5, 25 * 60);
    const live = await heldUpload(A.subject, 5, 10);
    await pool.query(
      "insert into workspace_quota (kind, bucket, starts_at, items) values ('upload', 'day', date_trunc('day', now()) - interval '3 days', 1), ('upload', 'day', date_trunc('day', now()) - interval '1 day', 1)",
    );
    const res = await cleanupRoute();
    expect(await res.json()).toEqual({ deleted: { uploads: 1, investigations: 0, quotaRows: 1 } });
    expect(await n("onboarding_uploads where id = $1", [expired])).toBe(0);
    expect(await n("onboarding_uploads where id = $1", [live])).toBe(1);
    expect(await n("workspace_quota")).toBe(1);
    // Idempotent: nothing left to do.
    expect(await (await cleanupRoute()).json()).toEqual({ deleted: { uploads: 0, investigations: 0, quotaRows: 0 } });
  });

  it("the business-clock purge leaves workspace uploads to their own clock", async () => {
    const id = await stage(A);
    await purgeExpired(pool, new Date("2027-01-01T00:00:00Z"));
    expect(await one(pool, "select status, rows_purged_at from onboarding_uploads where id = $1", [id])).toEqual({ status: "staged", rows_purged_at: null });
    expect(await n("onboarding_rows where upload_id = $1", [id])).toBe(12);
  });
});
