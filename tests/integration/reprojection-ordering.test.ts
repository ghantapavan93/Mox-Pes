import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor } from "@/lib/adapters/registry";
import { replay } from "@/lib/ingest/replay";
import { call, freshDb, ingest, testPool } from "../helpers";

/**
 * Re-projection must reach the state intake reaches from the same deliveries (Reliability Twin,
 * 2026-11-12). A call is a receipt-ordered record: the LATEST OBSERVATION of a version decides
 * (VENDOR-CONTRACTS C-4a). A re-projection that orders versions by their FIRST receipt instead
 * lets an older observation win: the twin's rollout of calls@1.2 found it.
 *
 * And a rollout must be reversible: re-projecting back to the earlier mapper must restore the
 * leads the later one excluded, or a failed stage cannot be recovered.
 */
const pool: Pool = testPool();
afterAll(async () => pool.end());
beforeEach(async () => freshDb(pool), 60_000);

const T = (minute: number) => new Date(Date.UTC(2026, 9, 20, 15, minute));
const SCOPE = { from: new Date("2026-10-01T00:00:00Z"), to: new Date("2026-11-01T00:00:00Z"), branchIds: ["B12"] };
const base = call("CAL-ORD-1", "B12", "+14805551234", new Date("2026-10-19T15:00:00Z"));
const withFields = (extra: Record<string, unknown>): RawRecord => ({ entity: "call", payload: { ...(base.payload as Record<string, unknown>), ...extra } });
const spam = withFields({ spam: true });
const good = withFields({ lead_status: "good_lead" });

/** Lead state as the metrics read it: is the call counted, and which stored version it points at. */
async function leadState() {
  const { rows } = await pool.query<{ counted: boolean; excluded_code: string | null; payload_hash: string }>(
    `select l.excluded_code is null as counted, l.excluded_code, re.payload_hash
     from leads l join raw_events re on re.id = l.raw_event_id where l.source = 'calls' and l.source_lead_id = 'CAL-ORD-1'`,
  );
  return rows[0];
}

const ids = async () => (await pool.query<{ id: string }>("select id from raw_events where source = 'calls' order by id")).rows.map((r) => Number(r.id));

async function deliverSpamGoodSpam(version: string) {
  const mapper = mapperFor("calls", version);
  await ingest(pool, "calls", [spam], { mapper, now: T(0) });
  await ingest(pool, "calls", [good], { mapper, now: T(10) });
  // The spam version again, after the correction: a retried webhook or an overlap re-read.
  await ingest(pool, "calls", [spam], { mapper, now: T(20) });
}

describe("re-projection orders call versions by their latest observation", () => {
  it("spam, good, spam again: intake under calls@1.2 excludes the call, and so does re-projecting calls@1.1's records", async () => {
    await deliverSpamGoodSpam("1.2");
    const incremental = await leadState();
    expect(incremental.counted).toBe(false);

    await freshDb(pool);
    await deliverSpamGoodSpam("1.1");
    expect((await leadState()).counted).toBe(true); // calls@1.1 cannot read the spam flag
    await replay(pool, { source: "calls", rawEventIds: await ids(), mapperVersion: "1.2", fromVersion: "1.1", mode: "reproject", actor: "test", idempotencyKey: "ord-1", dryRun: false, now: T(30), scope: SCOPE });
    expect(await leadState()).toEqual(incremental);
  });

  it("good, spam, good again: both paths count the call", async () => {
    const mapper = mapperFor("calls", "1.1");
    await ingest(pool, "calls", [good], { mapper, now: T(0) });
    await ingest(pool, "calls", [spam], { mapper, now: T(10) });
    await ingest(pool, "calls", [good], { mapper, now: T(20) });
    await replay(pool, { source: "calls", rawEventIds: await ids(), mapperVersion: "1.2", fromVersion: "1.1", mode: "reproject", actor: "test", idempotencyKey: "ord-2", dryRun: false, now: T(30), scope: SCOPE });
    const state = await leadState();
    expect(state.counted).toBe(true);
    expect(state.payload_hash).toBe((await pool.query<{ payload_hash: string }>("select payload_hash from raw_events where payload ->> 'lead_status' = 'good_lead'")).rows[0].payload_hash);
  });
});

describe("re-projection back to the earlier mapper", () => {
  it("restores every lead calls@1.2 excluded, exactly as calls@1.1 had it", async () => {
    const mapper = mapperFor("calls", "1.1");
    const records = [
      call("CAL-RB-1", "B12", "+14805550001", T(1)),
      call("CAL-RB-2", "B12", "+14805550002", T(2), "Facebook", { direction: "outbound" }),
      call("CAL-RB-3", "B12", "+14805550003", T(3), "Bing", { lead_status: "not_a_lead" }),
    ];
    await ingest(pool, "calls", records, { mapper, now: T(5) });
    await ingest(pool, "calls", [{ entity: "call", payload: { ...(records[0].payload as Record<string, unknown>), spam: true } }], { mapper, now: T(6) });
    const snapshot = () => pool.query("select source_lead_id, channel_code, raw_event_id, source_updated_at from v_leads order by source_lead_id").then((r) => r.rows);
    const before = await snapshot();
    expect(before).toHaveLength(3);

    const forward = await replay(pool, { source: "calls", rawEventIds: await ids(), mapperVersion: "1.2", fromVersion: "1.1", mode: "reproject", actor: "test", idempotencyKey: "rb-fwd", dryRun: false, now: T(10), scope: SCOPE });
    expect(forward.claimed).toBe(4);
    expect(await snapshot()).toHaveLength(0);

    const back = await replay(pool, { source: "calls", rawEventIds: await ids(), mapperVersion: "1.1", fromVersion: "1.2", mode: "reproject", actor: "test", idempotencyKey: "rb-back", dryRun: false, now: T(20), scope: SCOPE });
    expect(back.claimed).toBe(4);
    expect(await snapshot()).toEqual(before);
    // History is kept, not rewritten: every stored version, each now stamped with the mapper that read it last.
    const raw = await pool.query<{ status: string; adapter_version: string }>("select status, adapter_version from raw_events order by id");
    expect(raw.rows).toEqual(Array.from({ length: 4 }, () => ({ status: "projected", adapter_version: "calls@1.1" })));
  });
});
