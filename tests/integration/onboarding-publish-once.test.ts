import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { decideMapping, getUpload, proposeMapping, publishUpload, runDryRun, stageUpload } from "@/lib/onboarding/service";
import { VIEWERS } from "@/lib/viewer";
import { freshDb, one, testPool } from "../helpers";

/**
 * A staff import counts once (release design §5.3, "Count"). Publishing the same upload again is
 * refused; staging the same file again stages a new upload whose rows all dry-run to "matches
 * ledger", so its publication adds nothing; a different file holding the same rows plus one new
 * row adds that one row. The ledger's counts move once.
 */

const pool = testPool();
const NOW = new Date("2026-10-31T13:00:00Z");
const SAMPLE = readFileSync(path.join(process.cwd(), "public", "samples", "demo-calls.csv"));
const WITH_ONE_MORE = Buffer.from(`${SAMPLE.toString("utf8")}10/22/2026 9:00 AM,Alder,(206) 555-0199,(206) 555-0150,Google Ads,,10,Answered,DEMO10099,\n`);
const { marketing, approver } = VIEWERS;

beforeAll(async () => {
  await freshDb(pool);
});
afterAll(async () => {
  await pool.end();
});

const ledger = async () => ({
  rawEvents: (await one<{ n: number }>(pool, "select count(*)::int as n from raw_events")).n,
  leads: (await one<{ n: number }>(pool, "select count(*)::int as n from leads")).n,
});

/** Stage as the analyst, map with the review's answers, dry-run; approve the mapping unless it already is. */
async function stageAndDryRun(bytes: Buffer) {
  const staged = await stageUpload(pool, { viewer: marketing, filename: "demo-calls.csv", bytes, now: NOW });
  if (!("upload" in staged)) throw new Error(`refused: ${JSON.stringify(staged)}`);
  const id = staged.upload.id;
  const detail = await getUpload(pool, marketing, id, NOW);
  const spec = {
    dataset: detail.assistant.dataset.chosen,
    columns: Object.fromEntries(detail.assistant.fields.map((f) => [f.field, f.status === "suggested" ? f.column : null])),
    constants: {},
    valueMaps: Object.fromEntries(Object.entries(detail.values).map(([k, v]) => [k, Object.fromEntries(v.filter((x) => x.proposed).map((x) => [x.value, x.proposed]))])),
    dateOrder: "MDY",
    localTime: "branch_local",
    moneyMeaning: {},
    exportedAt: null,
  };
  const mapping = await proposeMapping(pool, { viewer: marketing, uploadId: id, spec, now: NOW });
  const status = (await one<{ status: string }>(pool, "select status from onboarding_mappings where id = $1", [mapping.mappingId])).status;
  if (status !== "approved") await decideMapping(pool, { viewer: approver, mappingId: mapping.mappingId, decision: "approve", reason: "Matches the call export layout we receive", now: NOW });
  const dry = await runDryRun(pool, { viewer: marketing, uploadId: id, mappingId: mapping.mappingId, now: NOW });
  return { id, dry };
}

describe("a staff import is applied once", () => {
  it("publishes, refuses a second publish, and adds nothing when the same rows come again", async () => {
    const start = await ledger();
    const first = await stageAndDryRun(SAMPLE);
    expect(first.dry.counts.eligible).toBeGreaterThan(0);
    const published = await publishUpload(pool, { viewer: approver, uploadId: first.id, dryRunId: first.dry.id, now: NOW });
    expect(published.published).toBe(first.dry.counts.eligible);
    const afterFirst = await ledger();
    expect(afterFirst.leads - start.leads).toBe(published.stats.inserted);
    expect(afterFirst.rawEvents - start.rawEvents).toBe(published.published);

    // The same upload again (a retried request, a second click): refused, nothing written.
    await expect(publishUpload(pool, { viewer: approver, uploadId: first.id, dryRunId: first.dry.id, now: NOW })).rejects.toMatchObject({ status: 409, message: "This upload is published" });
    expect(await ledger()).toEqual(afterFirst);

    // The same file staged again: a new upload, and every row it published before now matches the ledger.
    const again = await stageAndDryRun(SAMPLE);
    expect(again.id).not.toBe(first.id);
    expect(again.dry.counts.eligible).toBe(0);
    expect(again.dry.counts.matches_ledger).toBe(first.dry.counts.eligible);
    const none = await publishUpload(pool, { viewer: approver, uploadId: again.id, dryRunId: again.dry.id, now: NOW });
    expect(none.published).toBe(0);
    expect(await ledger()).toEqual(afterFirst);

    // A different file with the same rows and one more: only the new row counts.
    const more = await stageAndDryRun(WITH_ONE_MORE);
    expect(more.dry.counts.eligible).toBe(1);
    const one_ = await publishUpload(pool, { viewer: approver, uploadId: more.id, dryRunId: more.dry.id, now: NOW });
    expect(one_.published).toBe(1);
    const end = await ledger();
    expect(end.leads - afterFirst.leads).toBe(1);
    expect(end.rawEvents - afterFirst.rawEvents).toBe(1);
  });
});
