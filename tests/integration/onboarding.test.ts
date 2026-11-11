import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { MappingSpec } from "@/lib/onboarding/compile";
import {
  decideMapping,
  getUpload,
  proposeMapping,
  publishUpload,
  purgeExpired,
  rowResults,
  runDryRun,
  stageUpload,
  type UploadDetail,
} from "@/lib/onboarding/service";
import { VIEWERS } from "@/lib/viewer";
import { T0, call, crm, freshDb, ingest, one, testPool } from "../helpers";

/**
 * The onboarding workflow end to end, on HELD-OUT exports written by an independent labeler
 * (tests/fixtures/onboarding/holdout/EXPECTED.md) that the implementation was not tuned on.
 * Real code path: parse -> profile -> assistant -> mapping version -> compile with the deployed
 * mapper -> ledger comparison -> approval -> publication through intake.
 *
 * One deliberate divergence from EXPECTED.md is asserted, not hidden: CRM customer "00417" is
 * refused as PADDED_ID (the CRM's ids are canonical integers; stripping zeros is a guess),
 * where the labeler accepted it as text.
 */
const pool: Pool = testPool();
beforeEach(async () => freshDb(pool));
afterAll(async () => pool.end());

const NOW = new Date("2026-11-10T15:00:00Z");
/** The dry run an approver would be looking at: the latest for the upload. */
const latestDry = async (uploadId: number): Promise<number> =>
  Number((await pool.query<{ id: string }>("select coalesce(max(id), 0) as id from onboarding_dry_runs where upload_id = $1", [uploadId])).rows[0].id);
const holdout = (name: string) => readFileSync(path.join(__dirname, "..", "fixtures", "onboarding", "holdout", name));
const { marketing, engineer, approver, partner, brand, guest } = VIEWERS;

async function stage(name: string, viewer = marketing, now = NOW) {
  const r = await stageUpload(pool, { viewer, filename: name, bytes: holdout(name), now });
  if ("refused" in r) throw new Error(`refused: ${r.refused.message}`);
  return r.upload.id;
}

/** A spec from the assistant's confirmed suggestions plus the answers a person gives in review. */
function specFrom(detail: UploadDetail, answers: Partial<MappingSpec>): MappingSpec {
  const dataset = answers.dataset ?? detail.assistant.dataset.chosen!;
  const columns = Object.fromEntries(detail.assistant.fields.map((f) => [f.field, f.status === "suggested" ? f.column : null]));
  const valueMaps: MappingSpec["valueMaps"] = {};
  for (const [field, values] of Object.entries(detail.values)) {
    valueMaps[field] = Object.fromEntries(values.filter((v) => v.proposed !== null).map((v) => [v.value, v.proposed!]));
  }
  return {
    dataset,
    columns: { ...columns, ...answers.columns },
    constants: answers.constants ?? {},
    valueMaps: { ...valueMaps, ...answers.valueMaps },
    dateOrder: answers.dateOrder ?? null,
    localTime: answers.localTime ?? null,
    moneyMeaning: answers.moneyMeaning ?? {},
    exportedAt: answers.exportedAt ?? null,
  };
}

describe("onboarding · call export (publishable)", () => {
  it("profiles, asks, quarantines, publishes once, and a re-import changes nothing", async () => {
    const id = await stage("callrail-style-export.csv");
    const detail = await getUpload(pool, marketing, id, NOW);
    const field = (k: string) => detail.assistant.fields.find((f) => f.field === k)!;

    expect(detail.assistant.dataset.chosen).toBe("calls");
    expect(field("caller_phone")).toMatchObject({ status: "suggested", column: "Customer Phone Number" });
    expect(field("tracking_number")).toMatchObject({ status: "suggested", column: "Tracking Phone Number" });
    expect(field("call_id")).toMatchObject({ status: "suggested", column: "Call Id" });
    // Profiles never carry personal values: the phone column shows shapes and counts only.
    const phoneProfile = detail.profile.columns.find((c) => c.name === "Customer Phone Number")!;
    expect(phoneProfile.personal).toBe("phone");
    expect(phoneProfile.topValues).toBeNull();
    expect(JSON.stringify(detail.profile)).not.toContain("555-0101");

    // Without the date order and time zone the rules are incomplete, and the dry run refuses.
    const incomplete = specFrom(detail, {});
    const draft = await proposeMapping(pool, { viewer: marketing, uploadId: id, spec: incomplete, now: NOW });
    expect(draft.problems.map((p) => p.code).sort()).toEqual(["DATE_ORDER_REQUIRED", "TIME_ZONE_REQUIRED"]);
    await expect(runDryRun(pool, { viewer: marketing, uploadId: id, mappingId: draft.mappingId, now: NOW })).rejects.toThrow(/incomplete/);

    const spec = specFrom(detail, { dateOrder: "MDY", localTime: "branch_local" });
    expect(spec.valueMaps.branch).toMatchObject({ Alder: "B01", Clover: "B07", Granite: "B17" });
    expect(spec.valueMaps.branch).not.toHaveProperty("Northgate");
    expect(spec.valueMaps.call_source).not.toHaveProperty("Yelp");
    const proposed = await proposeMapping(pool, { viewer: marketing, uploadId: id, spec, now: NOW });
    expect(proposed.problems).toEqual([]);

    const dry = await runDryRun(pool, { viewer: marketing, uploadId: id, mappingId: proposed.mappingId, now: NOW });
    expect(dry.total).toBe(12);
    expect(dry.accounted).toBe(true);
    expect(dry.counts).toMatchObject({ eligible: 6, invalid: 5, duplicate_in_file: 1, quarantined: 0 });
    const codes = Object.fromEntries(dry.issues.map((i) => [`${i.code}:${i.field}`, i.rows]));
    expect(codes).toMatchObject({ "MISSING_VALUE:caller_phone": 3, "UNKNOWN_BRANCH:branch": 1, "UNMAPPED_VALUE:call_source": 1, "DUPLICATE_IN_FILE:*": 1 });
    // A dry run writes nothing to the ledger.
    expect(await one(pool, "select count(*)::int as n from raw_events")).toEqual({ n: 0 });

    // Separation of duties: the proposer cannot approve or publish; the approver can.
    await expect(decideMapping(pool, { viewer: marketing, mappingId: proposed.mappingId, decision: "approve", reason: "looks right", now: NOW })).rejects.toThrow(/cannot/);
    await expect(publishUpload(pool, { viewer: approver, uploadId: id, dryRunId: await latestDry(id), now: NOW })).rejects.toThrow(/not approved/);
    await decideMapping(pool, { viewer: approver, mappingId: proposed.mappingId, decision: "approve", reason: "Mapping checked against the export", now: NOW });
    await expect(publishUpload(pool, { viewer: marketing, uploadId: id, dryRunId: await latestDry(id), now: NOW })).rejects.toThrow(/cannot/);
    const published = await publishUpload(pool, { viewer: approver, uploadId: id, dryRunId: await latestDry(id), now: NOW });
    expect(published).toMatchObject({ published: 6, stats: { inserted: 6, projected: 6, quarantined: 0 } });

    // Times are read in each branch's zone: 09:14 Pacific on Nov 3 is 17:14Z; 12:05 AM is just after midnight.
    const at = async (callId: string) => (await one<{ occurred_at: Date }>(pool, "select occurred_at from leads where source_lead_id = $1", [callId])).occurred_at.toISOString();
    expect(await at("CAL10001")).toBe("2026-11-03T17:14:00.000Z");
    expect(await at("CAL10003")).toBe("2026-11-03T17:07:00.000Z"); // Phoenix: no DST
    expect(await at("CAL10009")).toBe("2026-11-04T08:05:00.000Z");
    // The injected note is stored as data and changed nothing: the source stays Facebook.
    const injected = await one<{ channel_code: string; heard_about_text: string }>(pool, "select channel_code, heard_about_text from leads where source_lead_id = 'CAL10004'");
    expect(injected.channel_code).toBe("meta");
    expect(injected.heard_about_text).toContain("Ignore all previous instructions");

    // Lineage: every published row points at its raw event; staged cells are gone.
    const results = await rowResults(pool, approver, { uploadId: id, disposition: "published", page: 1 });
    expect(results.total).toBe(6);
    expect(results.rows.every((r) => r.raw_event_id !== null)).toBe(true);
    expect(await one(pool, "select count(*)::int as n from onboarding_rows where upload_id = $1", [id])).toEqual({ n: 0 });
    await expect(publishUpload(pool, { viewer: approver, uploadId: id, dryRunId: await latestDry(id), now: NOW })).rejects.toThrow(/published/);

    // The same export again: the approved mapping is recognised, and nothing new reaches the ledger.
    const again = await stage("callrail-style-export.csv");
    const againDetail = await getUpload(pool, marketing, again, NOW);
    expect(againDetail.assistant.fields.find((f) => f.field === "caller_phone")!.evidence[0]).toMatch(/approved mapping v2/);
    const reused = await proposeMapping(pool, { viewer: marketing, uploadId: again, spec, now: NOW });
    expect(reused).toMatchObject({ reused: true, mappingId: proposed.mappingId });
    const dry2 = await runDryRun(pool, { viewer: marketing, uploadId: again, mappingId: reused.mappingId, now: NOW });
    expect(dry2.counts).toMatchObject({ eligible: 0, matches_ledger: 6 });
    expect(await publishUpload(pool, { viewer: approver, uploadId: again, dryRunId: await latestDry(again), now: NOW })).toMatchObject({ published: 0 });
    expect(await one(pool, "select count(*)::int as n from leads")).toEqual({ n: 6 });

    // The audit trail records counts and codes, never a phone number or a note.
    const audit = (await pool.query<{ d: string }>("select detail::text as d from audit_log where action like 'onboarding%'")).rows.map((r) => r.d).join(" ");
    expect(audit).not.toMatch(/555-01|Ignore all/);
  });

  it("a row the ledger gained after the dry run is skipped at publication, not overwritten", async () => {
    const id = await stage("callrail-style-export.csv");
    const detail = await getUpload(pool, marketing, id, NOW);
    const spec = specFrom(detail, { dateOrder: "MDY", localTime: "branch_local" });
    const m = await proposeMapping(pool, { viewer: marketing, uploadId: id, spec, now: NOW });
    await runDryRun(pool, { viewer: marketing, uploadId: id, mappingId: m.mappingId, now: NOW });
    await decideMapping(pool, { viewer: approver, mappingId: m.mappingId, decision: "approve", reason: "Checked against the export", now: NOW });
    // The live webhook delivers CAL10001 between the dry run and publication.
    await ingest(pool, "calls", [call("CAL10001", "B01", "+12065550101", T0)]);
    const result = await publishUpload(pool, { viewer: approver, uploadId: id, dryRunId: await latestDry(id), now: NOW });
    expect(result).toMatchObject({ published: 5, skipped: { changedSinceDryRun: 1 } });
    const lead = await one<{ occurred_at: Date }>(pool, "select occurred_at from leads where source_lead_id = 'CAL10001'");
    expect(lead.occurred_at.toISOString()).toBe(T0.toISOString()); // the live record, untouched
  });
});

describe("onboarding · payments export (reconcile only)", () => {
  it("never maps Total or Contract Value to cash, explains every cent of difference, and refuses to publish", async () => {
    // Ledger: 880002 agrees; 880010 recorded $80.00 (file says $75.00); 880099 is in the ledger only.
    await ingest(pool, "crm", [
      crm.payment(880002, 10522, 7700102, "B05", "89.00", new Date("2026-11-02T18:00:00Z")),
      crm.payment(880010, 10601, 7700112, "B01", "80.00", new Date("2026-11-06T19:00:00Z")),
      crm.payment(880099, 10602, 7700113, "B01", "40.00", new Date("2026-11-04T19:00:00Z")),
      // 8 PM Central on 6 November, the file's last day: inside the ledger-only window (data review #5).
      crm.payment(880097, 10603, 7700114, "B01", "25.00", new Date("2026-11-07T02:00:00Z")),
    ]);
    const id = await stage("fieldroutes-payments.csv");
    const detail = await getUpload(pool, marketing, id, NOW);
    const field = (k: string) => detail.assistant.fields.find((f) => f.field === k)!;
    expect(detail.assistant.dataset.chosen).toBe("crm_payments");
    expect(field("amount")).toMatchObject({ status: "suggested", column: "Net Paid" });
    expect(field("amount").alternatives.map((a) => a.column)).not.toContain(undefined);
    const blocked = field("amount").alternatives.filter((a) => a.column === "Contract Value" || a.column === "Total");
    expect(blocked.find((a) => a.column === "Contract Value")?.reason).toMatch(/contracted annual plan value/i);

    // Stating the wrong meaning is refused by the rules, not just by the assistant.
    const wrong = specFrom(detail, { dateOrder: "MDY", localTime: "branch_local", columns: { amount: "Contract Value" }, moneyMeaning: { amount: "contract_annual_value" } });
    expect((await proposeMapping(pool, { viewer: marketing, uploadId: id, spec: wrong, now: NOW })).problems.map((p) => p.code)).toContain("WRONG_MONEY_MEANING");

    const spec = specFrom(detail, { dateOrder: "MDY", localTime: "branch_local", moneyMeaning: { amount: "collected_payment" } });
    const m = await proposeMapping(pool, { viewer: marketing, uploadId: id, spec, now: NOW });
    expect(m.problems).toEqual([]);
    const dry = await runDryRun(pool, { viewer: marketing, uploadId: id, mappingId: m.mappingId, now: NOW });
    expect(dry.accounted).toBe(true);
    expect(dry.counts).toMatchObject({ eligible: 3, matches_ledger: 1, differs_from_ledger: 1, invalid: 5 });
    const codes = dry.issues.map((i) => i.code);
    expect(codes).toEqual(expect.arrayContaining(["PADDED_ID", "MANGLED_ID", "IMPOSSIBLE_DATE", "UNKNOWN_BRANCH"]));
    expect(dry.ledger.differences).toEqual([{ row: 11, diffs: [{ fact: "collected cash", file: "$75.00", ledger: "$80.00" }, { fact: "amount", file: "$75.00", ledger: "$80.00" }] }]);

    // Every cent is explained: file total = matched (file side) + not in ledger; the matched
    // difference is exactly the listed row difference; ledger-only payments are counted apart.
    const money = dry.ledger.money!;
    expect(money).toMatchObject({ fileTotalCents: 8_900 - 5_000 + 7_500, matchedFileCents: 16_400, matchedLedgerCents: 16_900, matchedDifferenceCents: -500, notInLedgerCents: -5_000 });
    expect(money.fileTotalCents).toBe(money.matchedFileCents + money.notInLedgerCents);
    expect(money.ledgerOnly).toMatchObject({ rows: 2, cents: 6_500 });
    // The per-row cash differences add up to the matched difference exactly (data review #6).
    const cents = (d: string) => Math.round(Number(d.replace(/[$,]/g, "")) * 100);
    const rowCash = dry.ledger.differences.flatMap((d) => d.diffs.filter((x) => x.fact === "collected cash")).reduce((sum, x) => sum + cents(x.file) - cents(x.ledger), 0);
    expect(rowCash).toBe(money.matchedDifferenceCents);

    await decideMapping(pool, { viewer: approver, mappingId: m.mappingId, decision: "approve", reason: "Checked against the export", now: NOW });
    await expect(publishUpload(pool, { viewer: approver, uploadId: id, dryRunId: await latestDry(id), now: NOW })).rejects.toThrow(/reconcile-only/);
    expect(await one(pool, "select amount_cents::int as c from crm_payments where crm_payment_id = 880010")).toEqual({ c: 8_000 });
  });
});

describe("onboarding · ad report with a title, totals and fractional conversions", () => {
  it("skips the preamble, excludes total rows, refuses fractional counts, and asks for the account", async () => {
    const id = await stage("google-ads-daily.csv");
    const detail = await getUpload(pool, marketing, id, NOW);
    expect(detail.table.warnings.map((w) => w.code)).toContain("PREAMBLE_SKIPPED");
    expect(detail.assistant.dataset.chosen).toBe("ad_spend");
    const spec0 = specFrom(detail, { exportedAt: "2026-11-04T12:00:00Z" });
    const p0 = await proposeMapping(pool, { viewer: marketing, uploadId: id, spec: spec0, now: NOW });
    expect(p0.problems.map((p) => p.field)).toEqual(expect.arrayContaining(["platform", "account_id", "cost"]));

    const spec = specFrom(detail, { exportedAt: "2026-11-04T12:00:00Z", constants: { platform: "google_ads", account_id: "000-111-2013" }, moneyMeaning: { cost: "ad_cost" } });
    const m = await proposeMapping(pool, { viewer: marketing, uploadId: id, spec, now: NOW });
    expect(m.problems).toEqual([]);
    const dry = await runDryRun(pool, { viewer: marketing, uploadId: id, mappingId: m.mappingId, now: NOW });
    expect(dry.counts).toMatchObject({ eligible: 6, invalid: 3 });
    expect(Object.fromEntries(dry.issues.map((i) => [i.code, i.rows]))).toMatchObject({ SUMMARY_ROW: 2, FRACTIONAL_COUNT: 1 });
    expect(dry.ledger.money!.fileTotalCents).toBe(18_740 + 6_412 + 0 + 123_456 + 17_105 + 6_680);
  });
});

describe("onboarding · access, refusal and retention", () => {
  it("branch-scoped, read-only and approve-only roles cannot stage; scoped roles cannot read", async () => {
    for (const viewer of [partner, brand, guest, approver]) {
      await expect(stageUpload(pool, { viewer, filename: "a.csv", bytes: Buffer.from("a,b\n1,2\n"), now: NOW })).rejects.toThrow(/cannot/);
    }
    const id = await stage("callrail-style-export.csv", engineer);
    for (const viewer of [partner, brand, guest]) await expect(getUpload(pool, viewer, id, NOW)).rejects.toThrow(/cannot/);
    await expect(getUpload(pool, approver, id, NOW)).resolves.toBeDefined();
  });

  it("the schema itself refuses a mapping decided by the role that proposed it", async () => {
    const id = await stage("callrail-style-export.csv");
    const detail = await getUpload(pool, marketing, id, NOW);
    const m = await proposeMapping(pool, { viewer: marketing, uploadId: id, spec: specFrom(detail, { dateOrder: "MDY", localTime: "branch_local" }), now: NOW });
    await expect(
      pool.query("update onboarding_mappings set status = 'approved', decided_by = 'x', decided_role = 'marketing', decided_at = now() where id = $1", [m.mappingId]),
    ).rejects.toThrow(/check constraint/);
  });

  it("refusals are recorded and nothing is staged", async () => {
    const r = await stageUpload(pool, { viewer: marketing, filename: "../../etc/report.xlsm", bytes: Buffer.from("PK\u0003\u0004"), now: NOW });
    expect(r).toEqual({ refused: { code: "UNSUPPORTED_FORMAT", message: expect.stringMatching(/Macro-enabled/) } });
    expect(await one(pool, "select count(*)::int as n from onboarding_uploads")).toEqual({ n: 0 });
    expect(await one(pool, "select count(*)::int as n from audit_log where action = 'onboarding_upload_refused'")).toEqual({ n: 1 });
  });

  it("staged rows are deleted after retention, and the accountable summary stays", async () => {
    const id = await stage("callrail-style-export.csv");
    expect(await purgeExpired(pool, new Date(NOW.getTime() + 23 * 3_600_000))).toBe(0);
    expect(await purgeExpired(pool, new Date(NOW.getTime() + 25 * 3_600_000))).toBe(1);
    expect(await one(pool, "select count(*)::int as n from onboarding_rows")).toEqual({ n: 0 });
    const later = new Date(NOW.getTime() + 26 * 3_600_000);
    const detail = await getUpload(pool, marketing, id, later);
    expect(detail.upload).toMatchObject({ status: "expired", rowsPurged: true, rowCount: 12 });
    await expect(proposeMapping(pool, { viewer: marketing, uploadId: id, spec: specFrom(detail, { dataset: "calls" }), now: later })).rejects.toThrow(/deleted/);
  });

  it("retention holds on every path, and the cell text quoted in results goes with the cells (security review #4)", async () => {
    const id = await stage("callrail-style-export.csv");
    const detail = await getUpload(pool, marketing, id, NOW);
    const m = await proposeMapping(pool, { viewer: marketing, uploadId: id, spec: specFrom(detail, { dateOrder: "MDY", localTime: "branch_local" }), now: NOW });
    await runDryRun(pool, { viewer: marketing, uploadId: id, mappingId: m.mappingId, now: NOW });
    expect(await one(pool, "select count(*)::int as n from onboarding_row_results where detail like '%Northgate%'")).toEqual({ n: 1 });
    // 25 hours later, with nobody opening a page: a dry run itself enforces retention.
    const later = new Date(NOW.getTime() + 25 * 3_600_000);
    await expect(runDryRun(pool, { viewer: marketing, uploadId: id, mappingId: m.mappingId, now: later })).rejects.toThrow(/deleted/);
    expect(await one(pool, "select count(*)::int as n from onboarding_row_results where detail is not null")).toEqual({ n: 0 });
    const summary = await one<{ s: string }>(pool, "select summary::text as s from onboarding_dry_runs where upload_id = $1", [id]);
    expect(summary.s).not.toContain("Northgate");
  });

  it("publication is bound to the dry run the approver reviewed (security review #5)", async () => {
    const id = await stage("callrail-style-export.csv");
    const detail = await getUpload(pool, marketing, id, NOW);
    const m = await proposeMapping(pool, { viewer: marketing, uploadId: id, spec: specFrom(detail, { dateOrder: "MDY", localTime: "branch_local" }), now: NOW });
    await runDryRun(pool, { viewer: marketing, uploadId: id, mappingId: m.mappingId, now: NOW });
    const reviewed = await latestDry(id);
    await decideMapping(pool, { viewer: approver, mappingId: m.mappingId, decision: "approve", reason: "Checked against the export", now: NOW });
    await runDryRun(pool, { viewer: engineer, uploadId: id, mappingId: m.mappingId, now: NOW }); // a newer dry run appears
    await expect(publishUpload(pool, { viewer: approver, uploadId: id, dryRunId: reviewed, now: NOW })).rejects.toThrow(/newer dry run/);
    expect(await one(pool, "select count(*)::int as n from leads")).toEqual({ n: 0 });
  });
});
