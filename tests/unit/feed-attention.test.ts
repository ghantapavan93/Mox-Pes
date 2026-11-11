import { describe, expect, it } from "vitest";
import { STALE_AFTER_MS, feedAttention } from "../../lib/health/feeds";

describe("feedAttention (one staleness rule for the top bar and Audit & Health)", () => {
  const now = new Date("2026-10-31T08:00:00Z");
  const ago = (ms: number) => new Date(now.getTime() - ms);

  it("a feed whose last success is within 36 hours and whose last run succeeded is fine", () => {
    const r = feedAttention([{ stream: "ads", lastSuccessAt: ago(STALE_AFTER_MS), lastRunStatus: "succeeded" }], now);
    expect(r).toMatchObject({ ok: true, stale: [], failing: [] });
  });

  it("a success older than 36 hours, or none at all, is stale", () => {
    const r = feedAttention(
      [
        { stream: "ads", lastSuccessAt: ago(STALE_AFTER_MS + 1), lastRunStatus: "succeeded" },
        { stream: "calls", lastSuccessAt: null, lastRunStatus: null },
      ],
      now,
    );
    expect(r.stale.map((s) => s.stream)).toEqual(["ads", "calls"]);
    expect(r.ok).toBe(false);
  });

  it("a failed latest run is failing even when an older success is recent", () => {
    const r = feedAttention([{ stream: "crm.ticket", lastSuccessAt: ago(3_600_000).toISOString(), lastRunStatus: "failed" }], now);
    expect(r.failing.map((s) => s.stream)).toEqual(["crm.ticket"]);
    expect(r.stale).toEqual([]);
  });
});
