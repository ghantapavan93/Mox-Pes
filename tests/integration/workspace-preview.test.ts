import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { withTransaction } from "@/lib/db";
import { dashboardSnapshot, type DashboardSnapshot } from "@/lib/metrics/dashboard-snapshot";
import { getUpload, previewUpload, proposeMapping, runDryRun, stageWorkspaceUpload, type UploadDetail } from "@/lib/onboarding/service";
import { seed } from "@/lib/sim/seed";
import { workspaceViewer, type Viewer } from "@/lib/viewer";
import { subjectOf } from "@/lib/workspace";
import { testPool } from "../helpers";

/**
 * A visitor's file, counted in a private copy (lib/onboarding/service.ts, previewUpload): the
 * dashboard's figures move for that visitor, in a copy that is rolled back, and nobody else's do.
 * The file is public/samples/missed-calls-b01.csv: paid calls for B01 Alder's eight October
 * customers who have no lead record (scripts/make-missed-calls.ts), on the seeded world.
 */

const pool = testPool();
const NOW = new Date("2026-10-31T13:00:00Z");
const MISSED = readFileSync(path.join(process.cwd(), "public", "samples", "missed-calls-b01.csv"));
const visitor = (letter: string) => workspaceViewer(subjectOf(letter.repeat(43)));
const A = visitor("p");
const B = visitor("q");

function specFor(detail: UploadDetail) {
  return {
    dataset: detail.assistant.dataset.chosen,
    columns: Object.fromEntries(detail.assistant.fields.map((f) => [f.field, f.status === "suggested" ? f.column : null])),
    constants: {},
    valueMaps: Object.fromEntries(Object.entries(detail.values).map(([k, v]) => [k, Object.fromEntries(v.filter((x) => x.proposed).map((x) => [x.value, x.proposed]))])),
    dateOrder: "MDY",
    localTime: "branch_local",
    moneyMeaning: {},
    exportedAt: null,
  };
}

/** Stage, map and dry-run a file as a visitor does. */
async function dryRun(viewer: Viewer, bytes: Buffer, filename: string) {
  const staged = await stageWorkspaceUpload(pool, { viewer, filename, bytes, now: NOW });
  if (!("upload" in staged)) throw new Error(`not staged: ${JSON.stringify(staged)}`);
  const id = staged.upload.id;
  const detail = await getUpload(pool, viewer, id, NOW);
  const mapping = await proposeMapping(pool, { viewer, uploadId: id, spec: specFor(detail), now: NOW });
  const dry = await runDryRun(pool, { viewer, uploadId: id, mappingId: mapping.mappingId, now: NOW });
  return { id, mappingId: mapping.mappingId, dry };
}

let shared: DashboardSnapshot;
let upload: Awaited<ReturnType<typeof dryRun>>;

beforeAll(async () => {
  await seed(pool);
  shared = await dashboardSnapshot(pool);
  upload = await dryRun(A, MISSED, "missed-calls-b01.csv");
}, 300_000);

afterAll(async () => {
  await pool.end();
});

describe("a visitor's file, counted in a private copy", () => {
  it("the dry run reads all eight calls as new", () => {
    expect(upload.dry.total).toBe(8);
    expect(upload.dry.publishable).toBe(8);
  });

  it("moves B01's figures for that visitor: eight customers gain the paid touch that brought them", async () => {
    const preview = await previewUpload(pool, { viewer: A, uploadId: upload.id, now: NOW });
    expect(preview.counted).toMatchObject({ rows: 8, inserted: 8, skipped: 0 });
    const b01 = preview.change.branches.find((b) => b.after.branchId === "B01");
    expect(b01, "B01 moved").toBeDefined();
    expect(b01!.after.paidAcquired - b01!.before.paidAcquired).toBe(8);
    expect(b01!.before.unknownAcquired - b01!.after.unknownAcquired).toBe(8);
    expect(b01!.after.acquired).toBe(b01!.before.acquired);
    expect(b01!.after.paidSpendCents).toBe(b01!.before.paidSpendCents);
    expect(b01!.after.paidCacCents!).toBeLessThan(b01!.before.paidCacCents!);
    // The company: the same eight customers, the same spend.
    const { before, after } = preview.change.company;
    expect(after.paidAcquired - before.paidAcquired).toBe(8);
    expect(after.paidSpendCents).toBe(before.paidSpendCents);
    expect(after.paidCacCents!).toBeLessThan(before.paidCacCents!);
    // Kept on the visitor's own dry run.
    const kept = (await pool.query<{ preview: unknown }>("select summary->'preview' as preview from onboarding_dry_runs where id = $1", [upload.dry.id])).rows[0].preview;
    expect(kept).toEqual(JSON.parse(JSON.stringify(preview)));
  });

  it("moves nobody else's: the shared dashboard reads exactly as before, and no row of the file stayed", async () => {
    expect(await dashboardSnapshot(pool)).toEqual(shared);
    const kept = await pool.query("select 1 from raw_events where source = 'calls' and external_id like 'MISS%'");
    expect(kept.rowCount).toBe(0);
  });

  it("is the visitor's own: another visitor cannot count it", async () => {
    await expect(previewUpload(pool, { viewer: B, uploadId: upload.id, now: NOW })).rejects.toMatchObject({ status: 404 });
  });

  it("answers busy, without waiting, while another copy or a reconciliation holds the lock", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const holder = withTransaction(pool, async (tx) => {
      await tx.query("select pg_advisory_xact_lock(742001)");
      await held;
    });
    // Let the holder take the lock first.
    for (let i = 0; i < 50; i++) {
      const r = await pool.query("select 1 from pg_locks where locktype = 'advisory' and objid = 742001 and granted");
      if (r.rowCount) break;
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    const t0 = Date.now();
    await expect(previewUpload(pool, { viewer: A, uploadId: upload.id, now: NOW })).rejects.toMatchObject({ status: 503 });
    expect(Date.now() - t0, "it did not queue").toBeLessThan(5_000);
    release();
    await holder;
  });

  it("goes with its dry run: a new dry run starts without one", async () => {
    const again = await runDryRun(pool, { viewer: A, uploadId: upload.id, mappingId: upload.mappingId, now: NOW });
    expect(again.preview ?? null).toBeNull();
  });
});
