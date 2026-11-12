import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapCampaignToBranch } from "@/lib/actions";
import { assureAnswer } from "@/lib/shadow/answer";
import { compareSnapshot, type Snapshot } from "@/lib/shadow/snapshot";
import { listShadowChecks, runShadowCheck } from "@/lib/shadow/store";
import { ForbiddenError, VIEWERS } from "@/lib/viewer";
import { acquisition, crm, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * Shadow Mode against a world small enough to compute by hand (docs/agent-work/SHADOW-MODE.md).
 * The independent oracle is the frozen pack in docs/agent-work/shadow-acceptance/; these tests
 * pin the contract's verdict order and the storage rules.
 *
 * B12, October: campaign sh-gs mapped to B12 spends $40.00 a day on Oct 1–30 = $1,200.00; five
 * customers call from it and are first serviced in October; each pays $149.00.
 *   paid CAC = $1,200.00 ÷ 5 = $240.00 · collected = 5 × $149.00 = $745.00
 */
const NOW = new Date("2026-10-31T13:00:00Z");
const at = (d: number) => new Date(Date.UTC(2026, 9, d, 16));
const { marketing, partner } = VIEWERS;
const ASOF = "2026-10-31T06:00:00Z";

let pool: Pool;
beforeEach(async () => {
  pool ??= testPool();
  await freshDb(pool);
  const days = Array.from({ length: 30 }, (_, i) => i + 1);
  const spend = (d: number): RawRecord => ({ entity: "spend_day", payload: { platform: "google_ads", accountId: "ACC-SH", campaignId: "sh-gs", campaignName: "sh-gs search", date: `2026-10-${String(d).padStart(2, "0")}`, costMicros: String(40 * 1_000_000), clicks: 2, conversions: 1, fetchedAt: `2026-10-${String(d).padStart(2, "0")}T23:00:00Z`, campaignType: "SEARCH", currencyCode: "USD" } });
  await ingest(pool, "ads", days.map(spend), { now: NOW });
  const c = await one<{ id: string }>(pool, "select id from ad_campaigns where external_campaign_id = 'sh-gs'");
  await mapCampaignToBranch(pool, { campaignId: Number(c.id), branchId: "B12", actor: "setup", reason: "fixture mapping", now: at(1) });
  for (let n = 1; n <= 5; n++) {
    const won = acquisition(n, "B12", `+148055580${String(n).padStart(2, "0")}`, at(3 + (n - 1) * 4));
    (won.call.payload as Record<string, unknown>).campaign = "sh-gs";
    await ingest(pool, "calls", [won.call], { now: NOW });
    await ingest(pool, "crm", won.crm, { now: NOW });
  }
  await runReconcile(pool, NOW);
}, 90_000);
afterAll(async () => pool?.end());

const CAC_DEF = { id: "atlas.paid_cac", version: "3", family: "cac", numerator: "paid_media_spend_mapped_to_branch", population: "new_customers_first_serviced_paid_first_touch", periodBasis: "utc_day", branchBasis: "campaign_mapping" };
const CASH_DEF = { id: "atlas.collected", version: "1", family: "cash", cashBasis: "payment_date_net_of_refunds", periodBasis: "utc_day", branchBasis: "crm_office" };
const snap = (over: Partial<Snapshot> = {}): Snapshot => ({
  system: "atlas-bi",
  asOf: ASOF,
  definition: CAC_DEF,
  scope: { branch: "B12" },
  period: { from: "2026-10-01", to: "2026-10-30" },
  currency: "USD",
  value: "240.00",
  numerator: "1200.00",
  denominator: 5,
  ...over,
});
const check = (s: Snapshot, viewer = marketing) => compareSnapshot(pool, viewer, s, NOW);

describe("metric snapshots, in the contract's verdict order", () => {
  it("MATCH when the definition, currency and value agree to the cent", async () => {
    const r = await check(snap());
    expect(r.verdict).toBe("MATCH");
    expect(r.ours).toMatchObject({ metric: "paidCac", value: 24_000, numerator: 120_000, denominator: 5 });
    expect(r.proof.href).toBe("/branches/B12/trace?period=oct&metric=paid_cac");
  });

  it("MISMATCH names the side that differs: a wrong denominator, not just a wrong value", async () => {
    const r = await check(snap({ value: "300.00", denominator: 4 }));
    expect(r.verdict).toBe("MISMATCH");
    expect(r.dimensions).toEqual(expect.arrayContaining(["value", "denominator"]));
    expect(r.dimensions).not.toContain("numerator");
  });

  it("a different definition is INCOMPATIBLE, not an error, and lists each differing attribute", async () => {
    const r = await check(snap({ definition: { ...CAC_DEF, population: "new_customers_first_serviced", numerator: "all_media_spend" }, value: "240.00" }));
    expect(r.verdict).toBe("INCOMPATIBLE_DEFINITION");
    expect(r.dimensions).toEqual(expect.arrayContaining(["definition.population", "definition.numerator"]));
    expect(r.nextStep).toMatch(/^Not an error/);
  });

  it("CAD is incompatible; a missing currency, office-local days or no definition cannot be compared", async () => {
    expect((await check(snap({ currency: "CAD" }))).dimensions).toContain("currency");
    expect((await check(snap({ currency: "CAD" }))).verdict).toBe("INCOMPATIBLE_DEFINITION");
    expect((await check(snap({ currency: null }))).verdict).toBe("NOT_DETERMINABLE");
    expect((await check(snap({ definition: { ...CAC_DEF, periodBasis: "office_local_day" } }))).verdict).toBe("NOT_DETERMINABLE");
    expect((await check(snap({ definition: undefined }))).verdict).toBe("NOT_DETERMINABLE");
    expect((await check(snap({ scope: { branch: "B99" } }))).verdict).toBe("NOT_DETERMINABLE");
  });

  it("INCOMPLETE_EVIDENCE when the product's own feed is stale, even though the values agree", async () => {
    await pool.query("insert into ingestion_runs (source, stream, adapter_version, started_at, finished_at, status, error) values ('ads', 'ads', 'test', $1, $1, 'failed', 'HTTP 503')", [new Date("2026-10-31T08:00:00Z")]);
    const r = await check(snap());
    expect(r.verdict).toBe("INCOMPLETE_EVIDENCE");
    expect(r.dimensions).toContain("evidence.feed_stale");
    expect(r.limitations[0]).toMatch(/both could be missing the same records/);
  });

  it("a refund delivered after the snapshot makes it MISMATCH, with the revision named", async () => {
    const cash = snap({ definition: CASH_DEF, value: "745.00", numerator: undefined, denominator: undefined });
    expect((await check(cash)).verdict).toBe("MATCH");
    await ingest(pool, "crm", [crm.payment(5901, 1001, 4001, "B12", "-49.00", at(25), "1", "5001")], { now: new Date("2026-10-31T10:00:00Z") });
    const r = await check(cash);
    expect(r.verdict).toBe("MISMATCH");
    expect(r.dimensions).toEqual(expect.arrayContaining(["value", "revision"]));
    expect(r.ours?.value).toBe(69_600);
  });

  it("a viewer outside the scope is refused before anything is computed", async () => {
    const outside = partner.branchIds?.[0] === "B12" ? "B13" : "B12";
    await expect(check(snap({ scope: { branch: outside } }), partner)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(check(snap({ scope: { company: true } }), partner)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("conversational answers, claim by claim", () => {
  const answer = (text: string, viewer = marketing) => assureAnswer(pool, viewer, { system: "atlas-bi", asOf: ASOF, question: "", answer: text }, NOW);

  it("keeps a correct claim, contradicts a wrong one, and never certifies a cause", async () => {
    const r = await answer("B12's paid CAC was $240.00 in October. B12 collected $900.00 in October. That is because Google Search spend doubled.");
    const by = (q: string) => r.claims.find((c) => c.text.includes(q))?.verdict;
    expect(by("paid CAC was $240.00")).toBe("SUPPORTED");
    expect(by("collected $900.00")).toBe("CONTRADICTED");
    expect(by("because")).toBe("UNSUPPORTED");
    expect(r.overall).toBe("PARTLY_SUPPORTED");
  });

  it("invoiced amounts are not collected cash", async () => {
    const r = await answer("B12 invoiced $745.00 in October.");
    expect(r.claims[0]?.verdict).not.toBe("SUPPORTED");
  });

  it("a branch outside the viewer's scope is OUT_OF_SCOPE and is not read", async () => {
    const outside = partner.branchIds?.[0] === "B12" ? "B13" : "B12";
    const r = await answer(`${outside}'s paid CAC was $240.00 in October.`, partner);
    expect(r.claims.map((c) => c.verdict)).toEqual(["OUT_OF_SCOPE"]);
    expect(r.entities.branches).toEqual([]);
    expect(r.facts).toBe(0);
  });
});

describe("storage", () => {
  it("records each check append-only with an audit row, listed only to viewers who may see its scope", async () => {
    const first = await runShadowCheck(pool, marketing, { kind: "snapshot", input: snap() }, NOW);
    const again = await runShadowCheck(pool, marketing, { kind: "snapshot", input: snap() }, NOW);
    expect(again.id).not.toBe(first.id);
    expect(again.inputHash).toBe(first.inputHash);
    expect((await one(pool, "select count(*)::int as n from audit_log where action = 'shadow_check'"))).toEqual({ n: 2 });
    expect((await listShadowChecks(pool, marketing)).map((c) => c.id)).toEqual([again.id, first.id]);
    if (!partner.branchIds?.includes("B12")) expect(await listShadowChecks(pool, partner)).toEqual([]);
    await expect(runShadowCheck(pool, VIEWERS.guest, { kind: "snapshot", input: snap() }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });
});
