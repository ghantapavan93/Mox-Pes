import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { proposeCurrencyRule } from "@/lib/currency/rules";
import { reliabilitySignals } from "@/lib/health/signals";
import { PERIODS } from "@/lib/period";
import { VIEWERS } from "@/lib/viewer";
import { acquisition, crm, freshDb, ingest, runReconcile, testPool } from "../helpers";

/** Reliability signals fire only on an actionable condition, each with its size, owner and place. */
const NOW = new Date("2026-10-31T13:00:00Z");
const STREAMS: Array<[string, string]> = [["ads", "ads"], ["calls", "calls"], ["web", "web"], ["d2d", "d2d"], ["crm.customer", "crm"], ["crm.subscription", "crm"], ["crm.appointment", "crm"], ["crm.ticket", "crm"], ["crm.payment", "crm"]];

let pool: Pool;
beforeEach(async () => {
  pool ??= testPool();
  await freshDb(pool, { currencyRule: false });
  for (const [stream, source] of STREAMS) {
    await pool.query("insert into ingestion_runs (source, stream, adapter_version, started_at, finished_at, status) values ($1, $2, 'test', $3, $3, 'succeeded')", [source, stream, new Date(NOW.getTime() - 3_600_000)]);
  }
}, 60_000);
afterAll(async () => pool?.end());

const spend = (campaignId: string, d: number, extra: Record<string, unknown> = {}): RawRecord => ({
  entity: "spend_day",
  payload: { platform: "google_ads", accountId: "ACC-SIG", campaignId, campaignName: `${campaignId} search`, date: `2026-10-${String(d).padStart(2, "0")}`, costMicros: "40000000", clicks: 2, conversions: 1, fetchedAt: `2026-10-${String(d).padStart(2, "0")}T23:00:00Z`, campaignType: "SEARCH", ...extra },
});

describe("reliability signals", () => {
  it("say nothing when nothing needs doing", async () => {
    await ingest(pool, "ads", [spend("sig-usd", 3, { currencyCode: "USD" })], { now: NOW });
    expect(await reliabilitySignals(pool, { period: PERIODS.oct, now: NOW })).toEqual([]);
  });

  it("name unstated currency, a pending rule, customers left out with held spend, and broken refunds", async () => {
    await ingest(pool, "ads", [spend("sig-none", 3), spend("sig-none", 4)], { now: NOW });
    const won = acquisition(1, "B11", "+14805510001", new Date(Date.UTC(2026, 9, 5, 16)), { source: "Google Ads" });
    (won.call.payload as Record<string, unknown>).campaign = "sig-none";
    await ingest(pool, "calls", [won.call], { now: NOW });
    await ingest(pool, "crm", won.crm, { now: NOW });
    // A refund pointing at a payment that is not stored.
    await ingest(pool, "crm", [crm.payment(9100, 1001, 4001, "B11", "-20.00", new Date(Date.UTC(2026, 9, 20, 16)), "1", "777777")], { now: NOW });
    await runReconcile(pool, NOW);
    const before = await reliabilitySignals(pool, { period: PERIODS.oct, now: NOW });
    expect(before.map((s) => s.code).sort()).toEqual(["currency_unstated", "held_spend_customers", "refund_integrity"]);
    expect(before.find((s) => s.code === "currency_unstated")?.text).toMatch(/2 campaign-day\(s\), \$80\.00 as written/);
    await proposeCurrencyRule(pool, VIEWERS.engineer, { platform: "google_ads", adAccountId: "ACC-SIG", reason: "the account settings show USD billing", now: NOW });
    const after = await reliabilitySignals(pool, { period: PERIODS.oct, now: NOW });
    expect(after.find((s) => s.code === "currency_rule_pending")).toMatchObject({ owner: "approver" });
    // A proposal is not yet a rule: the spend is still held and still awaits a decision, so both
    // signals stand until a different approver authorizes it (VP acceptance, first contact: the
    // proposal used to hide the held money).
    expect(after.find((s) => s.code === "currency_unstated")?.text).toMatch(/2 campaign-day\(s\), \$80\.00 as written/);
  });
});
