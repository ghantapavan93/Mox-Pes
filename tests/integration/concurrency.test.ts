import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool, PoolClient } from "pg";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { withTransaction } from "@/lib/db";
import { ingestRecords } from "@/lib/ingest/ingest";
import { compileRows, type MappingSpec } from "@/lib/onboarding/compile";
import { isRefusal, parseUpload } from "@/lib/onboarding/parse";
import { decideMapping, getUpload, proposeMapping, publishUpload, purgeExpired, runDryRun, stageUpload, type PublishHooks } from "@/lib/onboarding/service";
import { VIEWERS } from "@/lib/viewer";
import { call, freshDb, one, testPool } from "../helpers";

/**
 * Deterministic concurrency tests (Stage 2). No test here races two promises and hopes: each
 * interleaving is staged with gates (a hook inside the publication transaction, or a
 * transaction held open by hand), and before the competing side is released the test proves it
 * is BLOCKED by reading Postgres's own wait state (pg_stat_activity). The order of events is
 * therefore the one the test names, every run.
 *
 * The design under test: live lead intake takes the lead-write advisory lock SHARED as its
 * first statement; a file publication takes it EXCLUSIVE before comparing with the ledger, and
 * locks its upload row and its approved mapping row.
 */
const pool: Pool = testPool();
beforeEach(async () => freshDb(pool));
afterAll(async () => pool.end());

const NOW = new Date("2026-11-10T15:00:00Z");
const { marketing, approver, engineer } = VIEWERS;
const FILE = "callrail-style-export.csv";
const bytes = () => readFileSync(path.join(__dirname, "..", "fixtures", "onboarding", "holdout", FILE));

function gate() {
  let open!: () => void;
  const opened = new Promise<void>((resolve) => (open = resolve));
  return { open, opened };
}

/** Waits until some backend of this database waits on a lock of one of `events`. */
async function blocked(events: string[]): Promise<void> {
  for (let i = 0; i < 250; i++) {
    const r = await pool.query<{ e: string }>("select wait_event as e from pg_stat_activity where datname = current_database() and wait_event_type = 'Lock'");
    if (r.rows.some((x) => events.includes(x.e))) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`no backend blocked on ${events.join(" / ")}`);
}

/** A promise that has not settled after a short wait (it is blocked, not finished). */
async function stillPending(p: Promise<unknown>): Promise<boolean> {
  return Promise.race([p.then(() => false, () => false), new Promise<boolean>((resolve) => setTimeout(() => resolve(true), 150))]);
}

const SPEC_ANSWERS = { dateOrder: "MDY" as const, localTime: "branch_local" as const };

async function specFor(uploadId: number, extra: Partial<MappingSpec> = {}): Promise<MappingSpec> {
  const d = await getUpload(pool, marketing, uploadId, NOW);
  return {
    dataset: "calls",
    columns: Object.fromEntries(d.assistant.fields.map((f) => [f.field, f.status === "suggested" ? f.column : null])),
    constants: {},
    valueMaps: Object.fromEntries(Object.entries(d.values).map(([k, v]) => [k, Object.fromEntries(v.filter((x) => x.proposed).map((x) => [x.value, x.proposed!]))])),
    moneyMeaning: {},
    exportedAt: null,
    ...SPEC_ANSWERS,
    ...extra,
  };
}

/** Staged, mapped, dry-run and approved: ready to publish. */
async function approvedUpload(): Promise<{ uploadId: number; dryRunId: number; mappingId: number; spec: MappingSpec }> {
  const r = await stageUpload(pool, { viewer: marketing, filename: FILE, bytes: bytes(), now: NOW });
  if ("refused" in r) throw new Error(r.refused.message);
  const uploadId = r.upload.id;
  const spec = await specFor(uploadId);
  const m = await proposeMapping(pool, { viewer: marketing, uploadId, spec, now: NOW });
  const dry = await runDryRun(pool, { viewer: marketing, uploadId, mappingId: m.mappingId, now: NOW });
  await decideMapping(pool, { viewer: approver, mappingId: m.mappingId, decision: "approve", reason: "Checked against the export", now: NOW });
  return { uploadId, dryRunId: dry.id, mappingId: m.mappingId, spec };
}

/** Exactly the record publication will write for one call id (same payload, same version key). */
function compiledRecord(spec: MappingSpec, callId: string): RawRecord {
  const table = parseUpload({ filename: FILE, bytes: bytes() });
  if (isRefusal(table)) throw new Error(table.message);
  const out = compileRows(table, spec, NOW).find((o) => o.disposition === "eligible" && o.entityId === callId);
  if (!out || out.disposition !== "eligible") throw new Error(`no eligible ${callId}`);
  return out.record;
}

const liveIngest = (records: RawRecord[], db: Pool | PoolClient = pool) =>
  "release" in db
    ? ingestRecords(db, { source: "calls", records, mapper: mapperFor("calls"), ctx: referenceContext, runId: null, now: new Date(NOW.getTime() + 60_000) })
    : withTransaction(db, (tx) => ingestRecords(tx, { source: "calls", records, mapper: mapperFor("calls"), ctx: referenceContext, runId: null, now: new Date(NOW.getTime() + 60_000) }));

/** Runs a publication that pauses at `point` until released. */
function pausedPublish(a: { uploadId: number; dryRunId: number }, point: keyof PublishHooks) {
  const reached = gate();
  const release = gate();
  const hooks: PublishHooks = {
    [point]: async () => {
      reached.open();
      await release.opened;
    },
  };
  const result = publishUpload(pool, { viewer: approver, uploadId: a.uploadId, dryRunId: a.dryRunId, now: NOW, hooks });
  return { result, reached: reached.opened, release: release.open };
}

const leadsOf = (id: string) => one<{ n: number }>(pool, "select count(*)::int as n from leads where source_lead_id = $1", [id]);

describe("A · file publication collides with a live webhook", () => {
  it("a webhook arriving mid-publication waits for it, then lands as the newer version; nothing is lost or doubled", async () => {
    const a = await approvedUpload();
    const p = pausedPublish(a, "afterCompare"); // compared with the ledger, not yet written
    await p.reached;
    const live = liveIngest([call("CAL10001", "B01", "+12065550101", new Date("2026-11-03T17:14:00Z"), "Google Ads", { agent_note: "live webhook" })]);
    await blocked(["advisory"]);
    expect(await stillPending(live)).toBe(true);
    expect(await leadsOf("CAL10001")).toEqual({ n: 0 }); // the webhook has written nothing yet
    p.release();
    expect(await p.result).toMatchObject({ published: 6 });
    const stats = await live;
    expect(stats).toMatchObject({ inserted: 1, projected: 1 });
    // One lead, two stored versions (file and webhook): the later delivery is the live one.
    expect(await leadsOf("CAL10001")).toEqual({ n: 1 });
    const lead = await one<{ heard_about_text: string }>(pool, "select heard_about_text from leads where source_lead_id = 'CAL10001'");
    expect(lead.heard_about_text).toBe("live webhook");
    expect(await one(pool, "select count(*)::int as n from raw_events where entity_id = 'CAL10001'")).toEqual({ n: 2 });
  });

  it("a webhook already in flight makes the publication wait; the publication then skips that call instead of overwriting it", async () => {
    const a = await approvedUpload();
    const client = await pool.connect();
    try {
      await client.query("begin");
      await liveIngest([call("CAL10001", "B01", "+12065550101", new Date("2026-11-03T17:14:00Z"), "Google Ads", { agent_note: "live webhook" })], client);
      const pub = publishUpload(pool, { viewer: approver, uploadId: a.uploadId, dryRunId: a.dryRunId, now: NOW });
      await blocked(["advisory"]);
      expect(await stillPending(pub)).toBe(true);
      await client.query("commit");
      expect(await pub).toMatchObject({ published: 5, skipped: { changedSinceDryRun: 1 } });
    } finally {
      client.release();
    }
    const lead = await one<{ heard_about_text: string }>(pool, "select heard_about_text from leads where source_lead_id = 'CAL10001'");
    expect(lead.heard_about_text).toBe("live webhook");
  });

  it("an identical payload from both sides cannot deadlock (the table lock it replaced did)", async () => {
    const a = await approvedUpload();
    const same = compiledRecord(a.spec, "CAL10001");
    const p = pausedPublish(a, "afterCompare");
    await p.reached;
    const live = liveIngest([same]);
    await blocked(["advisory"]); // waits BEFORE touching raw_events, so no lock cycle can form
    p.release();
    expect(await p.result).toMatchObject({ published: 6 });
    // The webhook then finds the very same version already stored: a duplicate delivery.
    expect(await live).toMatchObject({ inserted: 0, duplicates: 1 });
    expect(await one(pool, "select count(*)::int as n, max(delivery_count)::int as d from raw_events where entity_id = 'CAL10001'")).toEqual({ n: 1, d: 2 });
  });
});

describe("B / H · approval completed, then the rules change", () => {
  it("a newer, unapproved mapping version cannot publish, and the reviewed dry run is no longer the latest", async () => {
    const a = await approvedUpload();
    const v2 = await proposeMapping(pool, { viewer: marketing, uploadId: a.uploadId, spec: { ...a.spec, columns: { ...a.spec.columns, campaign: null } }, now: NOW });
    const d2 = await runDryRun(pool, { viewer: marketing, uploadId: a.uploadId, mappingId: v2.mappingId, now: NOW });
    await expect(publishUpload(pool, { viewer: approver, uploadId: a.uploadId, dryRunId: d2.id, now: NOW })).rejects.toThrow(/not approved/);
    await expect(publishUpload(pool, { viewer: approver, uploadId: a.uploadId, dryRunId: a.dryRunId, now: NOW })).rejects.toThrow(/newer dry run/);
    expect(await one(pool, "select count(*)::int as n from leads")).toEqual({ n: 0 });
  });

  it("an approval that would supersede the mapping waits for an in-flight publication, which completes under the mapping it started with", async () => {
    const a = await approvedUpload();
    const v2 = await proposeMapping(pool, { viewer: engineer, uploadId: a.uploadId, spec: { ...a.spec, columns: { ...a.spec.columns, campaign: null } }, now: NOW });
    const p = pausedPublish(a, "afterLock");
    await p.reached;
    const decision = decideMapping(pool, { viewer: approver, mappingId: v2.mappingId, decision: "approve", reason: "Campaign column dropped", now: NOW });
    await blocked(["tuple", "transactionid"]);
    expect(await stillPending(decision)).toBe(true);
    p.release();
    await p.result;
    await decision;
    const pub = await one<{ mapping_id: string }>(pool, "select mapping_id from onboarding_publications where upload_id = $1", [a.uploadId]);
    expect(Number(pub.mapping_id)).toBe(a.mappingId); // provenance: published under v1
    expect(await one(pool, "select status from onboarding_mappings where id = $1", [a.mappingId])).toEqual({ status: "superseded" });
  });
});

describe("C / D · crash and retry", () => {
  it("a crash after the write rolls everything back; the retry publishes exactly once", async () => {
    const a = await approvedUpload();
    await expect(
      publishUpload(pool, { viewer: approver, uploadId: a.uploadId, dryRunId: a.dryRunId, now: NOW, hooks: { afterWrite: async () => { throw new Error("process killed after the write"); } } }),
    ).rejects.toThrow(/killed/);
    expect(await one(pool, "select count(*)::int as n from raw_events")).toEqual({ n: 0 });
    expect(await one(pool, "select status from onboarding_uploads where id = $1", [a.uploadId])).toEqual({ status: "staged" });
    expect(await one(pool, "select count(*)::int as n from audit_log where action = 'onboarding_published'")).toEqual({ n: 0 });
    expect(await publishUpload(pool, { viewer: approver, uploadId: a.uploadId, dryRunId: a.dryRunId, now: NOW })).toMatchObject({ published: 6 });
    expect(await one(pool, "select count(*)::int as n from leads")).toEqual({ n: 6 });
  });

  it("the same approved publication submitted twice at once runs once; the second waits, then is refused", async () => {
    const a = await approvedUpload();
    const p = pausedPublish(a, "afterLock");
    await p.reached;
    const second = publishUpload(pool, { viewer: approver, uploadId: a.uploadId, dryRunId: a.dryRunId, now: NOW });
    await blocked(["tuple", "transactionid"]);
    expect(await stillPending(second)).toBe(true);
    p.release();
    expect(await p.result).toMatchObject({ published: 6 });
    await expect(second).rejects.toThrow(/published/);
    expect(await one(pool, "select count(*)::int as n from onboarding_publications")).toEqual({ n: 1 });
    expect(await one(pool, "select count(*)::int as n from leads")).toEqual({ n: 6 });
  });
});

describe("E · two deliveries of the same source record", () => {
  it("the second waits on the first and is counted as a duplicate delivery, not a second lead", async () => {
    const record = call("CAL-E1", "B01", "+12125550161", new Date("2026-10-01T15:00:00Z"));
    const client = await pool.connect();
    try {
      await client.query("begin");
      await liveIngest([record], client);
      const second = liveIngest([record]);
      await blocked(["transactionid"]); // the unique (source, external_id) index makes it wait
      expect(await stillPending(second)).toBe(true);
      await client.query("commit");
      expect(await second).toMatchObject({ inserted: 0, duplicates: 1 });
    } finally {
      client.release();
    }
    expect(await leadsOf("CAL-E1")).toEqual({ n: 1 });
    expect(await one(pool, "select delivery_count::int as d from raw_events where entity_id = 'CAL-E1'")).toEqual({ d: 2 });
  });
});

describe("G · retention purge overlaps a publication", () => {
  it("the purge waits for the publication, which keeps its published rows and lineage", async () => {
    const a = await approvedUpload();
    const p = pausedPublish(a, "afterLock");
    await p.reached;
    const purge = purgeExpired(pool, new Date(NOW.getTime() + 25 * 3_600_000));
    await blocked(["tuple", "transactionid"]);
    expect(await stillPending(purge)).toBe(true);
    p.release();
    expect(await p.result).toMatchObject({ published: 6 });
    await purge;
    expect(await one(pool, "select status from onboarding_uploads where id = $1", [a.uploadId])).toEqual({ status: "published" });
    expect(await one(pool, "select count(*)::int as n from onboarding_row_results where disposition = 'published' and raw_event_id is not null")).toEqual({ n: 6 });
    expect(await one(pool, "select count(*)::int as n from leads")).toEqual({ n: 6 });
  });
});
