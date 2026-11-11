import { describe, expect, it } from "vitest";
import { activeOverride, type OverrideRow } from "@/lib/opportunities/overrides";
import { assessReadiness, checkOverride, READINESS_POLICY, type ReadinessInput } from "@/lib/opportunities/readiness";
import { VIEWERS } from "@/lib/viewer";

/** Decision readiness policy (lib/opportunities/readiness.ts): the rules, one at a time. */
const ready: ReadinessInput = {
  valueAtStakeCents: 2_000_000,
  smallestArm: 120,
  dataAgeMs: 3_600_000,
  openDataBlockers: 0,
  patternSupported: true,
  measuredOutcome: false,
};
const failed = (input: ReadinessInput) => assessReadiness(input).checks.filter((c) => !c.passed).map((c) => c.key);

describe("readiness levels", () => {
  it("a material, supported pattern with no measured outcome is 'validate', never 'act'", () => {
    expect(assessReadiness(ready).level).toBe("validate");
    expect(failed(ready)).toEqual(["outcome"]);
  });

  it("only a measured outcome reaches 'act'", () => {
    expect(assessReadiness({ ...ready, measuredOutcome: true }).level).toBe("act");
  });

  it("stale data, a feed that never delivered, open blockers or a small sample block", () => {
    expect(assessReadiness({ ...ready, dataAgeMs: READINESS_POLICY.maxDataAgeMs + 1 }).level).toBe("blocked");
    expect(assessReadiness({ ...ready, dataAgeMs: null }).level).toBe("blocked");
    expect(assessReadiness({ ...ready, openDataBlockers: 1 }).level).toBe("blocked");
    expect(assessReadiness({ ...ready, smallestArm: READINESS_POLICY.minArmUnits - 1 }).level).toBe("blocked");
    expect(assessReadiness({ ...ready, smallestArm: READINESS_POLICY.minArmUnits }).level).toBe("validate");
  });

  it("an immaterial or unsupported pattern is 'monitor', even with a measured outcome", () => {
    expect(assessReadiness({ ...ready, valueAtStakeCents: READINESS_POLICY.materialityCents - 1 }).level).toBe("monitor");
    expect(assessReadiness({ ...ready, patternSupported: false }).level).toBe("monitor");
    expect(assessReadiness({ ...ready, patternSupported: null, measuredOutcome: true }).level).toBe("monitor");
  });

  it("blocking checks win over everything else", () => {
    const a = assessReadiness({ ...ready, openDataBlockers: 2, patternSupported: false, valueAtStakeCents: 0 });
    expect(a.level).toBe("blocked");
    expect(a.next).toMatch(/data-quality/);
  });
});

describe("which recorded override applies now", () => {
  const row = (assessedLevel: "blocked" | "monitor" | "validate", acceptedRisks: string[]): OverrideRow => ({
    id: 1, journey: "missed_follow_up", assessedLevel, overrideLevel: "act", acceptedRisks, reason: "x".repeat(20), subject: "demo:approver", role: "approver", createdAt: "",
  });

  it("applies while the same risks are the only failures", () => {
    expect(activeOverride(assessReadiness(ready), [row("validate", ["outcome"])])).not.toBeNull();
  });

  it("lapses when a new risk fails at the same level", () => {
    const smallSample = assessReadiness({ ...ready, smallestArm: 5 });
    const staleToo = assessReadiness({ ...ready, smallestArm: 5, dataAgeMs: null });
    expect(activeOverride(smallSample, [row("blocked", ["sample", "outcome"])])).not.toBeNull();
    // Still "blocked", but now also stale: the override never covered that, and cannot.
    expect(staleToo.level).toBe("blocked");
    expect(activeOverride(staleToo, [row("blocked", ["sample", "outcome"])])).toBeNull();
    // Monitor because of materiality, override accepted pattern: does not apply.
    expect(activeOverride(assessReadiness({ ...ready, valueAtStakeCents: 0 }), [row("monitor", ["pattern", "outcome"])])).toBeNull();
  });

  it("lapses when the data assesses at another level", () => {
    expect(activeOverride(assessReadiness(ready), [row("blocked", ["sample", "outcome"])])).toBeNull();
  });
});

describe("override policy", () => {
  const validate = assessReadiness(ready);
  const reason = "Pilot is cheap; the sample check is scheduled for next week.";

  it("needs the approve permission", () => {
    expect(checkOverride(validate, { viewer: VIEWERS.marketing, reason, to: "act" })).toMatchObject({ ok: false, code: "FORBIDDEN" });
    expect(checkOverride(validate, { viewer: VIEWERS.approver, reason, to: "act" })).toMatchObject({ ok: true, from: "validate", to: "act", acceptedRisks: ["outcome"] });
  });

  it("needs a reason of at least 20 characters (whitespace does not count)", () => {
    expect(checkOverride(validate, { viewer: VIEWERS.approver, reason: "   ok, go ahead     ", to: "act" })).toMatchObject({ ok: false, code: "REASON_REQUIRED" });
  });

  it("raises by exactly one level", () => {
    const monitor = assessReadiness({ ...ready, valueAtStakeCents: 0 });
    expect(checkOverride(monitor, { viewer: VIEWERS.approver, reason, to: "act" })).toMatchObject({ ok: false, code: "ONE_LEVEL_ONLY" });
    expect(checkOverride(monitor, { viewer: VIEWERS.approver, reason, to: "monitor" })).toMatchObject({ ok: false, code: "ONE_LEVEL_ONLY" });
    expect(checkOverride(monitor, { viewer: VIEWERS.approver, reason, to: "validate" })).toMatchObject({ ok: true, acceptedRisks: ["materiality", "outcome"] });
    expect(checkOverride(assessReadiness({ ...ready, measuredOutcome: true }), { viewer: VIEWERS.approver, reason, to: "act" })).toMatchObject({ ok: false, code: "ONE_LEVEL_ONLY" });
  });

  it("never overrides stale data or open data-quality exceptions; a small sample is an acceptable risk", () => {
    for (const input of [{ ...ready, dataAgeMs: null }, { ...ready, openDataBlockers: 1 }]) {
      expect(checkOverride(assessReadiness(input), { viewer: VIEWERS.approver, reason, to: "monitor" })).toMatchObject({ ok: false, code: "NOT_OVERRIDABLE" });
    }
    expect(checkOverride(assessReadiness({ ...ready, smallestArm: 5 }), { viewer: VIEWERS.approver, reason, to: "monitor" })).toMatchObject({ ok: true, acceptedRisks: ["sample", "outcome"] });
  });
});
