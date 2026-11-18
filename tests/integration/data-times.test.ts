import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { enqueueSync } from "@/lib/jobs/sync";
import { dataAsOf, dataTimes, freshness, type DataTimes } from "@/lib/metrics/scorecard";
import { decideMapping, getUpload, proposeMapping, publishUpload, runDryRun, stageUpload } from "@/lib/onboarding/service";
import { VIEWERS } from "@/lib/viewer";
import { freshDb, one, testPool } from "../helpers";

/**
 * The data times (release design §5.4) read only what is stored, and only the right stored facts
 * move them: a succeeded polling run or sync job, and a publication that inserted a record.
 */

const pool = testPool();
const BUSINESS_NOW = new Date("2026-10-31T13:00:00Z");
const WALL = new Date("2026-11-18T15:41:00Z");

afterAll(async () => {
  await pool.end();
});

beforeEach(async () => {
  await freshDb(pool);
  // One polling run per stream, as the seed records them (business clock).
  for (const [source, stream] of [["calls", "calls"], ["crm", "crm.customer"]] as const) {
    await pool.query(
      `insert into ingestion_runs (source, stream, adapter_version, started_at, finished_at, status)
       values ($1, $2, $3, '2026-10-31T07:55:00Z', '2026-10-31T08:00:00Z', 'succeeded')`,
      [source, stream, `${source}@1.0`],
    );
  }
});

async function snapshot(): Promise<{ times: DataTimes; asOf: Date | null }> {
  return { times: await dataTimes(pool), asOf: dataAsOf(await freshness(pool)) };
}

const sample = (file: string) => readFileSync(path.join(process.cwd(), "public", "samples", file));

/** Stages a sample as the marketing analyst and dry-runs the assistant's mapping with the standard answers. */
async function stageAndDryRun(file: string, answers: Record<string, unknown> = {}) {
  const staged = await stageUpload(pool, { viewer: VIEWERS.marketing, filename: file, bytes: sample(file), now: BUSINESS_NOW });
  if (!("upload" in staged)) throw new Error(`not staged: ${JSON.stringify(staged)}`);
  const id = staged.upload.id;
  const detail = await getUpload(pool, VIEWERS.marketing, id, BUSINESS_NOW);
  const spec = {
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
  const mapping = await proposeMapping(pool, { viewer: VIEWERS.marketing, uploadId: id, spec, now: BUSINESS_NOW });
  const dry = await runDryRun(pool, { viewer: VIEWERS.marketing, uploadId: id, mappingId: mapping.mappingId, now: BUSINESS_NOW });
  return { id, mappingId: mapping.mappingId, dryRunId: dry.id };
}

async function publish(file: string) {
  const { id, mappingId, dryRunId } = await stageAndDryRun(file);
  // The same file again reuses the mapping already approved for its layout.
  const status = (await one<{ status: string }>(pool, "select status from onboarding_mappings where id = $1", [mappingId])).status;
  if (status !== "approved") {
    await decideMapping(pool, { viewer: VIEWERS.approver, mappingId, decision: "approve", reason: "Matches the call export layout we receive", now: BUSINESS_NOW });
  }
  const result = await publishUpload(pool, { viewer: VIEWERS.approver, uploadId: id, dryRunId, now: BUSINESS_NOW });
  return { id, result };
}

describe("data times", () => {
  it("start from the snapshot clock and the newest polling run, with no counted import", async () => {
    const { times, asOf } = await snapshot();
    expect(times.snapshotAt?.toISOString()).toBe("2026-10-31T13:00:00.000Z");
    expect(times.lastSourceSync).toMatchObject({ kind: "polling_run", clock: "business" });
    expect(times.lastSourceSync?.at.toISOString()).toBe("2026-10-31T08:00:00.000Z");
    expect(times.lastCountedImport).toBeNull();
    expect(asOf?.toISOString()).toBe("2026-10-31T08:00:00.000Z");
  });

  it("do not move for queued, running, failed or cancelled sync jobs", async () => {
    const before = await snapshot();
    const connectorId = Number((await one<{ id: string }>(pool, "select id from connectors where slug = 'fieldroutes-demo'")).id);
    await enqueueSync(pool, { connectorId, officeIds: null, entities: ["customer"], idempotencyKey: "data-times-queued", actor: "engineer", scope: null, now: WALL, auditAt: WALL });
    expect(await snapshot()).toEqual(before);
    for (const state of ["running", "failed", "cancelled"] as const) {
      await pool.query("update sync_jobs set state = $1, finished_at = case when $1 = 'running' then null else $2::timestamptz end", [state, WALL]);
      expect(await snapshot(), state).toEqual(before);
    }
  });

  it("move the last source sync to a succeeded sync job, named with its office and clock, and leave Data as of alone", async () => {
    const before = await snapshot();
    const connectorId = Number((await one<{ id: string }>(pool, "select id from connectors where slug = 'fieldroutes-demo'")).id);
    await enqueueSync(pool, { connectorId, officeIds: null, entities: ["customer"], idempotencyKey: "data-times-done", actor: "engineer", scope: null, now: WALL, auditAt: WALL });
    const job = await one<{ id: string; office_id: number }>(pool, "select id, office_id from sync_jobs order by id limit 1");
    await pool.query("update sync_jobs set state = 'succeeded', finished_at = $2 where id = $1", [job.id, WALL]);
    const after = await snapshot();
    expect(after.times.lastSourceSync).toEqual({ at: WALL, kind: "sync_job", entity: "customer", officeId: job.office_id, clock: "wall" });
    expect(after.asOf).toEqual(before.asOf);
    expect(after.times.lastCountedImport).toBeNull();
  });

  it("do not move for a refused file, a compare-only dry run, or a publication that adds nothing", async () => {
    const before = await snapshot();
    const refused = await stageUpload(pool, { viewer: VIEWERS.marketing, filename: "calls.csv", bytes: Buffer.from([0, 159, 146, 150, 0, 1, 2, 3]), now: BUSINESS_NOW });
    expect("refused" in refused).toBe(true);
    await stageAndDryRun("demo-crm-payments.csv", { moneyMeaning: { amount: "collected_payment" } });
    expect(await snapshot()).toEqual(before);

    const first = await publish("demo-calls.csv");
    expect(first.result.stats.inserted).toBeGreaterThan(0);
    const counted = await snapshot();
    expect(counted.times.lastCountedImport?.uploadId).toBe(first.id);
    expect(counted.times.lastSourceSync).toEqual(before.times.lastSourceSync);
    expect(counted.asOf).toEqual(before.asOf);

    // The same rows again: every row is already in the ledger, so nothing is inserted.
    const again = await publish("demo-calls.csv");
    expect(again.result.stats.inserted).toBe(0);
    expect((await snapshot()).times.lastCountedImport?.uploadId).toBe(first.id);
  });
});
