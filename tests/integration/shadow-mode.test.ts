import { readFileSync } from "node:fs";
import path from "node:path";
import type { Pool } from "pg";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapCampaignToBranch } from "@/lib/actions";
import { assureAnswer, type AnswerCheck } from "@/lib/shadow/answer";
import { compareSnapshot, type Snapshot } from "@/lib/shadow/snapshot";
import { getShadowCheck, listShadowChecks, runShadowCheck } from "@/lib/shadow/store";
import { ForbiddenError, VIEWERS, type Viewer } from "@/lib/viewer";
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

  it("an unreadable ad record dated in the window makes agreeing spend INCOMPLETE, though intake stored it with its receipt time", async () => {
    // Shadow pack first contact, SH-07 (critical): no campaign id, so intake cannot identify it and
    // stores the time it arrived (Oct 31); its own date is Oct 12.
    const unreadable: RawRecord = { entity: "spend_day", payload: { platform: "google_ads", accountId: "ACC-SH", campaignName: "sh-gs search", date: "2026-10-12", costMicros: String(40 * 1_000_000), clicks: 2, conversions: 1, fetchedAt: "2026-10-12T23:00:00Z", campaignType: "SEARCH", currencyCode: "USD" } };
    await ingest(pool, "ads", [unreadable], { now: NOW });
    const spend = snap({ definition: { id: "atlas.paid_spend", version: "1", family: "spend", numerator: "paid_media_spend_mapped_to_branch", periodBasis: "utc_day", branchBasis: "campaign_mapping" }, value: "1200.00", numerator: undefined, denominator: undefined });
    const r = await check(spend);
    expect(r.verdict).toBe("INCOMPLETE_EVIDENCE");
    expect(r.dimensions).toContain("evidence.unreadable");
    // A September window does not include it.
    expect((await check({ ...spend, period: { from: "2026-09-01", to: "2026-09-30" }, value: "0.00" })).verdict).toBe("MATCH");
  });

  it("office-local days are named as the definition's day basis", async () => {
    const r = await check(snap({ definition: { ...CAC_DEF, periodBasis: "office_local_day" } }));
    expect(r.dimensions).toContain("definition.periodBasis");
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

  it("a month the evidence does not hold is not checked against October", async () => {
    // Shadow pack first contact, SH-11: after a sentence about October, "August 2026" was read
    // as October (the period carries from piece to piece) and judged against October's figure.
    for (const second of ["B12's paid CAC in August 2026 was $300.00.", "B12's paid CAC in August 2026 was $240.00.", "B12's paid CAC in October 2025 was $240.00."]) {
      const r = await answer(`B12 collected $745.00 in October. ${second}`);
      expect(r.claims.find((c) => c.text.includes("paid CAC"))?.verdict, second).toBe("UNSUPPORTED");
    }
    // A figure that merely looks like a year is still a figure.
    expect((await answer("B12 collected $745.00 in October.")).claims[0]?.verdict).toBe("SUPPORTED");
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

  it("an answer that read a brand is listed only to viewers who may see the whole brand (BIVE-ACCEPTANCE.md, F-1)", async () => {
    const ask = (text: string) => runShadowCheck(pool, marketing, { kind: "answer", input: { system: "atlas-bi", asOf: ASOF, question: "", answer: text } }, NOW);
    // A company-wide analyst checks a brand-level answer: the check reads Moxie's brand metrics.
    const brand = await ask("Moxie Pest Control paid CAC was $250.00 in October.");
    expect((brand.result as { entities: { brands: string[] } }).entities.brands).toEqual(["moxie"]);
    // The B20 partner sees one Moxie branch and the brand lead none: neither may read it. Before the
    // fix the check was stored with no branches, and an empty scope is inside every scope.
    for (const viewer of [partner, VIEWERS.brand]) {
      expect((await listShadowChecks(pool, viewer)).map((c) => c.id)).not.toContain(brand.id);
      expect(await getShadowCheck(pool, viewer, brand.id)).toBeNull();
    }
    expect(await getShadowCheck(pool, marketing, brand.id)).not.toBeNull();
    // Control: an answer about the partner's own branch stays the partner's to read.
    const own = await ask(`${partner.branchIds![0]}'s paid CAC was $250.00 in October.`);
    expect((await getShadowCheck(pool, partner, own.id))?.id).toBe(own.id);
    expect(await getShadowCheck(pool, VIEWERS.brand, own.id)).toBeNull();
    // A check recorded before the fix stored no branches, and nothing of what it names (as before
    // migration 0033). Migration 0032 repairs what it read, and applying it again changes nothing.
    // Since 0033 such a row is listed only to company-wide viewers and the viewer who ran it, so the
    // leak this test first reproduced here no longer appears, even before the repair.
    const moxie = (await pool.query<{ id: string }>("select id from branches where brand_id = 'moxie' order by id")).rows.map((r) => r.id);
    await pool.query("update shadow_checks set branch_ids = '{}', named_branch_ids = null where id = $1", [brand.id]);
    expect(await getShadowCheck(pool, partner, brand.id)).toBeNull();
    const migration = readFileSync(path.join(process.cwd(), "database", "migrations", "0032_answer_check_brand_scope.sql"), "utf8");
    await pool.query(migration);
    await pool.query(migration);
    expect((await one<{ b: string[] }>(pool, "select branch_ids as b from shadow_checks where id = $1", [brand.id])).b).toEqual(moxie);
    expect(await getShadowCheck(pool, partner, brand.id)).toBeNull();
    expect((await one<{ b: string[] }>(pool, "select branch_ids as b from shadow_checks where id = $1", [own.id])).b).toEqual([partner.branchIds![0]]);
  });

  // A check shows its stored text to whoever may read it: the question, the answer, the system's
  // name. So it is listed by everything it names, not only by what it read (BIVE-ACCEPTANCE.md R11).
  const answerBy = (viewer: Viewer, answer: string, extra: { question?: string; system?: string } = {}) =>
    runShadowCheck(pool, viewer, { kind: "answer", input: { system: extra.system ?? "atlas-bi", asOf: ASOF, question: extra.question ?? "", answer } }, NOW);
  const listedTo = async (viewer: Viewer) => (await listShadowChecks(pool, viewer)).map((c) => c.id);
  const spent = (branches: string[]) => branches.map((b) => `${b} spent $100.00 in October.`).join(" ");

  it("an answer that read nothing is listed only to company-wide viewers and to the viewer who ran it (BIVE-ACCEPTANCE.md R11)", async () => {
    const lead = VIEWERS.brand;
    // The B20 partner checks an answer about B09 and the whole Moxie brand. Both are outside its
    // scope: the claims are OUT_OF_SCOPE and nothing is read, but the stored text names them.
    const outside = await answerBy(partner, "B09's paid CAC was $240.00 in October. Moxie Pest Control spent $5,000.00 in October.");
    expect((outside.result as AnswerCheck).entities).toMatchObject({ branches: [], brands: [] });
    // The Joshua's brand lead checks an answer that names no branch or brand at all.
    const nameless = await answerBy(lead, "Paid spend rose 10% in October.");
    expect((nameless.result as AnswerCheck).entities).toMatchObject({ branches: [], brands: [] });
    // Both used to be stored with no branches, and an empty scope is inside every scope.
    expect(await listedTo(lead)).not.toContain(outside.id);
    expect(await getShadowCheck(pool, lead, outside.id)).toBeNull();
    expect(await listedTo(partner)).not.toContain(nameless.id);
    expect(await getShadowCheck(pool, partner, nameless.id)).toBeNull();
    // Whoever ran a check reads it again (the form opens it straight away); company-wide viewers read both.
    expect(await listedTo(partner)).toContain(outside.id);
    expect((await getShadowCheck(pool, partner, outside.id))?.id).toBe(outside.id);
    expect((await getShadowCheck(pool, lead, nameless.id))?.id).toBe(nameless.id);
    expect(await listedTo(marketing)).toEqual(expect.arrayContaining([outside.id, nameless.id]));
  });

  it("a branch a check names but did not read keeps it from viewers who may not see that branch (BIVE-ACCEPTANCE.md R11)", async () => {
    const lead = VIEWERS.brand;
    const own = lead.branchIds!;
    // Five branches named; at most four are read, so B09, named last, is not.
    const five = await answerBy(marketing, `${spent(own.slice(0, 4))} B09 spent $100.00 in October.`);
    expect((five.result as AnswerCheck).entities.branches).toEqual(own.slice(0, 4));
    // B09 named only in the question; the Moxie brand named only in the system's name.
    const question = await answerBy(marketing, spent([own[0]]), { question: "Why did B09's spend fall?" });
    const system = await answerBy(marketing, spent([own[0]]), { system: "Moxie Pest Control BI" });
    for (const c of [five, question, system]) {
      expect(await listedTo(lead)).not.toContain(c.id);
      expect(await getShadowCheck(pool, lead, c.id)).toBeNull();
    }
    // Control: the same branches without B09 stay the brand lead's to read.
    const four = await answerBy(marketing, spent(own.slice(0, 4)));
    expect((await getShadowCheck(pool, lead, four.id))?.id).toBe(four.id);
  });

  it("a snapshot of a brand the product does not know is listed only to company-wide viewers (BIVE-ACCEPTANCE.md R11)", async () => {
    const unknown = await runShadowCheck(pool, marketing, { kind: "snapshot", input: snap({ scope: { brand: "acme" } }) }, NOW);
    expect(unknown.verdict).toBe("NOT_DETERMINABLE");
    for (const viewer of [partner, VIEWERS.brand]) {
      expect(await listedTo(viewer)).not.toContain(unknown.id);
      expect(await getShadowCheck(pool, viewer, unknown.id)).toBeNull();
    }
    expect((await getShadowCheck(pool, marketing, unknown.id))?.id).toBe(unknown.id);
  });

  it("a check stored before migration 0033 did not record what it names: only company-wide viewers and the viewer who ran it read it", async () => {
    const lead = VIEWERS.brand;
    const own = lead.branchIds!;
    const theirs = await answerBy(marketing, `${spent(own.slice(0, 4))} B09 spent $100.00 in October.`);
    const mine = await answerBy(lead, spent([own[0]]));
    // What each new check names, read or not, is stored with it.
    const named = async (id: number) => (await one<{ n: string[] | null }>(pool, "select named_branch_ids as n from shadow_checks where id = $1", [id])).n;
    expect(await named(theirs.id)).toEqual(["B09", ...own.slice(0, 4)]);
    expect(await named(mine.id)).toEqual([own[0]]);
    // Applying the migration again changes nothing.
    const migration = readFileSync(path.join(process.cwd(), "database", "migrations", "0033_shadow_check_named_scope.sql"), "utf8");
    await pool.query(migration);
    expect(await named(theirs.id)).toEqual(["B09", ...own.slice(0, 4)]);
    // As stored before 0033: nothing recorded of what they name.
    await pool.query("update shadow_checks set named_branch_ids = null where id = any($1::bigint[])", [[theirs.id, mine.id]]);
    expect(await getShadowCheck(pool, lead, theirs.id)).toBeNull(); // it read only the lead's branches, but its text names B09
    expect((await getShadowCheck(pool, lead, mine.id))?.id).toBe(mine.id); // the lead ran it
    expect(await getShadowCheck(pool, partner, mine.id)).toBeNull();
    expect(await listedTo(marketing)).toEqual(expect.arrayContaining([theirs.id, mine.id]));
  });
});
