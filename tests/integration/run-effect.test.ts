import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { runStream } from "@/lib/ingest/ingest";
import { EFFECT_NOT_RECORDED, runOutcome } from "@/lib/ingest/run-outcome";
import { InMemorySourceClient } from "@/lib/sim/clients";
import { freshDb, one, testPool } from "../helpers";

/**
 * What a delivery run changed in the accepted records (migration 0030, DELIVERY-OUTCOMES.md):
 * recorded in the run's own transaction, 0 included; a removal counts; and history recorded before
 * the column is filled from the intake event written with each run, or left unrecorded where there
 * is none. The B09 deliveries themselves are in b09-recovery.test.ts.
 */

const NOW = new Date("2026-10-31T13:00:00Z");
const MIGRATION = readFileSync(path.join(process.cwd(), "database", "migrations", "0030_run_effect.sql"), "utf8");
const at = (minutes: number) => new Date(NOW.getTime() + minutes * 60_000);

/** One spend day as the platform sends it; `currencyCode` USD unless the extra fields say otherwise. */
function spend(day: number, dollars: number, fetchedAt: string, extra: Record<string, unknown> = {}): RawRecord {
  return {
    entity: "spend_day",
    payload: { platform: "google_ads", accountId: "ACC-RE", campaignId: "re-1", campaignName: "re-1 search", campaignType: "SEARCH", date: `2026-10-${String(day).padStart(2, "0")}`, costMicros: String(dollars * 1_000_000), clicks: 3, conversions: 1, fetchedAt, currencyCode: "USD", ...extra },
  };
}

/** One polling run of the ads feed at `when`, the path the worker uses. */
async function deliver(pool: Pool, records: RawRecord[], when: Date, fail?: string) {
  const versions = records.map((r) => ({ stream: "ads", entity: r.entity, visibleAt: when.getTime() - 60_000, payload: r.payload as Record<string, unknown> }));
  const client = new InMemorySourceClient("ads", "ads", versions, () => fail ?? null);
  return runStream(pool, { client, mapper: mapperFor("ads"), ctx: referenceContext, now: when, windowEnd: when, overlapMs: 0, initialCursor: new Date(when.getTime() - 24 * 3_600_000) });
}

type RunRow = { id: string; status: string; fetched: number; inserted: number; duplicates: number; projected: number; rows_changed: number | null };
const runs = async (pool: Pool) => (await pool.query<RunRow>("select id, status, fetched, inserted, duplicates, projected, rows_changed from ingestion_runs order by id")).rows;
const intakeEvent = async (pool: Pool, runId: number) =>
  (await pool.query<{ payload: Record<string, unknown> }>("select payload from domain_events where type = 'intake.records_stored' and (payload ->> 'runId')::bigint = $1", [runId])).rows.map((r) => r.payload);
const outcome = (r: RunRow) => runOutcome({ fetched: r.fetched, inserted: r.inserted, duplicates: r.duplicates, projected: r.projected, rowsChanged: r.rows_changed });

let pool: Pool;
beforeAll(() => {
  pool = testPool();
});
afterAll(async () => pool.end());

describe("every delivery run records what it changed, with the change", () => {
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    await freshDb(pool);
    ids.first = (await deliver(pool, [spend(1, 10, "2026-10-02T06:00:00Z"), spend(2, 20, "2026-10-03T06:00:00Z")], at(0))).runId;
    ids.duplicate = (await deliver(pool, [spend(1, 10, "2026-10-02T06:00:00Z"), spend(2, 20, "2026-10-03T06:00:00Z")], at(5))).runId;
    ids.older = (await deliver(pool, [spend(1, 15, "2026-10-01T06:00:00Z")], at(10))).runId;
    ids.newer = (await deliver(pool, [spend(1, 12, "2026-10-04T06:00:00Z")], at(15))).runId;
    ids.failed = (await deliver(pool, [spend(3, 30, "2026-10-04T06:00:00Z")], at(20), "source unavailable")).runId;
  }, 60_000);

  it("a count of 0 is recorded, not left out; a run that never committed stays unrecorded", async () => {
    const byId = new Map((await runs(pool)).map((r) => [Number(r.id), r]));
    expect([ids.first, ids.duplicate, ids.older, ids.newer, ids.failed].map((id) => [byId.get(id)!.status, byId.get(id)!.inserted, byId.get(id)!.rows_changed])).toEqual([
      ["succeeded", 2, 2],
      ["succeeded", 0, 0],
      ["succeeded", 1, 0],
      ["succeeded", 1, 1],
      ["failed", 0, null],
    ]);
    // The older revision was stored (the pipeline's former "New 1") and changed nothing.
    expect(Number((await one<{ c: string }>(pool, "select cost_cents as c from ad_spend_daily where spend_date = '2026-10-01'")).c)).toBe(1_200);
    expect(outcome(byId.get(ids.older)!)).toMatchObject({ effect: "No change to accepted records", reason: "Stored, but a newer revision was already accepted" });
    expect(outcome(byId.get(ids.duplicate)!)).toMatchObject({ effect: "No change to accepted records", reason: "Duplicate: every delivery was a version already stored" });
    expect(outcome(byId.get(ids.failed)!).effect).toBe(EFFECT_NOT_RECORDED);
  });

  it("agrees with the intake event written in the same transaction; a quiet run has no event", async () => {
    for (const key of ["first", "older", "newer"]) {
      const [event] = await intakeEvent(pool, ids[key]);
      expect(event.rowsChanged).toBe((await runs(pool)).find((r) => Number(r.id) === ids[key])!.rows_changed);
    }
    // Nothing stored, nothing changed: no event, so before 0030 nothing recorded this run's effect.
    expect(await intakeEvent(pool, ids.duplicate)).toEqual([]);
  });

  it("history before the column: filled from each run's intake event; a run without one stays 'Effect not recorded'", async () => {
    const recorded = await runs(pool);
    await pool.query("update ingestion_runs set rows_changed = null"); // as if recorded before migration 0030
    await pool.query(MIGRATION);
    const filled = new Map((await runs(pool)).map((r) => [Number(r.id), r]));
    expect([ids.first, ids.duplicate, ids.older, ids.newer, ids.failed].map((id) => filled.get(id)!.rows_changed)).toEqual([2, null, 0, 1, null]);
    expect(outcome(filled.get(ids.duplicate)!)).toEqual({ recorded: false, effect: EFFECT_NOT_RECORDED, reason: null, verifications: [] });
    // Applied again, it changes nothing, and it never overwrites a recorded count.
    await pool.query("update ingestion_runs set rows_changed = 0 where id = $1", [ids.duplicate]);
    await pool.query(MIGRATION);
    expect((await runs(pool)).map((r) => r.rows_changed)).toEqual(recorded.map((r) => r.rows_changed));
  });
});

describe("a removal of accepted spend is a change", () => {
  const ids: Record<string, number> = {};

  beforeAll(async () => {
    await freshDb(pool, { currencyRule: false });
    ids.stated = (await deliver(pool, [spend(5, 90, "2026-10-06T06:00:00Z")], at(0))).runId;
    // A newer version of the same day without a currency, and no rule: held, and the stated day it
    // supersedes leaves the metrics (lib/ingest/project.ts, the currency gate).
    ids.unstated = (await deliver(pool, [spend(5, 50, "2026-10-07T06:00:00Z", { currencyCode: undefined })], at(5))).runId;
  }, 60_000);

  it("the held version removed the accepted day: 1 change, not 'no change'", async () => {
    expect(await one(pool, "select count(*)::int as n from ad_spend_daily")).toEqual({ n: 0 });
    const r = (await runs(pool)).find((x) => Number(x.id) === ids.unstated)!;
    expect([r.inserted, r.projected, r.rows_changed]).toEqual([1, 0, 1]);
    expect(outcome(r).effect).toBe("1 change to accepted records");
  });

  it("such a run's count from before the column is not trusted: its event may have left the removal out", async () => {
    expect((await intakeEvent(pool, ids.unstated))[0]).toMatchObject({ excluded: 1 });
    await pool.query("update ingestion_runs set rows_changed = null");
    await pool.query(MIGRATION);
    const filled = new Map((await runs(pool)).map((x) => [Number(x.id), x.rows_changed]));
    expect([filled.get(ids.stated), filled.get(ids.unstated)]).toEqual([1, null]);
  });
});
