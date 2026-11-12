import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapCampaignToBranch } from "@/lib/actions";
import { createChange, type ChangeRow } from "@/lib/changeguard/service";
import { VIEWERS } from "@/lib/viewer";
import { call, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * Defects the blind held-out scenarios found at first contact (docs/agent-work/CHANGEGUARD-HELDOUT.md).
 * Each test reproduces the defect with its own fixture, and pins the behaviour next to it that
 * must not change. The held-out file itself is not tuned on: these are regression tests.
 */
const NOW = new Date("2026-10-31T13:00:00Z");
const { marketing, engineer } = VIEWERS;
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const at = (d: number, minute = 0) => new Date(Date.UTC(2026, 9, d, 16, minute));

let pool: Pool;
beforeEach(async () => {
  pool ??= testPool();
  await freshDb(pool);
});
afterAll(async () => pool?.end());

function spend(campaignId: string, name: string, d: number, dollars: number): RawRecord {
  return {
    entity: "spend_day",
    payload: { platform: "google_ads", accountId: "ACC-HR", campaignId, campaignName: name, date: day(d), costMicros: String(dollars * 1_000_000), clicks: 5, conversions: 1, fetchedAt: `${day(d + 1)}T06:00:00Z`, campaignType: "SEARCH" },
  };
}

/** One campaign with 5 days of spend, optionally mapped, with `leads` calls per branch carrying its id. */
async function campaignWithLeads(ext: string, leads: Record<string, number>, mappedTo: string | null = null): Promise<number> {
  await ingest(pool, "ads", [1, 2, 3, 4, 5].map((d) => spend(ext, `${ext} search`, d, 40)), { now: NOW });
  const id = Number((await one<{ id: string }>(pool, "select id from ad_campaigns where external_campaign_id = $1", [ext])).id);
  if (mappedTo) await mapCampaignToBranch(pool, { campaignId: id, branchId: mappedTo, actor: "setup", reason: "fixture mapping", now: at(1) });
  const calls: RawRecord[] = [];
  let n = 0;
  for (const [branch, count] of Object.entries(leads)) {
    for (let i = 0; i < count; i++, n++) calls.push(call(`${ext}-${n}`, branch, `+1480556${String(1000 + n)}`, at(2 + (n % 8), n), "Google Ads", { campaign: ext }));
  }
  await ingest(pool, "calls", calls, { now: NOW });
  await runReconcile(pool, NOW);
  return id;
}

const check = (c: ChangeRow, id: string) => c.preflight!.checks.find((x) => x.id === id)!;
const propose = (campaignId: number, branchId: string) =>
  createChange(pool, marketing, { kind: "campaign_mapping", payload: { campaignId, branchId }, reason: "Held-out regression fixture" }, NOW);

describe("HO-50 · fragmented evidence: the plurality branch is not a contradiction", () => {
  it("mapping to the branch with the most leads, short of a majority, needs a person (split), with true counts", async () => {
    const id = await campaignWithLeads("frag-1", { B27: 5, B28: 4, B29: 4 });
    const change = await propose(id, "B27");
    expect(change.preflight!.verdict).toBe("warn");
    expect(change.status).toBe("ready_for_review");
    expect(check(change, "mapping_coverage")).toMatchObject({ status: "warn", code: "LEAD_EVIDENCE_SPLIT" });
    expect(check(change, "mapping_coverage").detail).toContain("5 of 13");
  });

  it("a branch with fewer leads than another is still blocked, and the message names the other branch", async () => {
    const id = await campaignWithLeads("frag-2", { B27: 5, B28: 4, B29: 4 });
    const change = await propose(id, "B28");
    expect(change.status).toBe("preflight_failed");
    expect(check(change, "mapping_coverage")).toMatchObject({ status: "fail", code: "LEAD_EVIDENCE_DISAGREES" });
    expect(check(change, "mapping_coverage").detail).toContain("4 arrived at B28 and 5 at B27");
  });
});

describe("HO-48 · a cross-brand mapping can be corrected toward its own evidence", () => {
  it("remapping a Mission-mapped campaign whose leads all arrive at a Moxie branch to that branch is a flagged review, not a dead end", async () => {
    const id = await campaignWithLeads("xb-1", { B05: 13 }, "B28");
    const change = await propose(id, "B05");
    expect(change.status).toBe("ready_for_review");
    expect(change.preflight!.verdict).toBe("warn");
    expect(check(change, "mapping_coverage")).toMatchObject({ status: "pass" });
    expect(check(change, "mapping_collision")).toMatchObject({ status: "warn", code: "CROSS_BRAND_CORRECTION" });
    expect(check(change, "mapping_collision").detail).toContain('brand "mission"');
  });

  it("a cross-brand remap with no lead evidence is still blocked", async () => {
    const id = await campaignWithLeads("xb-2", {}, "B28");
    const change = await propose(id, "B05");
    expect(change.status).toBe("preflight_failed");
    expect(check(change, "mapping_collision")).toMatchObject({ status: "fail", code: "CROSS_BRAND" });
  });

  it("moving a campaign to a brand its leads do not belong to is still blocked", async () => {
    const id = await campaignWithLeads("xb-3", { B28: 9, B05: 2 }, "B28");
    const change = await propose(id, "B05");
    expect(change.status).toBe("preflight_failed");
    expect(check(change, "mapping_collision")).toMatchObject({ status: "fail", code: "CROSS_BRAND" });
  });
});

describe("HO-33 / HO-44 · only ChangeGuard can move a mapped campaign's spend", () => {
  it("the older Action Center mapping path refuses a campaign that is already mapped, and changes nothing", async () => {
    const id = await campaignWithLeads("old-path-1", { B24: 4 }, "B24");
    await expect(mapCampaignToBranch(pool, { campaignId: id, branchId: "B26", actor: "engineer", reason: "incident fix", now: NOW })).rejects.toMatchObject({ status: 409 });
    expect(await one(pool, "select branch_id from campaign_branch_map where campaign_id = $1", [id])).toEqual({ branch_id: "B24" });
  });
});

describe("HO-24 / HO-25 · a shape the deployed mapper accepts but misreads is not benign", () => {
  const baseCall = { branch_tag: "B03", start_time: "2026-10-20T15:15:00.000Z", tracking_phone_number: "+14805550120", source: "Google Ads", gclid: null, campaign: "21900402", agent_note: null, customer_phone_number: "+14805550171" };
  const sourceCheck = (source: "calls" | "ads", entity: string, samples: unknown[]) =>
    createChange(pool, engineer, { kind: "source_contract", payload: { source, entity, samples }, reason: "Held-out regression fixture" }, NOW);

  it("outbound, spam and not-a-lead calls are flagged with the staged mapper's codes", async () => {
    const change = await sourceCheck("calls", "call", [
      { ...baseCall, id: "HR-1", direction: "inbound", spam: false, lead_status: "good_lead" },
      { ...baseCall, id: "HR-2", direction: "outbound", spam: false, lead_status: null },
      { ...baseCall, id: "HR-3", direction: "inbound", spam: true, lead_status: null },
      { ...baseCall, id: "HR-4", direction: "inbound", spam: false, lead_status: "not_a_lead" },
    ]);
    expect(change.preflight!.verdict).toBe("warn");
    const schema = check(change, "schema_compatibility");
    expect(schema).toMatchObject({ status: "warn", code: "DEPLOYED_MAPPER_MISREADS" });
    expect(schema.detail).toContain("3 of 4");
    for (const code of ["NOT_INBOUND", "SPAM_CALL", "NOT_A_LEAD"]) expect(schema.detail).toContain(code);
  });

  it("spend in another currency is flagged", async () => {
    const day19 = { platform: "google_ads", accountId: "7734021198", campaignId: "22011870", campaignName: "Search | Termite", date: "2026-10-19", costMicros: "71500000", clicks: 31, conversions: 2, fetchedAt: "2026-10-20T06:00:00Z", campaignType: "SEARCH", localServicesEnabled: false };
    const change = await sourceCheck("ads", "spend_day", [{ ...day19, currencyCode: "CAD" }]);
    expect(check(change, "schema_compatibility")).toMatchObject({ status: "warn", code: "DEPLOYED_MAPPER_MISREADS" });
    expect(check(change, "schema_compatibility").detail).toContain("CURRENCY_UNSUPPORTED");
  });

  it("a benign added field still passes (no false alarm)", async () => {
    const change = await sourceCheck("calls", "call", [{ ...baseCall, id: "HR-5", call_score: 80 }]);
    expect(change.preflight!.verdict).toBe("pass");
    expect(check(change, "schema_compatibility")).toMatchObject({ status: "pass" });
  });
});
