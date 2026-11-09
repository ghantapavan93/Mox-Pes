import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor } from "@/lib/adapters/registry";
import { AA_LABEL, analyzeAa, assignArm, recordAaExperiment, runAaExperiment, listExperiments, type AssignedUnit } from "@/lib/decision/experiment";
import { listScenarios, projectScenario, saveScenario, scenario, SCENARIO_LABEL, type BaselineChannel, type Projection } from "@/lib/decision/scenario";
import { budgetSignalCopy, SIGNAL_GATE_LABEL } from "@/lib/decision/signal-copy";
import { decisionVerdicts, type ChannelVerdicts } from "@/lib/decision/verdicts";
import { errorResponse } from "@/lib/http";
import { replay } from "@/lib/ingest/replay";
import { planReplay } from "@/lib/ingest/replay-plan";
import { PERIODS } from "@/lib/period";
import { getException } from "@/lib/queries";
import { ForbiddenError, VIEWERS } from "@/lib/viewer";
import { acquisition, call, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * Decision Lab. The fixture is the ChangeGuard incident at B09 (a Local Services campaign that
 * Google migrated into Performance Max, filed by ads@1.0 as Google Search), plus synthetic web
 * leads for the A/A experiment. Every feed is delivered at NOW so freshness is not the variable.
 */
const BRANCH = "B09";
const NOW = new Date("2026-10-31T13:00:00Z");
const OCT = PERIODS.oct;
const MIGRATION_DAY = 13;
const analyst = VIEWERS.marketing;

const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const at = (d: number, hour = 15) => new Date(`${day(d)}T${String(hour).padStart(2, "0")}:00:00Z`);

function spend(campaign: "lsa" | "pmax" | "search", d: number, costDollars: number): RawRecord {
  const base = {
    lsa: { platform: "google_lsa", accountId: `LSA-${BRANCH}`, campaignId: `lsa-${BRANCH}`, campaignName: `${BRANCH} | Local Services`, campaignType: "LOCAL_SERVICES" },
    pmax: { platform: "google_ads", accountId: `LSA-${BRANCH}`, campaignId: `pmax-lsa-${BRANCH}`, campaignName: `${BRANCH} | Local Services (PMax, pay-per-lead)`, campaignType: "PERFORMANCE_MAX", localServicesEnabled: true },
    search: { platform: "google_ads", accountId: "GA-SW", campaignId: `gs-${BRANCH}`, campaignName: `${BRANCH} | Search`, campaignType: "SEARCH" },
  }[campaign];
  const fetchedAt = new Date(new Date(`${day(d)}T00:00:00Z`).getTime() + 30 * 3_600_000);
  return {
    entity: "spend_day",
    payload: { ...base, date: day(d), costMicros: String(costDollars * 1_000_000), clicks: 10, conversions: 3, fetchedAt: fetchedAt.toISOString() },
  };
}

function webLead(id: string, branchId: string, phone: string, when: Date): RawRecord {
  return {
    entity: "lead",
    payload: {
      messageId: id,
      timestamp: when.toISOString(),
      properties: {
        // No paid evidence: these customers are credited to Unknown and leave paid-channel CAC alone.
        form: "quote", branch_id: branchId, zip: "85001", phone, email: null, utm_source: null, utm_medium: null,
        utm_campaign: null, gclid: null, message: null,
      },
    },
  };
}

/**
 * $300/day Search and $100/day Local Services for 30 days (LSA migrates on day 13); 8 Local
 * Services customers and 6 Search customers, all serviced in October; 60 web leads, every third
 * of which becomes a customer within two days.
 */
async function seedB09(pool: Pool) {
  const ads: RawRecord[] = [];
  for (let d = 1; d <= 30; d++) {
    ads.push(spend("search", d, 300));
    ads.push(d < MIGRATION_DAY ? spend("lsa", d, 100) : spend("pmax", d, 100));
  }
  await ingest(pool, "ads", ads, { mapper: mapperFor("ads", "1.0"), now: NOW });
  await pool.query(
    `insert into campaign_branch_map (campaign_id, branch_id, mapped_by, mapped_at)
     select id, $1, 'marketing-ops', $2 from ad_campaigns on conflict do nothing`,
    [BRANCH, NOW],
  );

  const calls: RawRecord[] = [];
  const crmRecords: RawRecord[] = [];
  let n = 0;
  for (let d = 1; d <= 30; d++) {
    calls.push(call(`LSA-ONLY-${d}`, BRANCH, `+1602555${String(1000 + d)}`, at(d, 14), "Google LSA"));
    if (d % 3 === 0 && d <= 25) {
      const a = acquisition(++n, BRANCH, `+1602556${String(1000 + n)}`, at(d), { source: "Google LSA" });
      calls.push(a.call);
      crmRecords.push(...a.crm);
    }
    if (d % 4 === 0 && d <= 25) {
      const a = acquisition(++n, BRANCH, `+1602556${String(1000 + n)}`, at(d), { source: "Google Ads" });
      calls.push(a.call);
      crmRecords.push(...a.crm);
    }
  }

  const web: RawRecord[] = [];
  for (let i = 0; i < 60; i++) {
    const phone = `+1602557${String(1000 + i)}`;
    const when = new Date(at(1 + (i % 15), 10).getTime() + i * 60_000);
    web.push(webLead(`WEB-${i}`, BRANCH, phone, when));
    if (i % 3 === 0) crmRecords.push(...acquisition(500 + i, BRANCH, phone, new Date(when.getTime() + 3 * 3_600_000)).crm);
  }

  await ingest(pool, "calls", calls, { now: NOW });
  await ingest(pool, "web", web, { now: NOW });
  await ingest(pool, "crm", crmRecords, { now: NOW });
  await runReconcile(pool, NOW);
}

async function coverageGap(pool: Pool) {
  const row = await one<{ id: string }>(pool, "select id from exceptions where kind = 'channel_coverage_gap'");
  return (await getException(pool, Number(row.id)))!;
}

/** The ChangeGuard fix: re-project the misfiled spend through ads@1.1. */
async function remap(pool: Pool) {
  const gap = await coverageGap(pool);
  const plan = await planReplay(pool, gap, "1.1");
  return replay(pool, {
    ...plan, mapperVersion: "1.1", actor: "test", idempotencyKey: "decision-lab-remap", dryRun: false, now: NOW, exceptionId: gap.id,
    scope: { from: OCT.from, to: OCT.to, branchIds: [BRANCH] },
  });
}

const channel = (vs: { channels: ChannelVerdicts[] }, code: string) => vs.channels.find((c) => c.channelCode === code)!;

let pool: Pool;
beforeAll(() => {
  pool = testPool();
});
afterAll(async () => pool.end());

describe("three verdicts, never conflated", () => {
  beforeEach(async () => {
    await freshDb(pool);
    await seedB09(pool);
  });

  it("before the re-map, Search and Local Services fail integrity and are not decision-ready, linked to the coverage gap", async () => {
    const gap = await coverageGap(pool);
    const v = await decisionVerdicts(pool, analyst, { branchId: BRANCH, period: OCT });
    for (const code of ["google_lsa", "google_search"]) {
      const c = channel(v, code);
      expect(c.integrity.status).toBe("fail");
      expect(c.integrity.reasons.find((r) => r.code === "coverage_gap")).toMatchObject({ status: "fail", href: `/exceptions/${gap.id}` });
      expect(c.readiness.status).toBe("not_ready");
      expect(c.readiness.blockers.map((b) => b.href)).toContain(`/exceptions/${gap.id}`);
      expect(c.effectiveness.status).toBe("unknown");
    }
    expect(v.budgetSignal.trustworthy).toBe(false);
  });

  it("after the re-map, integrity and readiness pass while effectiveness stays unknown", async () => {
    const before = await decisionVerdicts(pool, analyst, { branchId: BRANCH, period: OCT });
    const result = await remap(pool);
    expect(result.projected).toBe(30 - MIGRATION_DAY + 1);

    const after = await decisionVerdicts(pool, analyst, { branchId: BRANCH, period: OCT });
    for (const code of ["google_lsa", "google_search"]) {
      const c = channel(after, code);
      expect(c.integrity.status).not.toBe("fail");
      expect(c.readiness.status).toBe("ready");
      expect(c.readiness.blockers).toEqual([]);
      // Integrity fixed ≠ effectiveness known: clean attribution is still not causal evidence.
      expect(c.effectiveness.status).toBe("unknown");
      expect(c.effectiveness.estimate).toBeNull();
      expect(c.effectiveness.reasons.map((r) => r.code)).toEqual(expect.arrayContaining(["no_experiment", "attribution_not_causal"]));
    }
    // The re-map moved cost from Search to Local Services, so attributed CAC changed…
    expect(channel(after, "google_lsa").spendCents).toBeGreaterThan(channel(before, "google_lsa").spendCents);
    // …and still nothing about effectiveness did.
    expect(channel(after, "google_lsa").effectiveness.status).toBe(channel(before, "google_lsa").effectiveness.status);
  });

  it("channels with too few customers are not ready even with clean data", async () => {
    await remap(pool);
    const meta = channel(await decisionVerdicts(pool, analyst, { branchId: BRANCH, period: OCT }), "meta");
    expect(meta.integrity.status).toBe("pass");
    expect(meta.readiness.status).toBe("not_ready");
    expect(meta.readiness.blockers.map((b) => b.code)).toEqual(["min_customers"]);
  });

  it("a stale feed blocks readiness", async () => {
    await remap(pool);
    await pool.query("update app_clock set now = $1", [new Date(NOW.getTime() + 72 * 3_600_000)]);
    const lsa = channel(await decisionVerdicts(pool, analyst, { branchId: BRANCH, period: OCT }), "google_lsa");
    expect(lsa.readiness.status).toBe("not_ready");
    expect(lsa.readiness.blockers.every((b) => b.code === "freshness")).toBe(true);
  });

  it("the branch-page budget card states an observation and never contradicts the Decision Lab", async () => {
    // Before the re-map the gate is closed and the card says so.
    const before = await decisionVerdicts(pool, analyst, { branchId: BRANCH, period: OCT });
    expect(budgetSignalCopy(before.budgetSignal, BRANCH, OCT.key).gate).toEqual({ tone: "bad", label: SIGNAL_GATE_LABEL.blocked });

    await remap(pool);
    const v = await decisionVerdicts(pool, analyst, { branchId: BRANCH, period: OCT });
    // The reported scenario: a "shift" signal from attributed CAC with no blocking incident left…
    expect(v.budgetSignal.signal).toBe("shift");
    expect(v.budgetSignal.trustworthy).toBe(true);
    // …while the Decision Lab still says no channel's effectiveness is known.
    expect(v.channels.every((c) => c.effectiveness.status === "unknown")).toBe(true);

    const copy = budgetSignalCopy(v.budgetSignal, BRANCH, OCT.key);
    const all = `${copy.headline} ${copy.gate.label} ${copy.effectiveness}`;
    // No recommendation and no claim that the evidence is sound: only what the gate checked.
    expect(all).not.toMatch(/obvious move|shift budget|should|evidence is sound/i);
    expect(copy.headline).toContain(`${v.budgetSignal.from!.label} costs ${v.budgetSignal.ratio!.toFixed(1)}× ${v.budgetSignal.to!.label}`);
    expect(copy.headline).toMatch(/attributed/);
    expect(copy.gate).toEqual({ tone: "good", label: SIGNAL_GATE_LABEL.clear });
    expect(copy.gate.label).toBe("Data integrity: no blocking incidents");
    expect(copy.effectiveness).toMatch(/^Effectiveness: unknown/);
    expect(copy.effectiveness).toMatch(/not causal/);
    expect(copy.decisionsHref).toBe(`/decisions?branch=${BRANCH}&period=oct`);
  });

  it("only a completed randomized holdout makes effectiveness measured", async () => {
    await remap(pool);
    await pool.query(
      `insert into experiments (kind, name, branch_ids, channel_code, period_from, period_to, config, result, status, conclusion, actor, created_at)
       values ('holdout', 'LSA geo holdout', $1, 'google_lsa', $2, $3, '{}', $4, 'completed', 'lift measured', 'test', $5)`,
      [[BRANCH], OCT.from, OCT.to, { metric: "Incremental customers per $1,000", unit: "customers", estimate: 0.8, ci95: [0.2, 1.4] }, NOW],
    );
    const v = await decisionVerdicts(pool, analyst, { branchId: BRANCH, period: OCT });
    expect(channel(v, "google_lsa").effectiveness).toMatchObject({ status: "measured", estimate: { estimate: 0.8 } });
    expect(channel(v, "google_search").effectiveness.status).toBe("unknown");
  });
});

describe("scenario math", () => {
  const base: BaselineChannel[] = [
    { channelCode: "a", label: "A", spendCents: 300_000, customers: 10, observedCustomers: 10 },
    { channelCode: "b", label: "B", spendCents: 100_000, customers: 10, observedCustomers: 10 },
  ];
  const shift = [{ fromChannel: "a", toChannel: "b", amountCents: 50_000 }];

  it("β = 1 is constant cost per customer: $500 from $300/customer to $100/customer", () => {
    const p = projectScenario(base, shift, { elasticity: 1, closeRateFactor: 1 }, 1, 1);
    // A: 10 · 2500/3000 = 8.333…; B: 10 · 1500/1000 = 15 → 23.333 vs 20 = +3.333 customers
    expect(p.channels[0].customers.point).toBeCloseTo(8.3333, 4);
    expect(p.channels[1].customers.point).toBeCloseTo(15, 6);
    expect(p.deltaCustomers.point).toBeCloseTo(3.3333, 4);
    // Paid spend is unchanged by a shift: $4,000 / 23.333 customers = $171.43
    expect(p.paidCacCents.point).toBe(17143);
  });

  it("β = 0.5 applies diminishing returns", () => {
    const p = projectScenario(base, shift, { elasticity: 0.5, closeRateFactor: 1 }, 1, 1);
    // A: 10·√(5/6) = 9.1287; B: 10·√1.5 = 12.2474
    expect(p.deltaCustomers.point).toBeCloseTo(10 * Math.sqrt(5 / 6) + 10 * Math.sqrt(1.5) - 20, 6);
    expect(p.deltaCustomers.point).toBeCloseTo(1.3762, 4);
  });

  it("the close-rate assumption scales only the customers the new spend buys", () => {
    const p = projectScenario(base, shift, { elasticity: 1, closeRateFactor: 0.5 }, 1, 1);
    expect(p.channels[1].customers.point).toBeCloseTo(12.5, 6);
    expect(p.deltaCustomers.point).toBeCloseTo(12.5 + 8.3333 - 20, 3);
  });

  it("refuses to move more than a channel spends, or into a channel with no cost history", () => {
    expect(() => projectScenario(base, [{ fromChannel: "b", toChannel: "a", amountCents: 100_001 }], { elasticity: 0.5, closeRateFactor: 1 }, 1, 1)).toThrow(/Cannot move more/);
    const withEmpty = [...base, { channelCode: "c", label: "C", spendCents: 0, customers: 0, observedCustomers: 0 }];
    expect(() => projectScenario(withEmpty, [{ fromChannel: "a", toChannel: "c", amountCents: 1 }], { elasticity: 0.5, closeRateFactor: 1 }, 1, 1)).toThrow(/no spend/);
  });

  it("is deterministic: the same inputs and seed give the same interval", () => {
    const a = projectScenario(base, shift, { elasticity: 0.5, closeRateFactor: 1 }, 7, 1);
    const b = projectScenario(base, shift, { elasticity: 0.5, closeRateFactor: 1 }, 7, 1);
    expect(a).toEqual(b);
  });
});

describe("scenario from the database", () => {
  beforeEach(async () => {
    await freshDb(pool);
    await seedB09(pool);
  });

  const request = (fromChannel: string, toChannel: string) => ({
    branchId: BRANCH,
    period: "oct" as const,
    changes: [{ fromChannel, toChannel, amountCents: 100_000 }],
    assumptions: { elasticity: 0.5, sensitivityElasticities: [0.8, 0.3, 0.5] as [number, number, number], closeRateFactor: 1 },
  });

  const contains = (p: Projection) => {
    for (const r of [p.paidCustomers, p.deltaCustomers, ...p.channels.map((c) => c.customers)]) {
      expect(r.low).toBeLessThanOrEqual(r.point);
      expect(r.high).toBeGreaterThanOrEqual(r.point);
    }
    expect(p.paidCustomers.low).toBeLessThan(p.paidCustomers.point);
    expect(p.paidCustomers.high).toBeGreaterThan(p.paidCustomers.point);
    expect(p.paidCacCents.low!).toBeLessThanOrEqual(p.paidCacCents.point!);
    expect(p.paidCacCents.high!).toBeGreaterThanOrEqual(p.paidCacCents.point!);
  };

  it("uses the historical cost per customer from SQL, and is labelled not decision-ready with the blockers before the re-map", async () => {
    const gap = await coverageGap(pool);
    const r = await scenario(pool, analyst, request("google_search", "google_lsa"));
    expect(r.label).toBe(SCENARIO_LABEL);
    expect(r.decisionReady).toBe(false);
    expect(r.blockers.map((b) => b.href)).toContain(`/exceptions/${gap.id}`);
    // Baseline = the scorecard's numbers, scaled to 30 days (October is 30 days: factor 1).
    const search = r.baseline.channels.find((c) => c.channelCode === "google_search")!;
    expect(search.spendCents).toBe(12 * 30_000 + (30 - 12) * 40_000);
    expect(search.observedCustomers).toBe(6);
    // Coverage is the weakest involved channel: Local Services spend stops after Oct 12, which
    // is the coverage gap showing through (12 days in 3 Monday-start weeks of 30 expected days).
    expect(r.coverage).toMatchObject({ spendDays: 12, weeksWithSpend: 3, expectedSpendDays: 30 });
  });

  it("after the re-map: decision-ready, sensitivity ordered and monotone, intervals contain the point", async () => {
    await remap(pool);
    const toCheaper = await scenario(pool, analyst, request("google_search", "google_lsa"));
    expect(toCheaper.decisionReady).toBe(true);
    expect(toCheaper.blockers).toEqual([]);
    expect(toCheaper.sensitivity.map((s) => s.elasticity)).toEqual([0.3, 0.5, 0.8]);
    const up = toCheaper.sensitivity.map((s) => s.deltaCustomers.point);
    // Search $9,000 / 6 customers → LSA $3,000 / 8 customers: more responsive spend, bigger gain.
    expect(up[0]).toBeGreaterThan(0);
    expect(up[1]).toBeGreaterThan(up[0]);
    expect(up[2]).toBeGreaterThan(up[1]);
    // Hand check of the middle row: 8((4000/3000)^½ − 1) + 6((8000/9000)^½ − 1)
    expect(toCheaper.projection.deltaCustomers.point).toBeCloseTo(8 * (Math.sqrt(4 / 3) - 1) + 6 * (Math.sqrt(8 / 9) - 1), 6);
    contains(toCheaper.projection);
    toCheaper.sensitivity.forEach(contains);

    const toDearer = await scenario(pool, analyst, request("google_lsa", "google_search"));
    const down = toDearer.sensitivity.map((s) => s.deltaCustomers.point);
    expect(down[0]).toBeLessThan(0);
    expect(down[1]).toBeLessThan(down[0]);
    expect(down[2]).toBeLessThan(down[1]);
    expect(toDearer.projection.paidCacCents.point!).toBeGreaterThan(toDearer.baseline.paidCacCents!);
  });

  it("saves with params, result, actor and an audit row; history is scoped", async () => {
    const saved = await saveScenario(pool, analyst, request("google_search", "google_lsa"));
    expect(saved.decisionReady).toBe(false);
    const row = await one(pool, "select actor, decision_ready, params, result ->> 'label' as label from decision_scenarios where id = $1", [saved.id]);
    expect(row).toMatchObject({ actor: "marketing", decision_ready: false, label: SCENARIO_LABEL });
    expect((row.params as { changes: unknown[] }).changes).toHaveLength(1);
    const audit = await one(pool, "select action, actor from audit_log where subject = $1", [`decision_scenario:${saved.id}`]);
    expect(audit).toEqual({ action: "save_scenario", actor: "marketing" });

    expect((await listScenarios(pool, analyst, { branchId: BRANCH })).map((s) => s.id)).toEqual([saved.id]);
    expect(await listScenarios(pool, VIEWERS.partner)).toEqual([]);
  });

  it("refuses roles without investigate or propose, and branches outside the viewer's scope", async () => {
    await expect(scenario(pool, VIEWERS.guest, request("google_search", "google_lsa"))).rejects.toBeInstanceOf(ForbiddenError);
    await expect(scenario(pool, VIEWERS.partner, request("google_search", "google_lsa"))).rejects.toBeInstanceOf(ForbiddenError);
    expect((await one(pool, "select count(*) n from decision_scenarios")).n).toBe("0");
  });
});

describe("A/A experiment", () => {
  const units = (arm: "A" | "B", n: number, converted: number, refunded = 0): AssignedUnit[] =>
    Array.from({ length: n }, (_, i) => ({ arm, converted: i < converted, refunded: i < refunded }));

  it("the sample-ratio check flags an injected 60/40 split and voids the comparison", () => {
    const a = analyzeAa([...units("A", 600, 180), ...units("B", 400, 120)]);
    expect(a.srm.flagged).toBe(true);
    expect(a.srm.pValue).toBeLessThan(0.001);
    expect(a.conclusion.status).toBe("invalid_srm");
    // A split within chance is not flagged.
    expect(analyzeAa([...units("A", 505, 150), ...units("B", 495, 150)]).srm.flagged).toBe(false);
  });

  it("on a balanced fixture the 95% CI contains 0 and the conclusion says so", () => {
    const a = analyzeAa([...units("A", 500, 150, 6), ...units("B", 500, 150, 6)]);
    expect(a.conversion.difference).toBe(0);
    expect(a.conversion.ci95![0]).toBeLessThan(0);
    expect(a.conversion.ci95![1]).toBeGreaterThan(0);
    expect(a.conclusion.status).toBe("no_difference");
    expect(a.conclusion.text).toMatch(/^No detectable difference — expected for an A\/A test/);
    expect(a.guardrail.flagged).toBe(false);
  });

  it("a real gap is reported as a detected difference, never as success", () => {
    const a = analyzeAa([...units("A", 1000, 200), ...units("B", 1000, 400)]);
    expect(a.conclusion.status).toBe("difference_detected");
  });

  it("assignment is a stable hash of the lead id, close to 50/50", () => {
    expect(assignArm("s", "web:X-1")).toBe(assignArm("s", "web:X-1"));
    const arms = Array.from({ length: 4000 }, (_, i) => assignArm("aa-web-v1", `web:L-${i}`));
    const shareA = arms.filter((a) => a === "A").length / arms.length;
    expect(Math.abs(shareA - 0.5)).toBeLessThan(0.03);
  });

  describe("over the database", () => {
    beforeEach(async () => {
      await freshDb(pool);
      await seedB09(pool);
    });

    it("randomizes mature web leads, joins outcomes from v_acquisitions, and is reproducible", async () => {
      const r = await runAaExperiment(pool, analyst, { period: "oct", windowDays: 14, salt: "aa-web-v1" });
      const { A, B } = r.analysis.arms;
      // All 60 web leads happen Oct 1–15, so all are mature by Oct 31 with a 14-day window.
      expect(A.units + B.units).toBe(60);
      expect(r.excludedImmature).toBe(0);
      expect(A.converted + B.converted).toBe(20);
      const expectedA = Array.from({ length: 60 }, (_, i) => assignArm("aa-web-v1", `web:WEB-${i}`)).filter((a) => a === "A").length;
      expect(A.units).toBe(expectedA);
      expect((await runAaExperiment(pool, analyst, { period: "oct", windowDays: 14, salt: "aa-web-v1" })).assignmentFingerprint).toBe(r.assignmentFingerprint);

      // A window that has not closed yet is excluded, not counted as "not converted".
      const late = await runAaExperiment(pool, analyst, { period: "oct", windowDays: 25, salt: "aa-web-v1" });
      expect(late.excludedImmature).toBeGreaterThan(0);
      expect(late.analysis.arms.A.units + late.analysis.arms.B.units + late.excludedImmature).toBe(60);
    });

    it("is labelled a statistics self-check: arms are hashed at analysis time, so it cannot validate assignment or logging", async () => {
      const r = await runAaExperiment(pool, analyst, { period: "oct", windowDays: 14, salt: "aa-web-v1" });
      expect(r.label).toBe(AA_LABEL);
      expect(AA_LABEL).toBe("A/A analysis self-check (statistics only)");
      expect(r.label).not.toMatch(/pipeline validation|randomized/i);
      expect(r.config.assignment).toMatch(/computed at analysis time/);
      expect(r.limitation).toMatch(/no assignment is logged at lead time/i);
      expect(r.limitation).toMatch(/cannot detect assignment or exposure-logging faults/i);

      // A recorded run surfaces in the effectiveness verdict as a statistics check, not as
      // reassurance about an experimentation pipeline.
      await recordAaExperiment(pool, analyst, { period: "oct", windowDays: 14, salt: "aa-web-v1" });
      const v = await decisionVerdicts(pool, analyst, { branchId: BRANCH, period: OCT });
      for (const c of v.channels) {
        const reason = c.effectiveness.reasons.find((x) => x.code === "aa_self_check")!;
        expect(reason.text).toMatch(/^A\/A statistics self-check/);
        expect(reason.text).not.toMatch(/pipeline/i);
        expect(c.effectiveness.reasons.some((x) => x.code === "pipeline_validation")).toBe(false);
      }
    });

    it("an SRM conclusion blames the hash split or unit definition, not lead-time logging that does not exist", () => {
      const a = analyzeAa([...units("A", 600, 180), ...units("B", 400, 120)]);
      expect(a.conclusion.text).not.toMatch(/logging|pipeline/i);
      expect(a.conclusion.text).toMatch(/hash split or the unit definition/);
    });

    it("records config and result with an audit row; scoped viewers cannot see company-wide runs", async () => {
      const stored = await recordAaExperiment(pool, analyst, { period: "oct", windowDays: 14, salt: "aa-web-v1" });
      expect(stored.kind).toBe("aa");
      const row = await one(pool, "select config ->> 'salt' as salt, result -> 'analysis' -> 'arms' as arms, actor from experiments where id = $1", [stored.id]);
      expect(row.salt).toBe("aa-web-v1");
      expect(row.actor).toBe("marketing");
      expect((await one(pool, "select action from audit_log where subject = $1", [`experiment:${stored.id}`])).action).toBe("record_experiment");
      expect((await listExperiments(pool, analyst)).map((e) => e.id)).toEqual([stored.id]);
      expect(await listExperiments(pool, VIEWERS.partner)).toEqual([]);
      await expect(recordAaExperiment(pool, VIEWERS.guest, { period: "oct", windowDays: 14, salt: "x" })).rejects.toBeInstanceOf(ForbiddenError);
    });
  });
});

describe("branch scope", () => {
  beforeAll(async () => {
    await freshDb(pool);
    await seedB09(pool);
  });

  it("a branch partner gets 403 for another branch on every Decision Lab read", async () => {
    const partner = VIEWERS.partner;
    await expect(decisionVerdicts(pool, partner, { branchId: BRANCH, period: OCT })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(listScenarios(pool, partner, { branchId: BRANCH })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(runAaExperiment(pool, partner, { period: "oct", windowDays: 14, salt: "s", branchId: BRANCH })).rejects.toBeInstanceOf(ForbiddenError);
    const forbidden = await decisionVerdicts(pool, partner, { branchId: BRANCH, period: OCT }).catch((e: unknown) => e);
    expect(errorResponse(forbidden).status).toBe(403);
  });

  it("the partner's own branch works, and its A/A sees only its own leads", async () => {
    const own = await decisionVerdicts(pool, VIEWERS.partner, { branchId: VIEWERS.partner.branchIds![0], period: OCT });
    expect(own.channels.length).toBeGreaterThan(0);
    const aa = await runAaExperiment(pool, VIEWERS.partner, { period: "oct", windowDays: 14, salt: "s" });
    expect(aa.branchIds).toEqual(VIEWERS.partner.branchIds);
    expect(aa.analysis.arms.A.units + aa.analysis.arms.B.units).toBe(0);
    expect(aa.analysis.conclusion.status).toBe("insufficient_data");
  });
});
