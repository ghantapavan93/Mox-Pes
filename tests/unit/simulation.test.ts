import { describe, expect, it } from "vitest";
import { payloadHash } from "@/lib/primitives";
import { BRANCHES, SCENARIO } from "@/lib/reference";
import { PARAMS, generateWorld } from "@/lib/sim/world";
import { attentionFlags } from "@/lib/attention";
import type { BranchRow } from "@/lib/metrics/scorecard";

const world = generateWorld();

describe("the synthetic world", () => {
  it("is deterministic: same seed, same records", () => {
    const again = generateWorld();
    expect(again.records.length).toBe(world.records.length);
    expect(payloadHash(again.records.slice(0, 2000))).toBe(payloadHash(world.records.slice(0, 2000)));
  });

  it("has 44 fictional branches and no real-company identifiers", () => {
    expect(BRANCHES).toHaveLength(44);
    const text = JSON.stringify(world.records.slice(0, 5000));
    expect(text).not.toMatch(/moxie/i);
    // Fictional NANP range (555-0100…0199) and example.com only.
    for (const r of world.records.slice(0, 3000)) {
      const s = JSON.stringify(r.payload);
      for (const m of s.match(/\d{3}5550(\d{3})/g) ?? []) expect(Number(m.slice(-3))).toBeGreaterThanOrEqual(100);
      for (const e of s.match(/[\w.]+@[\w.]+/g) ?? []) expect(e.endsWith("@example.com")).toBe(true);
    }
  });

  it("contains the seeded incident: B20 calls change shape from the drift date", () => {
    const calls = world.records.filter((r) => r.stream === "calls" && r.payload.branch_tag === SCENARIO.callFeedDriftBranch);
    const drifted = calls.filter((r) => "caller" in r.payload);
    expect(drifted.length).toBe(world.truth.driftedCalls);
    expect(drifted.length).toBeGreaterThan(50);
    for (const r of drifted) expect(Date.parse(String(r.payload.start_time))).toBeGreaterThanOrEqual(Date.parse(SCENARIO.callFeedDriftFrom));
    const otherDrift = world.records.filter((r) => r.stream === "calls" && r.payload.branch_tag !== SCENARIO.callFeedDriftBranch && "caller" in r.payload);
    expect(otherDrift).toHaveLength(0);
  });

  it("cost per lead lands inside the researched benchmark ranges (research/07 §2.3)", () => {
    const spend = new Map<string, number>();
    for (const r of world.records.filter((x) => x.stream === "ads")) {
      // last fetched version per campaign-day wins
      spend.set(`${r.payload.campaignId}:${r.payload.date}`, Number(r.payload.costMicros) / 1e6);
    }
    const byChannel = { gs: 0, lsa: 0 };
    for (const [k, v] of spend) {
      if (k.startsWith("gs-")) byChannel.gs += v;
      if (k.startsWith("lsa-")) byChannel.lsa += v;
    }
    const leads = { gs: 0, lsa: 0 };
    for (const r of world.records) {
      if (r.stream === "web" && (r.payload.properties as Record<string, unknown>).utm_source === "google") leads.gs++;
      if (r.stream === "calls" && r.payload.source === "Google Ads") leads.gs++;
      if (r.stream === "calls" && r.payload.source === "Google LSA") leads.lsa++;
    }
    const cplSearch = byChannel.gs / leads.gs;
    const cplLsa = byChannel.lsa / leads.lsa;
    expect(cplSearch).toBeGreaterThan(90);
    expect(cplSearch).toBeLessThan(160);
    expect(cplLsa).toBeGreaterThan(40);
    expect(cplLsa).toBeLessThan(100);
    expect(PARAMS.refundRate).toBeGreaterThanOrEqual(0.01);
  });
});

describe("attention flags are relative and explainable", () => {
  const row = (id: string, spend: number, paid: number, acquired: number, unknown: number): BranchRow => ({
    branchId: id, name: id, region: "Central", paidSpendCents: spend, platformClaimed: 0, rawLeads: 0, prospects: 0, paidProspects: 0, sold: 0,
    acquired, paidAcquired: paid, unknownAcquired: unknown, channelConflicts: 0, newCustomerCollectedCents: 0, newCustomerAcvCents: 0,
    collectedCents: 0, refundsCents: 0, openExceptions: 0, atRiskCents: 0,
  });
  it("flags only the outlier", () => {
    const rows = [row("B01", 100_00, 10, 20, 3), row("B02", 100_00, 10, 20, 3), row("B03", 100_00, 4, 20, 9), row("B04", 100_00, 11, 20, 3)];
    const flags = attentionFlags(rows);
    expect(flags.get("B03")!.map((f) => f.code).sort()).toEqual(["cac", "unknown"]);
    expect(flags.get("B01")).toEqual([]);
  });
});
