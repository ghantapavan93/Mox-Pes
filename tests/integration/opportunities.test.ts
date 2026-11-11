import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { ActionError } from "@/lib/actions";
import { missedFollowUp, retentionBeforeService } from "@/lib/opportunities/journeys";
import { journeyFor, listOverrides, recordOverride } from "@/lib/opportunities/overrides";
import { PERIODS } from "@/lib/period";
import { ForbiddenError, VIEWERS } from "@/lib/viewer";
import { call, crm, freshDb, ingest, one, testPool } from "../helpers";

/**
 * Revenue-opportunity journeys on a fixture whose answers are known by construction (all at B01,
 * October, business clock 2026-10-31 13:00Z, every feed delivered at that instant):
 *
 *   missed follow-up  40 prospects contact once (20 convert); 50 contact twice two days apart
 *                     (5 convert). Repeat contacts convert far less: the pattern is supported.
 *   retention         80 subscriptions at $1,500 a year with an initial visit: 40 visited within
 *                     2 days (2 lost before service), 40 after 6 days (12 lost).
 */
const NOW = new Date("2026-10-31T13:00:00Z");
const B = "B01";
const DAY = 86_400_000;
const oct = (d: number, h = 15) => new Date(Date.UTC(2026, 9, d, h));
const phone = (area: string, i: number) => `+1${area}555${String(i).padStart(4, "0")}`;

let pool: Pool;

beforeAll(async () => {
  pool = testPool();
  await freshDb(pool);
  const calls: RawRecord[] = [];
  const crmRecords: RawRecord[] = [];
  let id = 0;
  const convert = (p: string, at: Date, value = "540.00") => {
    const customerId = 10_000 + ++id;
    crmRecords.push(crm.customer(customerId, B, p, at), crm.subscription(20_000 + id, customerId, B, at, { contractValue: value }));
  };
  for (let i = 0; i < 40; i++) {
    const at = oct(2 + (i % 10));
    calls.push(call(`S-${i}`, B, phone("212", i), at));
    if (i < 20) convert(phone("212", i), new Date(at.getTime() + DAY));
  }
  for (let i = 0; i < 50; i++) {
    const at = oct(2 + (i % 10));
    calls.push(call(`R-${i}a`, B, phone("646", i), at), call(`R-${i}b`, B, phone("646", i), new Date(at.getTime() + 2 * DAY)));
    if (i < 5) convert(phone("646", i), new Date(at.getTime() + 3 * DAY));
  }
  for (let j = 0; j < 80; j++) {
    const customerId = 30_000 + j;
    const subId = 40_000 + j;
    const soldAt = oct(3 + (j % 10));
    const visit = new Date(soldAt.getTime() + (j < 40 ? 2 : 6) * DAY);
    const lost = j < 2 || (j >= 40 && j < 52);
    crmRecords.push(
      crm.customer(customerId, B, phone("718", j), soldAt),
      lost
        ? crm.subscription(subId, customerId, B, soldAt, { contractValue: "1500.00", active: "0", dateCancelled: "2026-10-20 10:00:00", dateUpdated: "2026-10-20 10:00:00" })
        : crm.subscription(subId, customerId, B, soldAt, { contractValue: "1500.00" }),
      crm.appointment(50_000 + j, subId, customerId, B, lost ? "-1" : "1", visit, visit),
    );
  }
  await ingest(pool, "calls", calls, { now: NOW });
  await ingest(pool, "crm", crmRecords, { now: NOW });
  // One web lead, too recent to be a unit, so the web feed is fresh.
  await ingest(pool, "web", [{ entity: "lead", payload: { messageId: "W-1", timestamp: oct(29).toISOString(), properties: { form: "quote", branch_id: B, zip: "10001", phone: phone("917", 1), email: null, utm_source: null, utm_medium: null, utm_campaign: null, gclid: null, message: null } } }], { now: NOW });
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe("missed follow-up", () => {
  it("counts units, repeats and conversions exactly, and reads the supported pattern", async () => {
    const brief = await missedFollowUp(pool, { period: PERIODS.oct, branchIds: null });
    expect(brief.comparison).toMatchObject({ xA: 20, nA: 40, xB: 5, nB: 50 });
    expect(brief.comparison.ci95![1]).toBeLessThan(0);
    expect(brief.branches).toEqual([{ branchId: B, units: 90, flagged: 45, valueAtRiskCents: brief.readinessInput.valueAtStakeCents }]);
    // 45 unconverted repeat prospects × 50% single-contact rate × median first-subscription value
    // ($1,500: 80 of the 105 October subscriptions).
    expect(brief.readinessInput.valueAtStakeCents).toBe(45 * 0.5 * 150_000);
    expect(brief.readinessInput).toMatchObject({ smallestArm: 40, openDataBlockers: 0, patternSupported: true, measuredOutcome: false, dataAgeMs: 0 });
    expect(brief.readiness.level).toBe("validate");
  });

  it("labels every statement, and states that no outcome has been measured", async () => {
    const brief = await missedFollowUp(pool, { period: PERIODS.oct, branchIds: null });
    expect(brief.claims.map((c) => c.kind)).toEqual(["observed_fact", "observed_fact", "inference", "inference", "hypothesis", "recommendation", "measured_outcome"]);
    expect(brief.claims.at(-1)!.statement).toMatch(/^None\./);
    expect(brief.claims.find((c) => c.kind === "hypothesis")!.basis).toMatch(/Not observable/);
  });
});

describe("retention before the first service", () => {
  it("compares short and long waits and values only the supported excess", async () => {
    const brief = await retentionBeforeService(pool, { period: PERIODS.oct, branchIds: null });
    expect(brief.comparison).toMatchObject({ xA: 2, nA: 40, xB: 12, nB: 40 });
    expect(brief.comparison.ci95![0]).toBeGreaterThan(0);
    expect(brief.branches).toEqual([{ branchId: B, units: 80, flagged: 14, valueAtRiskCents: 14 * 150_000 }]);
    // (30% − 5%) × 40 long-wait sales = 10 excess cancellations × $1,500.
    expect(brief.readinessInput.valueAtStakeCents).toBe(1_500_000);
    expect(brief.readiness.level).toBe("validate");
  });
});

describe("scope", () => {
  it("a branch-scoped viewer sees only its branches, and cannot ask for another", async () => {
    const own = await journeyFor(pool, VIEWERS.partner, "missed_follow_up", "oct", null);
    expect(own.scope).toEqual(VIEWERS.partner.branchIds);
    expect(own.branches).toEqual([]);
    await expect(journeyFor(pool, VIEWERS.partner, "missed_follow_up", "oct", B)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("readiness overrides", () => {
  const reason = "Callback pilot is cheap and reversible; sample check booked.";

  it("refuses a role without approve, and a missing reason", async () => {
    await expect(recordOverride(pool, VIEWERS.marketing, { journey: "missed_follow_up", period: "oct", branch: null, to: "act", reason })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(recordOverride(pool, VIEWERS.approver, { journey: "missed_follow_up", period: "oct", branch: null, to: "act", reason: "go" })).rejects.toMatchObject({ status: 400 });
  });

  it("records an approved one-level override with the person, the accepted risk and an audit row", async () => {
    const { override } = await recordOverride(pool, VIEWERS.approver, { journey: "missed_follow_up", period: "oct", branch: null, to: "act", reason });
    expect(override).toMatchObject({ assessedLevel: "validate", overrideLevel: "act", acceptedRisks: ["outcome"], subject: "demo:approver", role: "approver" });
    expect(await listOverrides(pool, "missed_follow_up", "oct", null)).toMatchObject([{ id: override.id, reason }]);
    const audit = await one<{ actor: string; detail: { by: string; to: string } }>(pool, "select actor, detail from audit_log where action = 'override_opportunity_readiness' and subject = $1", [`opportunity_override:${override.id}`]);
    expect(audit).toMatchObject({ actor: "approver", detail: { by: "demo:approver", to: "act" } });
    await expect(pool.query("update opportunity_overrides set reason = 'edited after the fact' where id = $1", [override.id])).rejects.toThrow(/append-only/);
    await expect(pool.query("delete from opportunity_overrides where id = $1", [override.id])).rejects.toThrow(/append-only/);
  });

  it("an open data-quality exception blocks the journey, and that cannot be overridden", async () => {
    await pool.query(
      `insert into exceptions (kind, severity, fingerprint, branch_id, subject_type, subject_id, summary, evidence, first_detected_at, last_detected_at)
       values ('channel_coverage_gap', 'high', 'test-gap-b01', $1, 'branch', $1, 'Calls stopped arriving', '{}'::jsonb, $2, $2)`,
      [B, NOW],
    );
    try {
      const brief = await missedFollowUp(pool, { period: PERIODS.oct, branchIds: null });
      expect(brief.readiness.level).toBe("blocked");
      const refused = recordOverride(pool, VIEWERS.approver, { journey: "missed_follow_up", period: "oct", branch: null, to: "monitor", reason });
      await expect(refused).rejects.toBeInstanceOf(ActionError);
      await expect(refused).rejects.toMatchObject({ status: 409, message: expect.stringMatching(/Cannot be overridden/) });
    } finally {
      await pool.query("update exceptions set status = 'resolved', resolved_at = $1 where fingerprint = 'test-gap-b01'", [NOW]);
    }
    expect((await missedFollowUp(pool, { period: PERIODS.oct, branchIds: null })).readiness.level).toBe("validate");
  });
});
