import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NewChangeSchema } from "@/lib/changeguard/model";
import { createChange } from "@/lib/changeguard/service";
import { createPool } from "@/lib/db";
import { DiskPreflightError, diskPreflight, type OwnedTwin } from "@/lib/twin/disk";
import { runEvaluation } from "@/lib/twin/runner";
import { createEvaluation, getEvaluation, type EvaluationRow } from "@/lib/twin/store";
import { databaseUrl, worldExists } from "@/lib/twin/world";
import { VIEWERS } from "@/lib/viewer";
import { TEST_DATABASE_URL, freshDb, testPool } from "../helpers";

/**
 * R-49: a twin costs disk, and a full disk breaks every database on the server. Before a clone,
 * the runner measures, makes room among the finished twins ITS control database owns, and
 * refuses with the numbers if that is not enough. Nothing it does not own is touched.
 */

const twins = (...names: string[]): OwnedTwin[] => names.map((database, i) => ({ evaluationId: i + 1, database }));

// This file tests the preflight itself, so the opt-out CI sets because its service container's
// disk cannot be measured (TWIN_SKIP_DISK_PREFLIGHT, .github/workflows/ci.yml) is cleared while it
// runs. Every measurement here is injected; none reads a real disk.
const skipPreflight = process.env.TWIN_SKIP_DISK_PREFLIGHT;
beforeAll(() => {
  delete process.env.TWIN_SKIP_DISK_PREFLIGHT;
});
afterAll(() => {
  if (skipPreflight !== undefined) process.env.TWIN_SKIP_DISK_PREFLIGHT = skipPreflight;
});

describe("diskPreflight", () => {
  it("drops the caller's own finished twins, oldest first, only until there is room", async () => {
    let free = 100;
    const dropped: string[] = [];
    const check = await diskPreflight({ needBytes: 250, measure: async () => free, ownFinished: twins("a", "b", "c"), drop: async (t) => void (dropped.push(t.database), (free += 100)) });
    expect(dropped).toEqual(["a", "b"]);
    expect(check).toMatchObject({ freeBytes: 300, needBytes: 250 });
  });

  it("drops nothing when there is room", async () => {
    const check = await diskPreflight({ needBytes: 250, measure: async () => 1_000, ownFinished: twins("a"), drop: async () => { throw new Error("must not drop"); } });
    expect(check.dropped).toEqual([]);
  });

  it("refuses with the numbers when its own twins cannot make room", async () => {
    const refused = diskPreflight({ needBytes: 2 * 1024 ** 3, measure: async () => 714 * 1024 ** 2, ownFinished: [], drop: async () => undefined });
    await expect(refused).rejects.toBeInstanceOf(DiskPreflightError);
    await expect(refused).rejects.toThrow(/714 MB free on the database server's volume, 2\.0 GB needed/);
  });
});

describe("the runner refuses before cloning and cleans up only what its control database owns", () => {
  const pool: Pool = testPool();
  const admin = createPool(databaseUrl(TEST_DATABASE_URL, "postgres"));
  const foreign = "rso_twin_another_control_db_1";
  beforeAll(async () => {
    await freshDb(pool);
    await admin.query(`drop database if exists ${foreign} with (force)`);
    await admin.query(`create database ${foreign}`);
  }, 60_000);
  afterAll(async () => {
    await admin.query(`drop database if exists ${foreign} with (force)`);
    await admin.end();
    await pool.end();
  });

  it("50 MB free: its two finished twins are dropped, then it refuses; another control database's twin stays", async () => {
    const change = await createChange(pool, VIEWERS.marketing, NewChangeSchema.parse({
      kind: "source_contract", reason: "Roll out calls@1.2 (disk preflight test)",
      payload: { source: "calls", entity: "call", samples: [{ id: "S-1", branch_tag: "B12", start_time: "2026-10-20T15:00:00Z", tracking_phone_number: "+18885550100", source: "Google Ads", gclid: null, campaign: null, agent_note: null, customer_phone_number: "+14805551000" }] },
    }));
    const start = () => createEvaluation(pool, VIEWERS.engineer, { changeId: change.id, variant: "standard", controlDatabase: "revenue_signal_test", now: new Date() });
    const finished: EvaluationRow[] = [];
    for (let i = 0; i < 2; i++) {
      const id = await start();
      await pool.query("update rollout_evaluations set status = 'PASSED', finished_at = now() where id = $1", [id]);
      const ev = (await getEvaluation(pool, id))!;
      await admin.query(`drop database if exists ${ev.twinDatabase} with (force)`);
      await admin.query(`create database ${ev.twinDatabase}`);
      finished.push(ev);
    }
    const id = await start();
    const ev = await runEvaluation(pool, id, { mainUrl: TEST_DATABASE_URL, runnerId: "disk-test", diskFreeBytes: async () => 50 * 1024 ** 2 });

    expect(ev.status).toBe("ERROR");
    expect(ev.error).toMatch(/Not enough free disk for a twin: 50 MB free/);
    expect(ev.error).toMatch(/2 finished twin\(s\) of this control database were dropped first; nothing else was touched and nothing was cloned/);
    // Nothing was cloned and no stage started.
    expect(await worldExists(TEST_DATABASE_URL, ev.twinDatabase)).toBe(false);
    expect(ev.summary.world).toBeUndefined();
    expect(ev.stages.map((s) => s.startedAt)).toEqual([null, null, null]);
    // Its own finished twins went, and say why; another control database's twin did not.
    for (const f of finished) {
      expect(await worldExists(TEST_DATABASE_URL, f.twinDatabase)).toBe(false);
      expect((await getEvaluation(pool, f.id))!.summary).toMatchObject({ twinDroppedWhy: expect.stringContaining("disk preflight") });
    }
    expect(await worldExists(TEST_DATABASE_URL, foreign)).toBe(true);
  }, 120_000);
});
