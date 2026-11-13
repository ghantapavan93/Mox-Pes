import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { RawRecord } from "@/lib/adapters/contract";
import { mapCampaignToBranch, overrideLeadBranch } from "@/lib/actions";
import { groundDraft } from "@/lib/ai/analyst";
import type { DraftFindings } from "@/lib/ai/contract";
import { createChange, decideChange, getChange, listChanges, monitorChange, releaseChange, rerunPreflight, type ChangeRow } from "@/lib/changeguard/service";
import { ForbiddenError, VIEWERS } from "@/lib/viewer";
import { acquisition, call, crm, freshDb, ingest, one, runReconcile, testPool } from "../helpers";

/**
 * Marketing ChangeGuard scenarios (docs/agent-work/CHANGEGUARD.md). The fixture is built here,
 * from intake, independent of the preflight's logic:
 *
 *   lsa-B44-x  a new Local Services campaign at B44 (brand "joshuas"): 10 days of spend, no
 *              branch mapping (an unmapped_spend exception), and 11 calls carrying its id (one became a customer), all
 *              at B44.
 *   gs-B01     a search campaign mapped to B01, its 6 calls at B01.
 *
 * Each scenario is labelled with the outcome a careful person would want (block or allow), and
 * the suite tallies false positives (allowed things blocked) and false negatives (unsafe things
 * allowed) over the labelled set.
 */
const NOW = new Date("2026-10-31T13:00:00Z");
const { marketing, engineer, approver, partner } = VIEWERS;
const day = (d: number) => `2026-10-${String(d).padStart(2, "0")}`;
const at = (d: number) => new Date(`${day(d)}T16:00:00Z`);

function spend(campaignId: string, name: string, platform: string, d: number, dollars: number): RawRecord {
  return {
    entity: "spend_day",
    payload: { platform, accountId: `ACC-${campaignId}`, campaignId, campaignName: name, date: day(d), costMicros: String(dollars * 1_000_000), clicks: 5, conversions: 1, fetchedAt: `${day(d + 1)}T06:00:00Z`, campaignType: platform === "google_lsa" ? "LOCAL_SERVICES" : "SEARCH" },
  };
}

let pool: Pool;
let b44CampaignId: number;
let b01CampaignId: number;
const tally: Array<{ scenario: string; want: "block" | "allow"; got: "block" | "allow" }> = [];
const outcomeOf = (c: ChangeRow): "block" | "allow" => (c.preflight?.verdict === "fail" ? "block" : "allow");
const counts = async () =>
  one<{ maps: number; audit: number; open: number; raw: number }>(
    pool,
    "select (select count(*)::int from campaign_branch_map) as maps, (select count(*)::int from audit_log) as audit, (select count(*)::int from exceptions where status = 'open') as open, (select count(*)::int from raw_events) as raw",
  );

beforeAll(async () => {
  pool = testPool();
  await freshDb(pool);
  const ads: RawRecord[] = [];
  for (let d = 1; d <= 10; d++) {
    ads.push(spend("lsa-B44-x", "B44 | Local Services | Expansion", "google_lsa", d, 50));
    ads.push(spend("gs-B01", "B01 | Search | Pest", "google_ads", d, 100));
  }
  await ingest(pool, "ads", ads, { now: NOW });
  const calls: RawRecord[] = [];
  for (let i = 0; i < 10; i++) calls.push(call(`CG-44-${i}`, "B44", `+1480555${String(1000 + i)}`, at(2 + (i % 8)), "Google LSA", { campaign: "lsa-B44-x" }));
  for (let i = 0; i < 6; i++) calls.push(call(`CG-01-${i}`, "B01", `+1602555${String(1000 + i)}`, at(2 + i), "Google Ads", { campaign: "gs-B01" }));
  // One of the campaign's callers became a customer at B44: B44's paid-customer count (the CAC
  // denominator) depends on the campaign being mapped at all, wherever its spend goes.
  const won = acquisition(44, "B44", "+14805551000", at(3), { source: "Google LSA" });
  (won.call.payload as Record<string, unknown>).campaign = "lsa-B44-x";
  calls.push(won.call);
  await ingest(pool, "calls", calls, { now: NOW });
  await ingest(pool, "crm", won.crm, { now: NOW });
  b44CampaignId = (await one<{ id: string }>(pool, "select id from ad_campaigns where external_campaign_id = 'lsa-B44-x'")).id as unknown as number;
  b01CampaignId = (await one<{ id: string }>(pool, "select id from ad_campaigns where external_campaign_id = 'gs-B01'")).id as unknown as number;
  b44CampaignId = Number(b44CampaignId);
  b01CampaignId = Number(b01CampaignId);
  await mapCampaignToBranch(pool, { campaignId: b01CampaignId, branchId: "B01", actor: "setup", reason: "fixture mapping", now: NOW });
  await runReconcile(pool, NOW);
}, 120_000);

afterAll(async () => {
  await pool.end();
});

describe("Scenario A · a new campaign mapped to the wrong branch", () => {
  let wrong: ChangeRow;
  let corrected: ChangeRow;

  it("preflight blocks it with the exact contradiction, and mutates nothing", async () => {
    const before = await counts();
    expect(await one(pool, "select count(*)::int as n from exceptions where status = 'open' and kind = 'unmapped_spend'")).toEqual({ n: 1 });
    wrong = await createChange(pool, marketing, { kind: "campaign_mapping", payload: { campaignId: b44CampaignId, branchId: "B04" }, reason: "New expansion campaign for the Briar office" }, NOW);
    tally.push({ scenario: "A wrong branch", want: "block", got: outcomeOf(wrong) });
    expect(wrong.status).toBe("preflight_failed");
    const check = (id: string) => wrong.preflight!.checks.find((c) => c.id === id)!;
    expect(check("mapping_coverage")).toMatchObject({ status: "fail", code: "LEAD_EVIDENCE_DISAGREES" });
    expect(check("mapping_coverage").detail).toContain("11 lead(s)");
    expect(check("mapping_collision")).toMatchObject({ status: "fail", code: "CROSS_BRAND" });
    expect(wrong.preflight!.checks).toHaveLength(14);
    // The preview really ran the write: it saw the unmapped-spend exception clear, and moved
    // $500 of spend onto B04, then rolled back.
    expect(wrong.preflight!.exceptionsCleared.map((e) => e.kind)).toEqual(["unmapped_spend"]);
    expect(wrong.preflight!.impact.find((i) => i.branchId === "B04")).toMatchObject({ role: "proposed", before: { paidSpendCents: 0 }, after: { paidSpendCents: 50_000 } });
    // The reporting consequence of the wrong mapping: B04 carries the spend while B44 counts the
    // customer as paid, so both branches' CAC would be wrong. B44 is a dependent, not "unrelated".
    expect(wrong.preflight!.impact.find((i) => i.branchId === "B44")).toMatchObject({ role: "lead_evidence", before: { paidAcquired: 0 }, after: { paidAcquired: 1 } });
    expect(wrong.preflight!.unrelatedBranchesChanged).toEqual([]);
    // Nothing authoritative moved (the change's own rows and events are its audit trail).
    const afterCounts = await counts();
    expect({ ...afterCounts, audit: undefined }).toEqual({ ...before, audit: undefined });
    expect(await one(pool, "select count(*)::int as n from campaign_branch_map where campaign_id = $1", [b44CampaignId])).toEqual({ n: 0 });
    expect(await one(pool, "select count(*)::int as n from audit_log where action = 'map_campaign'")).toEqual({ n: 1 }); // only the fixture's
  });

  it("a corrected resubmission passes, supersedes the wrong one, and is approved against the hashes reviewed", async () => {
    corrected = await createChange(pool, marketing, { kind: "campaign_mapping", payload: { campaignId: b44CampaignId, branchId: "B44" }, reason: "Leads for this campaign arrive at Willow (B44)", supersedes: wrong.id }, NOW);
    tally.push({ scenario: "A corrected", want: "allow", got: outcomeOf(corrected) });
    expect(corrected.status).toBe("ready_for_review");
    expect((await getChange(pool, approver, wrong.id)).change.status).toBe("superseded");
    expect(corrected.preflight!.checks.find((c) => c.id === "mapping_coverage")).toMatchObject({ status: "pass" });
    const approved = await decideChange(pool, approver, corrected.id, { decision: "approve", reason: "Evidence and brand agree; spend conserved", configHash: corrected.configHash, preflightHash: corrected.preflightHash! }, NOW);
    expect(approved).toMatchObject({ status: "approved", approvedSubject: "demo:approver" });
  });

  it("release applies it inside the synthetic environment and verifies configuration and data integrity", async () => {
    const released = await releaseChange(pool, marketing, corrected.id, NOW);
    expect(released.status).toBe("verified");
    expect(released.verification!.checks.every((c) => c.passed)).toBe(true);
    expect(released.verification!.businessImprovement).toBe("not measured");
    expect(await one(pool, "select branch_id from campaign_branch_map where campaign_id = $1", [b44CampaignId])).toEqual({ branch_id: "B44" });
    expect((await pool.query("select version, branch_id, change_id from campaign_mapping_versions where campaign_id = $1 order by version", [b44CampaignId])).rows).toEqual([
      { version: 1, branch_id: null, change_id: null },
      { version: 2, branch_id: "B44", change_id: String(corrected.id) },
    ]);
    expect(await one(pool, "select count(*)::int as n from exceptions where status = 'open' and kind = 'unmapped_spend'")).toEqual({ n: 0 });
    const history = (await getChange(pool, approver, corrected.id)).events.map((e) => e.to);
    expect(history).toEqual(["draft", "ready_for_review", "approved", "monitoring", "verified"]);
    // Released once: a second release is refused.
    await expect(releaseChange(pool, marketing, corrected.id, NOW)).rejects.toMatchObject({ status: 409 });
  });

  it("post-release monitoring flags new evidence against the mapping as recovery required; nothing is rolled back", async () => {
    const later = new Date("2026-10-31T18:00:00Z");
    await ingest(pool, "calls", [0, 1, 2].map((i) => call(`CG-44-late-${i}`, "B43", `+1480555${String(2000 + i)}`, later, "Google LSA", { campaign: "lsa-B44-x" })), { now: later });
    const monitored = await monitorChange(pool, marketing, corrected.id, later);
    expect(monitored.status).toBe("recovery_required");
    expect(monitored.verification!.monitor!.find((c) => c.id === "evidence_since_release")).toMatchObject({ passed: false });
    expect(await one(pool, "select branch_id from campaign_branch_map where campaign_id = $1", [b44CampaignId])).toEqual({ branch_id: "B44" });
  });
});

describe("Scenario B · an upstream CRM payment field changes", () => {
  it("the deployed mapper refuses the new shape; dependent revenue metrics are named; nothing is written", async () => {
    const before = await counts();
    const sample = { ...(crm.payment(9101, 1001, 4001, "B01", "149.00", at(5)).payload as Record<string, unknown>) };
    delete sample.ticketID;
    sample.paymentApplications = [{ ticketID: "4001", appliedAmount: "149.00" }];
    const change = await createChange(pool, engineer, { kind: "source_contract", payload: { source: "crm", entity: "payment", samples: [sample] }, reason: "FieldRoutes payments now carry paymentApplications" }, NOW);
    tally.push({ scenario: "B CRM shape change", want: "block", got: outcomeOf(change) });
    expect(change.status).toBe("preflight_failed");
    expect(change.preflight!.checks.find((c) => c.id === "schema_compatibility")).toMatchObject({ status: "fail", code: "INCOMPATIBLE_SHAPE" });
    expect(change.preflight!.dependentMetrics).toEqual(["collected", "newCollected", "atRisk"]);
    expect(change.preflight!.samples![0].outcome).toBe("refused:MISSING_FIELD");
    const after = await counts();
    expect({ ...after, audit: undefined }).toEqual({ ...before, audit: undefined });
  });
});

describe("Scenario C · the call provider sends the same lead twice", () => {
  it("the duplicate is one record version: no second business effect", async () => {
    const c = call("CG-dup", "B01", "+16025559999", at(8)).payload;
    const change = await createChange(pool, engineer, { kind: "source_contract", payload: { source: "calls", entity: "call", samples: [c, c] }, reason: "Provider retries post-call webhooks" }, NOW);
    tally.push({ scenario: "C duplicate delivery", want: "allow", got: outcomeOf(change) });
    expect(change.preflight!.samples!.map((s) => s.outcome)).toEqual(["projected:leads", "duplicate"]);
    expect(change.preflight!.checks.find((c2) => c2.id === "replay_safety")!.detail).toMatch(/1 sample\(s\) repeat/);
  });
});

describe("Scenario F · benign changes do not block", () => {
  it("a new field the mapper ignores is a structural difference, not a contract violation", async () => {
    const c = { ...(call("CG-extra", "B01", "+16025558888", at(9)).payload as Record<string, unknown>), call_score: 87 };
    const change = await createChange(pool, engineer, { kind: "source_contract", payload: { source: "calls", entity: "call", samples: [c] }, reason: "Provider added a call score field" }, NOW);
    tally.push({ scenario: "F added field", want: "allow", got: outcomeOf(change) });
    expect(change.status).toBe("ready_for_review");
    expect(change.preflight!.checks.find((x) => x.id === "schema_compatibility")).toMatchObject({ status: "pass" });
    expect(change.preflight!.samples![0].addedFields).toEqual(["call_score"]);
  });

  it("source contract checks stop at review: activating a mapper is a code deploy", async () => {
    const [change] = (await listChanges(pool, approver)).filter((c) => c.kind === "source_contract" && c.status === "ready_for_review");
    await expect(decideChange(pool, approver, change.id, { decision: "approve", reason: "Looks compatible to me", configHash: change.configHash, preflightHash: change.preflightHash! }, NOW)).rejects.toMatchObject({ status: 409 });
  });
});

describe("Scenario G · unauthorized approval and scope", () => {
  let change: ChangeRow;
  beforeAll(async () => {
    // Remap gs-B01 within its own branch's evidence would be a no-op; remap it to B02 (a real change to review).
    change = await createChange(pool, marketing, { kind: "campaign_mapping", payload: { campaignId: b01CampaignId, branchId: "B02" }, reason: "Test remap for the approval rules" }, NOW);
    tally.push({ scenario: "G remap against evidence", want: "block", got: outcomeOf(change) });
  });

  it("the remap against the campaign's own leads is blocked", () => {
    expect(change.status).toBe("preflight_failed");
  });

  it("an author cannot approve their own change, even through another role's session; the database refuses it too", async () => {
    const ok = await createChange(pool, engineer, { kind: "campaign_mapping", payload: { campaignId: b01CampaignId, branchId: "B01" }, reason: "No-op remap to probe the rules" }, NOW);
    expect(ok.preflight!.checks.find((c) => c.id === "mapping_coverage")).toMatchObject({ code: "NO_CHANGE", status: "fail" });
    const selfApprover = { ...approver, subject: "demo:marketing" };
    const ready = await createChange(pool, marketing, { kind: "source_contract", payload: { source: "calls", entity: "call", samples: [call("CG-g", "B01", "+16025557777", at(3)).payload] }, reason: "Probe approval rules" }, NOW);
    await expect(decideChange(pool, selfApprover, ready.id, { decision: "reject", reason: "self-decision attempt", configHash: ready.configHash, preflightHash: ready.preflightHash! }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    await expect(pool.query("update config_changes set approved_subject = author_subject where id = $1", [ready.id])).rejects.toThrow(/config_changes_different_person/);
    await expect(decideChange(pool, marketing, ready.id, { decision: "reject", reason: "no approve permission", configHash: ready.configHash, preflightHash: ready.preflightHash! }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("a branch-scoped role can neither propose nor read a change outside its branches", async () => {
    const scoped = { ...partner, can: { ...partner.can, propose: true } };
    await expect(createChange(pool, scoped, { kind: "campaign_mapping", payload: { campaignId: b01CampaignId, branchId: "B44" }, reason: "Out-of-scope attempt" }, NOW)).rejects.toBeInstanceOf(ForbiddenError);
    const someone = (await listChanges(pool, approver)).find((c) => c.kind === "campaign_mapping")!;
    await expect(getChange(pool, partner, someone.id)).rejects.toBeInstanceOf(ForbiddenError);
    expect((await listChanges(pool, partner)).every((c) => c.kind === "campaign_mapping")).toBe(true);
  });

  it("an approval presenting a different preflight than the stored one is refused (no swapped payloads)", async () => {
    const fresh = await createChange(pool, marketing, { kind: "campaign_mapping", payload: { campaignId: b01CampaignId, branchId: "B01" }, reason: "Another no-op probe" }, NOW);
    expect(fresh.status).toBe("preflight_failed");
    const ready = (await listChanges(pool, approver)).find((c) => c.status === "ready_for_review" && c.kind === "source_contract")!;
    await expect(decideChange(pool, approver, ready.id, { decision: "reject", reason: "hash from another change", configHash: ready.configHash, preflightHash: "0".repeat(64) }, NOW)).rejects.toMatchObject({ status: 409 });
  });
});

describe("TOCTOU · the base moves between approval and release", () => {
  it("the approval is invalidated instead of releasing over a changed mapping", async () => {
    await ingest(pool, "ads", [1, 2].map((d) => spend("ms-B05-new", "B05 | Bing Search", "microsoft_ads", d, 30)), { now: NOW });
    await ingest(pool, "calls", [0, 1].map((i) => call(`CG-05-${i}`, "B05", `+1303555${String(3000 + i)}`, at(3 + i), "Bing", { campaign: "ms-B05-new" })), { now: NOW });
    const id = Number((await one<{ id: string }>(pool, "select id from ad_campaigns where external_campaign_id = 'ms-B05-new'")).id);
    const change = await createChange(pool, marketing, { kind: "campaign_mapping", payload: { campaignId: id, branchId: "B05" }, reason: "Map the new Bing campaign" }, NOW);
    tally.push({ scenario: "TOCTOU valid change", want: "allow", got: outcomeOf(change) });
    await decideChange(pool, approver, change.id, { decision: "approve", reason: "Evidence agrees with B05", configHash: change.configHash, preflightHash: change.preflightHash! }, NOW);
    // Someone maps it elsewhere through another path before the release.
    await mapCampaignToBranch(pool, { campaignId: id, branchId: "B06", actor: "other", reason: "parallel edit", now: NOW });
    await expect(releaseChange(pool, marketing, change.id, NOW)).rejects.toMatchObject({ status: 409 });
    const after = (await getChange(pool, approver, change.id)).change;
    expect(after).toMatchObject({ status: "draft", approvedSubject: null });
    expect(await one(pool, "select branch_id from campaign_branch_map where campaign_id = $1", [id])).toEqual({ branch_id: "B06" });
    // A fresh preflight now sees the remap from B06.
    const again = await rerunPreflight(pool, marketing, change.id, NOW);
    expect(again.preflight!.impact.map((i) => i.branchId).sort()).toEqual(["B05", "B06"]);
  });
});

describe("Scenario H · an AI conclusion that the change increased revenue", () => {
  it("is dropped by grounding, even citing real records; a hedged hypothesis stays", () => {
    const draft: DraftFindings = {
      summary: "Mapping released",
      observations: [
        { text: "The corrected mapping increased revenue at B44 by $12,000.", evidenceIds: ["campaign:1"], status: "verified" },
        { text: "The change may have increased revenue; this is not measured.", evidenceIds: ["campaign:1"], status: "hypothesis", strength: "weak" },
        { text: "Spend of $500.00 moved from unallocated to B44.", evidenceIds: ["campaign:1"], status: "verified" },
      ],
      suspectedCause: null,
      proposals: [],
      missingInformation: [],
      confidence: { level: "high", why: "test" },
    } as unknown as DraftFindings;
    const { draft: kept, report } = groundDraft(draft, new Set(["campaign:1"]));
    expect(report.claimsDropped).toBe(1);
    expect(report.dropped[0].reason).toMatch(/measured experiment/);
    expect(kept.observations.map((o) => o.text)).toEqual(["The change may have increased revenue; this is not measured.", "Spend of $500.00 moved from unallocated to B44."]);
  });
});

describe("independent review findings (each failed before its fix)", () => {
  const newCampaign = async (externalId: string, name: string, leads: Array<[string, number]>) => {
    await ingest(pool, "ads", [1, 2].map((d) => spend(externalId, name, "google_ads", d, 20)), { now: NOW });
    let i = 0;
    const calls = leads.flatMap(([branch, n]) => Array.from({ length: n }, () => call(`${externalId}-${i++}`, branch, `+1520555${String(4000 + i)}`, at(4), "Google Ads", { campaign: externalId })));
    if (calls.length) await ingest(pool, "calls", calls, { now: NOW });
    return Number((await one<{ id: string }>(pool, "select id from ad_campaigns where external_campaign_id = $1", [externalId])).id);
  };

  it("monitoring needs a role that may propose or approve (a guest could flip a released change)", async () => {
    const released = (await listChanges(pool, approver)).find((c) => c.status === "recovery_required")!;
    await expect(monitorChange(pool, VIEWERS.guest, released.id, NOW)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("evidence drifting across the 50% line between approval and release invalidates the approval", async () => {
    const id = await newCampaign("gs-B07-x", "B07 | Search | Drift", [["B07", 5], ["B08", 3], ["B10", 2]]);
    const change = await createChange(pool, marketing, { kind: "campaign_mapping", payload: { campaignId: id, branchId: "B07" }, reason: "Half of the leads land at B07" }, NOW);
    expect(change.preflight!.checks.find((c) => c.id === "mapping_coverage")).toMatchObject({ status: "warn", code: "LEAD_EVIDENCE_SPLIT" });
    await decideChange(pool, approver, change.id, { decision: "approve", reason: "Split, but B07 holds half", configHash: change.configHash, preflightHash: change.preflightHash! }, NOW);
    // Same branches, but B08 now holds 6 of 13 against B07's 5: the evidence points elsewhere and
    // the coverage rule would fail. (Held-out HO-50 changed the boundary: 5 of 13 while B07 is still
    // the branch with the most leads is split, not a contradiction, so the drift must overtake B07.)
    await ingest(pool, "calls", [call("gs-B07-x-late-1", "B08", "+15205559001", at(5), "Google Ads", { campaign: "gs-B07-x" }), call("gs-B07-x-late-2", "B08", "+15205559002", at(5), "Google Ads", { campaign: "gs-B07-x" }), call("gs-B07-x-late-3", "B08", "+15205559003", at(5), "Google Ads", { campaign: "gs-B07-x" })], { now: NOW });
    await expect(releaseChange(pool, marketing, change.id, NOW)).rejects.toMatchObject({ status: 409 });
    expect((await getChange(pool, approver, change.id)).change.status).toBe("draft");
  });

  it("a remap across brands is refused even when no lead carries the campaign id", async () => {
    const id = await newCampaign("fb-B01-nolead", "Prospecting without ids", []);
    await mapCampaignToBranch(pool, { campaignId: id, branchId: "B01", actor: "setup", reason: "fixture mapping", now: NOW });
    const change = await createChange(pool, marketing, { kind: "campaign_mapping", payload: { campaignId: id, branchId: "B44" }, reason: "Move the campaign to Willow" }, NOW);
    expect(change.preflight!.checks.find((c) => c.id === "mapping_coverage")).toMatchObject({ code: "NO_LEAD_EVIDENCE" });
    expect(change.preflight!.checks.find((c) => c.id === "mapping_collision")).toMatchObject({ status: "fail", code: "CROSS_BRAND" });
  });

  it("lead evidence follows a person's branch override, as the metrics do", async () => {
    const id = await newCampaign("gs-B03-o", "B03 | Search | Override", [["B03", 2]]);
    const lead = await one<{ id: string }>(pool, "select id from leads where campaign_external_id = 'gs-B03-o' order by id limit 1");
    await overrideLeadBranch(pool, { leadId: Number(lead.id), branchId: "B02", actor: "setup", reason: "caller was in B02", now: NOW });
    const change = await createChange(pool, marketing, { kind: "campaign_mapping", payload: { campaignId: id, branchId: "B03" }, reason: "Map to where its leads land" }, NOW);
    expect(change.preflight!.checks.find((c) => c.id === "mapping_coverage")!.evidence).toEqual({ leadEvidence: [{ branchId: "B02", leads: 1 }, { branchId: "B03", leads: 1 }] });
    expect(change.preflight!.unrelatedBranchesChanged).toEqual([]);
  });

  it("a scoped role cannot read a company-wide source check, and nobody can supersede another author's change", async () => {
    const source = (await listChanges(pool, approver)).find((c) => c.kind === "source_contract")!;
    await expect(getChange(pool, partner, source.id)).rejects.toBeInstanceOf(ForbiddenError);
    const theirs = (await listChanges(pool, approver)).find((c) => c.kind === "campaign_mapping" && c.status === "preflight_failed" && c.authorSubject === "demo:marketing")!;
    await expect(
      createChange(pool, engineer, { kind: "campaign_mapping", payload: { campaignId: b01CampaignId, branchId: "B02" }, reason: "Taking over someone else's change", supersedes: theirs.id }, NOW),
    ).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("the release checks are real: spend moved exactly, and nothing unrelated moved", async () => {
    const verified = (await listChanges(pool, approver)).find((c) => c.title.startsWith("lsa-B44-x") && c.verification)!;
    const ids = verified.verification!.checks.map((c) => `${c.id}:${c.passed}`);
    expect(ids).toEqual(["applied:true", "spend_moved_exactly:true", "unrelated_unchanged:true", "predicted_exceptions_cleared:true"]);
    expect(verified.verification!.checks[1].detail).toBe("B44 gained exactly $500.00 of paid spend from unallocated.");
    // Monitoring replaced, never appended: the release checks are still the four above. The
    // monitoring checks are the scheduled check's four (R-30, lib/changeguard/monitor.ts).
    expect(verified.verification!.monitor?.map((c) => c.id)).toEqual(["still_applied", "campaign_id_unambiguous", "evidence_since_release", "feeds_current"]);
    // Verified at release stays the release time; the failed check did not refresh the last success.
    expect(verified.verifiedAt).toBe(verified.releasedAt);
    expect(verified.lastVerifiedAt).toBe(verified.releasedAt);
  });
});

describe("measured over the labelled scenarios", () => {
  it("no false positives and no false negatives on this set", () => {
    const fp = tally.filter((t) => t.want === "allow" && t.got === "block");
    const fn = tally.filter((t) => t.want === "block" && t.got === "allow");
    console.log(JSON.stringify({ changeguardScenarios: tally.length, falsePositives: fp.length, falseNegatives: fn.length, tally }));
    expect(tally.length).toBeGreaterThanOrEqual(7);
    expect(fp).toEqual([]);
    expect(fn).toEqual([]);
  });
});
