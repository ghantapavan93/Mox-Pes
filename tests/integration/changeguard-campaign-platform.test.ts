import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapperFor, referenceContext } from "@/lib/adapters/registry";
import { getMonitorRun } from "@/lib/changeguard/monitor";
import { baseHashOf, evidenceVerdict, unresolvedVerdicts, type CampaignBase } from "@/lib/changeguard/preflight";
import { createChange, decideChange, getChange, releaseChange, type ChangeRow } from "@/lib/changeguard/service";
import { runStream } from "@/lib/ingest/ingest";
import { defaultRuntime } from "@/lib/jobs/runtime";
import { workerTick } from "@/lib/jobs/tick";
import { branchRows } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { InMemorySourceClient } from "@/lib/sim/clients";
import { ForbiddenError, VIEWERS } from "@/lib/viewer";
import { acquisition, call, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * R-46 in ChangeGuard: a campaign's leads are the leads whose own record names the campaign's
 * platform (v_lead_campaigns, the resolver the reporting already uses), never every lead that
 * carries the id. An unresolved lead (no platform named, two named, or a platform with no
 * campaign of this id) is neither support, nor contradiction, nor drift; where counting it or
 * not would change the answer, the check stays uncertified and says why. The shared-id guard
 * (another campaign uses the id → the monitor certifies nothing) is unchanged.
 *
 * WORLD A: Google and Meta share campaign id 777 and point to different branches.
 *   G777  google_ads, "G777 search", $40/day × 10, unmapped    leads: 6 "Google Ads" calls at B12
 *   M777  meta, "M777 leads", $30/day × 10, unmapped           leads: 8 "Facebook" calls at B20
 *   unresolved, both at B12: a "Direct" call (no platform) and a web form with a gclid AND
 *   utm_source facebook / paid_social (two platforms). One customer each: c1 (G777, B12) and c2
 *   (M777, B20), $149.00 collected from each.
 *
 * WORLD B: Google alone uses id 888.  G888  google_ads, $50/day × 10, 5 "Google Ads" calls at B13.
 *
 * EXPECTED, written by hand from the worlds above on 2026-11-13, before the change:
 *
 *   Preflight  G777 → B20 (wrong)  matched: 6 at B12; 0 at B20 → DISAGREES (fail). The 2
 *                                   unresolved leads are at B12 too: they cannot change it.
 *              G777 → B12          matched: 6 at B12 → AGREES (pass), the 2 unresolved noted.
 *              M777 → B20          matched: 8 at B20 → agrees; with the 2 unresolved at B12 it
 *                                   would be split → UNCERTIFIED (warn, LEAD_EVIDENCE_UNRESOLVED).
 *   Release    G777: evidence 6 at B12, sources [calls], unresolved 2 at B12.
 *              M777: evidence 8 at B20, sources [calls], unresolved 2 at B12.
 *   Monitor    after a "Facebook" call with 777 lands at B05: both changes INSUFFICIENT EVIDENCE
 *              (CAMPAIGN_ID_AMBIGUOUS: the guard). G777's evidence shows 6 at B12 and no
 *              contradicting lead; M777's shows its own lead at B05. No review item; nothing
 *              certified; no mapping moved.
 *   Viewer     the B20 partner reads M777's check: B20 rows only; the Google campaign that shares
 *              the id is named by platform only; B12, B05 and "G777 search" never appear. G777's
 *              change is refused to them.
 *   World B    a "Direct" call with 888 at B05: INSUFFICIENT EVIDENCE (LEADS_UNRESOLVED), not
 *              drift. Then a "Google Ads" call with 888 at B05: DRIFT, one review item.
 *   Money      releases move exactly each campaign's spend; company spend, customers and cash
 *              are the same before and after every check; no check changes a mapping.
 */

const HOUR = 3_600_000;
const T0 = new Date("2026-10-31T13:00:00Z");
const at = (h: number, m = 0) => new Date(T0.getTime() + h * HOUR + m * 60_000);
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const { marketing, approver, partner } = VIEWERS;

const pool: Pool = testPool();
afterAll(async () => pool.end());

function spend(id: string, name: string, platform: "google_ads" | "meta", d: number, dollars: number): RawRecord {
  return {
    entity: "spend_day",
    payload: { platform, accountId: `ACC-${platform}-${id}`, campaignId: id, campaignName: name, date: day(d), costMicros: String(dollars * 1_000_000), clicks: 5, conversions: 1, fetchedAt: `${day(d + 1)}T06:00:00Z`, currencyCode: "USD", ...(platform === "google_ads" ? { campaignType: "SEARCH" } : {}) },
  };
}
const setClock = (when: Date) => pool.query("update app_clock set now = $1", [when]);
async function deliverCalls(records: RawRecord[], when: Date) {
  const versions = records.map((r) => ({ stream: "calls", entity: r.entity, visibleAt: when.getTime() - 60_000, payload: r.payload as Record<string, unknown> }));
  const client = new InMemorySourceClient("calls", "calls", versions, () => null);
  const run = await runStream(pool, { client, mapper: mapperFor("calls"), ctx: referenceContext, now: when, windowEnd: when, overlapMs: 0, initialCursor: new Date(when.getTime() - 30 * 24 * HOUR) });
  expect(run.status).toBe("succeeded");
}
const tick = () => workerTick(defaultRuntime(pool, "test-worker"), {});
const campaignId = async (platform: string, id: string) => Number((await one<{ id: string }>(pool, "select id from ad_campaigns where platform = $1 and external_campaign_id = $2", [platform, id])).id);
const propose = async (platform: string, id: string, branchId: string) =>
  createChange(pool, marketing, { kind: "campaign_mapping", payload: { campaignId: await campaignId(platform, id), branchId }, reason: `Leads for ${id} on ${platform} arrive at ${branchId}` }, T0);
async function approveAndRelease(change: ChangeRow): Promise<ChangeRow> {
  await decideChange(pool, approver, change.id, { decision: "approve", reason: "Read the lead evidence and the spend; approved", configHash: change.configHash, preflightHash: change.preflightHash! }, T0);
  return releaseChange(pool, marketing, change.id, T0);
}
const coverage = (c: ChangeRow) => c.preflight!.checks.find((x) => x.id === "mapping_coverage")!;
const latestRun = async (changeId: number) => (await pool.query("select * from change_monitor_runs where change_id = $1 order by id desc limit 1", [changeId])).rows[0];
const mapping = async (platform: string, id: string) =>
  one<{ branch_id: string | null; versions: number }>(
    pool,
    `select m.branch_id, (select count(*)::int from campaign_mapping_versions v where v.campaign_id = c.id) as versions
     from ad_campaigns c left join campaign_branch_map m on m.campaign_id = c.id where c.platform = $1 and c.external_campaign_id = $2`,
    [platform, id],
  );
const driftItems = async () => (await pool.query("select id from exceptions where kind = 'mapping_drift'")).rows;
/** Company spend, customers and cash in October: what no check may change. */
const totals = async () => {
  const rows = await branchRows(pool, { from: PERIODS.oct.from, to: PERIODS.oct.to, branchIds: null });
  const all = await one<{ spend: string }>(pool, "select sum(cost_cents) as spend from ad_spend_daily");
  return { spend: Number(all.spend), acquired: rows.reduce((t, r) => t + r.acquired, 0), collected: rows.reduce((t, r) => t + r.collectedCents, 0) };
};

describe("world A: Google and Meta share campaign id 777 and point to different branches", () => {
  let g12: ChangeRow;
  let m20: ChangeRow;

  beforeAll(async () => {
    await freshDb(pool);
    await ingest(pool, "ads", [
      ...Array.from({ length: 10 }, (_, i) => spend("777", "G777 search", "google_ads", i + 1, 40)),
      ...Array.from({ length: 10 }, (_, i) => spend("777", "M777 leads", "meta", i + 1, 30)),
    ], { now: at(-3) });
    const c1 = acquisition(1, "B12", "+16025557001", new Date(`${day(9)}T16:00:00Z`), { source: "Google Ads" });
    const c2 = acquisition(2, "B20", "+16025557002", new Date(`${day(9)}T17:00:00Z`), { source: "Facebook" });
    for (const w of [c1, c2]) (w.call.payload as Record<string, unknown>).campaign = "777";
    await deliverCalls([
      ...Array.from({ length: 5 }, (_, i) => call(`GA-${i}`, "B12", `+1602555${String(7100 + i)}`, new Date(`${day(2 + i)}T16:00:00Z`), "Google Ads", { campaign: "777" })),
      ...Array.from({ length: 7 }, (_, i) => call(`FB-${i}`, "B20", `+1602555${String(7200 + i)}`, new Date(`${day(2 + i)}T16:00:00Z`), "Facebook", { campaign: "777" })),
      call("UNR-1", "B12", "+16025557301", new Date(`${day(8)}T16:00:00Z`), "Direct", { campaign: "777" }),
      c1.call,
      c2.call,
    ], at(-2));
    await ingest(pool, "web", [{
      entity: "lead",
      payload: { messageId: "UNR-W", timestamp: `${day(8)}T17:00:00Z`, properties: { form: "quote", branch_id: "B12", zip: "85001", phone: "+16025557302", email: null, utm_source: "facebook", utm_medium: "paid_social", utm_campaign: "777", gclid: "gclid-unr-w", message: null } },
    }], { now: at(-2) });
    await ingest(pool, "crm", [...c1.crm, ...c2.crm], { now: at(-2) });
    await runReconcile(pool, at(-1));
    await setClock(T0);
  }, 180_000);

  it("preflight: another platform's leads neither inflate nor deflate support; unresolved leads never count", async () => {
    const wrong = await propose("google_ads", "777", "B20");
    expect([wrong.status, coverage(wrong).status, coverage(wrong).code]).toEqual(["preflight_failed", "fail", "LEAD_EVIDENCE_DISAGREES"]);
    expect(coverage(wrong).evidence).toEqual({ leadEvidence: [{ branchId: "B12", leads: 6 }], unresolved: [{ branchId: "B12", leads: 2 }] });

    g12 = await propose("google_ads", "777", "B12");
    expect([g12.status, coverage(g12).status]).toEqual(["ready_for_review", "pass"]);
    expect(coverage(g12).detail).toMatch(/2 other lead\(s\) carry this id/);

    m20 = await propose("meta", "777", "B20");
    expect([m20.status, coverage(m20).status, coverage(m20).code]).toEqual(["ready_for_review", "warn", "LEAD_EVIDENCE_UNRESOLVED"]);
    expect(coverage(m20).evidence).toEqual({ leadEvidence: [{ branchId: "B20", leads: 8 }], unresolved: [{ branchId: "B12", leads: 2 }] });
    expect(coverage(m20).detail).toMatch(/agrees.*split|split.*agrees/);
  });

  it("release: each campaign's evidence is its own leads; money moves exactly, and nothing else", async () => {
    const before = await totals();
    g12 = await approveAndRelease(g12);
    m20 = await approveAndRelease(m20);
    expect(g12.verification!.releaseEvidence).toEqual({ leadEvidence: [{ branchId: "B12", leads: 6 }], verdict: "agrees", sources: ["calls"], unresolved: [{ branchId: "B12", leads: 2 }] });
    expect(m20.verification!.releaseEvidence).toEqual({ leadEvidence: [{ branchId: "B20", leads: 8 }], verdict: "agrees", sources: ["calls"], unresolved: [{ branchId: "B12", leads: 2 }] });
    for (const c of [g12, m20]) {
      expect(c.status).toBe("verified");
      expect(c.verification!.checks.filter((k) => !k.passed)).toEqual([]);
    }
    expect(await totals()).toEqual(before);
    expect([await mapping("google_ads", "777"), await mapping("meta", "777")]).toEqual([{ branch_id: "B12", versions: 2 }, { branch_id: "B20", versions: 2 }]);
  });

  it("monitoring: the guard still certifies nothing, and Meta's lead never counts against Google's mapping", async () => {
    await deliverCalls([call("FB-X", "B05", "+16025557401", at(18), "Facebook", { campaign: "777" })], at(20));
    const before = await totals();
    await setClock(at(24, 5));
    await tick();
    const g = await latestRun(g12.id);
    expect([g.outcome, g.evidence.reasons]).toEqual(["insufficient_evidence", ["CAMPAIGN_ID_AMBIGUOUS"]]);
    expect(g.evidence.now.leadEvidence).toEqual([{ branchId: "B12", leads: 6 }]);
    expect([g.evidence.newBranches, g.evidence.conflicting, g.evidence.unresolved]).toEqual([[], [], [{ branchId: "B12", leads: 2 }]]);
    expect(g.scope.branches).toEqual(["B12", "B20"]);
    const m = await latestRun(m20.id);
    expect([m.outcome, m.evidence.reasons]).toEqual(["insufficient_evidence", ["CAMPAIGN_ID_AMBIGUOUS"]]);
    expect([m.evidence.now.leadEvidence, m.evidence.newBranches]).toEqual([[{ branchId: "B20", leads: 8 }, { branchId: "B05", leads: 1 }], ["B05"]]);
    for (const run of [g, m]) {
      const checks = Object.fromEntries(run.checks.map((c: { id: string; status: string }) => [c.id, c.status]));
      expect(checks).toMatchObject({ still_applied: "pass", campaign_id_unambiguous: "unknown", evidence_since_release: "unknown" });
    }
    expect(await driftItems()).toEqual([]);
    for (const id of [g12.id, m20.id]) expect((await getChange(pool, marketing, id)).change).toMatchObject({ status: "verified", lastVerifiedAt: T0.toISOString() });
    expect([await mapping("google_ads", "777"), await mapping("meta", "777")]).toEqual([{ branch_id: "B12", versions: 2 }, { branch_id: "B20", versions: 2 }]);
    expect(await totals()).toEqual(before);
  });

  it("one stored check, redacted per viewer: the B20 partner sees B20 only, and Google's campaign by platform only", async () => {
    const run = await latestRun(m20.id);
    const full = await getMonitorRun(pool, marketing, m20.id, Number(run.id));
    expect(full.redacted.run.evidence.sharedId).toEqual([expect.objectContaining({ platform: "google_ads", name: "G777 search", branchId: "B12" })]);
    const mine = await getMonitorRun(pool, partner, m20.id, Number(run.id));
    const e = mine.redacted.run.evidence;
    expect(e.now?.leadEvidence).toEqual([{ branchId: "B20", leads: 8 }]);
    expect(e.unresolved).toEqual([]);
    expect(e.sharedId).toEqual([expect.objectContaining({ platform: "google_ads", name: "a campaign outside your scope", branchId: "outside your scope" })]);
    expect(mine.redacted.hidden).toMatchObject({ leads: 1 });
    const text = JSON.stringify(mine.redacted);
    for (const leak of ["G777 search", "B12", "B05", "ACC-google"]) expect(text, leak).not.toContain(leak);
    await expect(getChange(pool, partner, g12.id)).rejects.toBeInstanceOf(ForbiddenError);
  });
});

describe("which coverage verdicts unresolved leads leave possible (added with the fix)", () => {
  it("bounds, not all-or-nothing: some of them can change an answer that all of them would not", () => {
    const base = { leadEvidence: [{ branchId: "B13", leads: 5 }, { branchId: "B20", leads: 4 }], unresolvedEvidence: [{ branchId: "B20", leads: 2 }, { branchId: "B13", leads: 2 }] };
    expect(evidenceVerdict(base, "B13")).toBe("split");
    // All four counted: 7 at B13 and 6 at B20, still split. Only the two at B20: 5 against 6, disagrees.
    expect(unresolvedVerdicts(base, "B13")).toEqual(["disagrees"]);
    // Three at B13 can only strengthen a split that stays a split.
    expect(unresolvedVerdicts({ ...base, unresolvedEvidence: [{ branchId: "B13", leads: 3 }] }, "B13")).toEqual([]);
    // No lead of the campaign at all: one unresolved lead at the branch could make it agree.
    expect(unresolvedVerdicts({ leadEvidence: [], unresolvedEvidence: [{ branchId: "B13", leads: 1 }] }, "B13")).toEqual(["agrees"]);
  });

  it("an approval depends on unresolved leads only where they could change the answer", () => {
    const campaign = (unresolvedEvidence: Array<{ branchId: string; leads: number }>): CampaignBase => ({
      campaignId: 1, externalCampaignId: "x", name: "x", platform: "google_ads", channelCode: "google_search", currentBranchId: null,
      leadEvidence: [{ branchId: "B13", leads: 5 }, { branchId: "B20", leads: 4 }], unresolvedEvidence, otherCampaignLeads: 0,
      lineage: [], spendCents: 0, spendDays: { first: null, last: null, days: 0 }, mediaSpendInWindowCents: 0,
    });
    // Leads that cannot change the verdict: the hash an approval was bound to before the fix.
    expect(baseHashOf(campaign([{ branchId: "B13", leads: 3 }]), "B13")).toBe(baseHashOf(campaign([]), "B13"));
    // Leads that could turn it into "disagrees": a different hash, so an approval over it is re-checked.
    expect(baseHashOf(campaign([{ branchId: "B20", leads: 2 }, { branchId: "B13", leads: 2 }]), "B13")).not.toBe(baseHashOf(campaign([]), "B13"));
  });
});

describe("world B: an unresolved lead is neither proof of a match nor proof of drift", () => {
  let g13: ChangeRow;

  beforeAll(async () => {
    await freshDb(pool);
    await ingest(pool, "ads", Array.from({ length: 10 }, (_, i) => spend("888", "G888 search", "google_ads", i + 1, 50)), { now: at(-3) });
    await deliverCalls(Array.from({ length: 5 }, (_, i) => call(`G8-${i}`, "B13", `+1602555${String(8100 + i)}`, new Date(`${day(2 + i)}T16:00:00Z`), "Google Ads", { campaign: "888" })), at(-2));
    await runReconcile(pool, at(-1));
    await setClock(T0);
    g13 = await approveAndRelease(await propose("google_ads", "888", "B13"));
    expect(g13.status).toBe("verified");
  }, 180_000);

  it("a lead naming no platform at a new branch leaves the check uncertified, not drifted", async () => {
    await deliverCalls([call("U8-1", "B05", "+16025558201", at(18), "Direct", { campaign: "888" })], at(20));
    await setClock(at(24, 5));
    await tick();
    const run = await latestRun(g13.id);
    expect([run.outcome, run.evidence.reasons]).toEqual(["insufficient_evidence", ["LEADS_UNRESOLVED"]]);
    const since = run.checks.find((c: { id: string }) => c.id === "evidence_since_release");
    expect([since.status, since.detail]).toEqual(["unknown", expect.stringMatching(/1 lead\(s\) at B05 carry this campaign's id.*neither/)]);
    expect(run.evidence.unresolved).toEqual([{ branchId: "B05", leads: 1 }]);
    expect(await driftItems()).toEqual([]);
    expect((await getChange(pool, marketing, g13.id)).change).toMatchObject({ status: "verified", lastVerifiedAt: T0.toISOString() });
    expect(await mapping("google_ads", "888")).toEqual({ branch_id: "B13", versions: 2 });
  });

  it("the campaign's own lead at a new branch is still a drift", async () => {
    await deliverCalls([call("G8-X", "B05", "+16025558301", at(42), "Google Ads", { campaign: "888" })], at(44));
    await setClock(at(48, 5));
    await tick();
    const run = await latestRun(g13.id);
    // Both reasons, by the existing drift rule: one lead off the released branch also turns
    // "agrees" (5 of 5 at B13) into "split" (5 of 6). The hand-written expectation first listed
    // only the first reason; the old code gave both for the same lead (observed 2026-11-13).
    expect([run.outcome, run.evidence.reasons]).toEqual(["drift", ["LEAD_OUTSIDE_APPROVED_EVIDENCE", "EVIDENCE_VERDICT_WORSENED"]]);
    // The unresolved U8-1 at B05 is not a contradicting record: only the campaign's own lead is.
    expect(run.evidence.conflicting.map((c: { sourceLeadId: string }) => c.sourceLeadId)).toEqual(["G8-X"]);
    expect(run.evidence.now.leadEvidence).toEqual([{ branchId: "B13", leads: 5 }, { branchId: "B05", leads: 1 }]);
    expect(run.evidence.unresolved).toEqual([{ branchId: "B05", leads: 1 }]);
    expect(await driftItems()).toHaveLength(1);
    expect(await mapping("google_ads", "888")).toEqual({ branch_id: "B13", versions: 2 });
  });
});
