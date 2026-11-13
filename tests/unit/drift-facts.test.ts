import { describe, expect, it } from "vitest";
import { briefCopy } from "@/lib/changeguard/brief";
import { factBranches, factsKey, materialFacts, parseFact, unseenFacts } from "@/lib/changeguard/facts";
import { diffFields, type ChangedLead, type DriftCaseView, type ReviewView } from "@/lib/changeguard/review";

/**
 * The material facts of a drift (lib/changeguard/facts.ts) and the brief's words
 * (lib/changeguard/brief.ts), without a database.
 */

const lead = (sourceLeadId: string, branchId: string, extra: Record<string, unknown> = {}) => ({
  leadId: 1,
  source: "calls",
  sourceLeadId,
  branchId,
  overridden: false,
  rawEventId: 100,
  deliveredAt: "2026-11-01T19:05:00.000Z",
  firstSeenAt: "2026-10-08T08:00:00.000Z",
  previousRawEventId: 90,
  previousBranchId: "B44",
  ...extra,
});

describe("material facts", () => {
  const base = { conflicting: [lead("CAL-1", "B39")], reasons: ["LEAD_OUTSIDE_APPROVED_EVIDENCE", "EVIDENCE_VERDICT_WORSENED"], liveBranchId: "B44", now: { verdict: "split" } };

  it("name the contradiction, not the check that read it", () => {
    expect(materialFacts(base)).toEqual(["lead|calls|CAL-1|B39", "verdict|split"]);
    // Another check of the same evidence: new raw event (a re-delivery or a note-only revision),
    // later delivery, a stale feed named beside it, another check id — the same facts.
    const again = {
      ...base,
      conflicting: [lead("CAL-1", "B39", { rawEventId: 205, previousRawEventId: 200, previousBranchId: "B39", deliveredAt: "2026-11-04T10:00:00.000Z" })],
      reasons: [...base.reasons, "FEED_STALE"],
      runId: 99,
    };
    expect(factsKey(materialFacts(again))).toBe(factsKey(materialFacts(base)));
  });

  it("are independent of row order and duplicates", () => {
    const a = materialFacts({ ...base, conflicting: [lead("CAL-1", "B39"), lead("CAL-2", "B41")] });
    const b = materialFacts({ ...base, conflicting: [lead("CAL-2", "B41"), lead("CAL-1", "B39"), lead("CAL-1", "B39")] });
    expect(a).toEqual(b);
    expect(factsKey(a)).toBe(factsKey([...a].reverse()));
  });

  it("a second lead, a lead at another branch, the mapping moving, a worse verdict: each is new", () => {
    const seen = materialFacts(base);
    expect(unseenFacts(materialFacts({ ...base, conflicting: [lead("CAL-1", "B39"), lead("CAL-2", "B41")] }), seen)).toEqual(["lead|calls|CAL-2|B41"]);
    expect(unseenFacts(materialFacts({ ...base, conflicting: [lead("CAL-1", "B38")] }), seen)).toEqual(["lead|calls|CAL-1|B38"]);
    expect(unseenFacts(materialFacts({ ...base, reasons: [...base.reasons, "MAPPING_MOVED_OUTSIDE_CHANGEGUARD"], liveBranchId: "B12" }), seen)).toEqual(["mapping|B12"]);
    expect(unseenFacts(materialFacts({ ...base, now: { verdict: "disagrees" } }), seen)).toEqual(["verdict|disagrees"]);
    // Fewer contradictions than were reviewed is not new evidence.
    expect(unseenFacts(materialFacts({ ...base, conflicting: [] }), seen)).toEqual([]);
  });

  it("a better verdict is never new evidence; a worse one is (independent review finding #2)", () => {
    const reviewedAtDisagrees = materialFacts({ ...base, now: { verdict: "disagrees" } });
    expect(unseenFacts(materialFacts({ ...base, now: { verdict: "split" } }), reviewedAtDisagrees)).toEqual([]);
    expect(unseenFacts(materialFacts({ ...base, now: { verdict: "disagrees" } }), materialFacts(base))).toEqual(["verdict|disagrees"]);
  });

  it("a lead at a branch the approval saw is not a fact by itself, re-delivered or not (finding #2)", () => {
    // Verdict worsened: the check lists a re-delivered pre-release lead at an approved branch (B43)
    // beside the real contradiction at B39. Only the B39 lead and the worse verdict are facts.
    const withApproved = { ...base, newBranches: ["B39"], conflicting: [lead("CAL-1", "B39"), lead("CAL-7", "B43")] };
    expect(materialFacts(withApproved)).toEqual(["lead|calls|CAL-1|B39", "verdict|split"]);
    const redelivered = { ...withApproved, conflicting: [lead("CAL-1", "B39"), lead("CAL-7", "B43", { deliveredAt: "2026-11-09T10:00:00.000Z" }), lead("CAL-8", "B43")] };
    expect(unseenFacts(materialFacts(redelivered), materialFacts(withApproved))).toEqual([]);
  });

  it("parse back, and name their branches for scope checks", () => {
    expect(parseFact("lead|calls|CAL-1|B39")).toEqual({ kind: "lead", source: "calls", sourceLeadId: "CAL-1", branchId: "B39" });
    expect(parseFact("withdrawn")).toEqual({ kind: "withdrawn" });
    expect(parseFact("nonsense|x")).toBeNull();
    expect(factBranches(["lead|calls|CAL-1|B39", "mapping|unmapped", "verdict|split", "lead|web|W-2|B41"])).toEqual(["B39", "B41"]);
  });
});

describe("field comparison of two stored versions", () => {
  it("puts changed fields first, aligned before and after", () => {
    const rows = diffFields({ call_id: "C1", branch_tag: "B44", minutes: 3 }, { call_id: "C1", branch_tag: "B39", minutes: 3, agent_note: "moved" });
    expect(rows.map((r) => [r.field, r.changed])).toEqual([
      ["agent_note", true],
      ["branch_tag", true],
      ["call_id", false],
      ["minutes", false],
    ]);
    expect(rows[1]).toEqual({ field: "branch_tag", before: "B44", after: "B39", changed: true });
    expect(rows[0]).toEqual({ field: "agent_note", before: null, after: "moved", changed: true });
  });
});

const review = (over: Partial<ReviewView> = {}): ReviewView => ({
  id: 1,
  caseId: 9,
  exceptionId: 5,
  disposition: "reviewed_no_change",
  rationale: "A source correction",
  owner: null,
  actorSubject: "demo:marketing",
  actorRole: "marketing",
  reviewedAt: "2026-11-02T15:00:00.000Z",
  runId: 2,
  actorLabel: "Marketing analyst",
  ownerLabel: null,
  leadsReviewed: 1,
  ...over,
});

const changed = (sourceLeadId: string, from: string | null, to: string, isNew = false): ChangedLead => ({
  fact: `lead|calls|${sourceLeadId}|${to}`,
  noun: "Call",
  source: "calls",
  sourceLeadId,
  branchNow: to,
  branchAtRelease: from,
  atReleaseWithheld: false,
  movedAt: "2026-11-01T19:05:00.000Z",
  newSince: isNew ? "review" : null,
  isNew,
  sinceReview: isNew,
  recordHref: null,
  atRelease: from ? { rawEventId: 90, receivedAt: "2026-10-08T08:00:00.000Z", adapterVersion: "1.1", branchId: from } : null,
  latest: { rawEventId: 100, receivedAt: "2026-11-01T19:05:00.000Z", adapterVersion: "1.1", branchId: to },
  fields: [],
});

function view(over: Partial<DriftCaseView> = {}): DriftCaseView {
  return {
    caseId: 9,
    state: "detected",
    owner: null,
    reopenCount: 0,
    change: { id: 1, campaign: "lsa-B44-x", campaignName: "", releasedAt: "2026-10-31T13:00:00.000Z", releasedBranch: "B44", liveBranch: "B44", liveVersion: 2, liveChangeId: 1, unchanged: true },
    release: { atTarget: 10, total: 10 },
    latest: { runId: 2, ranAt: "2026-11-02T13:05:00.000Z", atTarget: 9, total: 10, evidenceKey: "k", verdict: "split" },
    leads: [changed("CAL-1", "B44", "B39")],
    hiddenLeads: 0,
    mappingMoved: false,
    decision: null,
    reopened: null,
    sinceCheck: null,
    reviews: [],
    history: [],
    checks: [],
    spendAtStakeCents: 453_934,
    canDecide: true,
    readOnlyReason: null,
    ...over,
  };
}

describe("the brief's words come from the stored case", () => {
  it("open: what changed, what did not; finding, decision and outcome stay apart", () => {
    const b = briefCopy(view());
    expect(b).toMatchObject({ state: "open", status: { label: "Needs review", tone: "warn" }, whatsNew: null });
    expect(b.headline).toBe("One lead changed branches. The mapping stayed at B44.");
    expect(b.detail).toBe("A call that arrived at B44 was revised at the source to point to B39. The live mapping of lsa-B44-x, read now, is still B44 (version 2), as released; no check changed it.");
    expect(b.finding).toBe("Check #2 on Nov 2 confirmed a change in the evidence the release was approved on. The check changed nothing.");
    expect(b.disposition).toBe("Open — no one has reviewed it yet.");
    expect(b.outcome).toBe("No revenue impact was measured from this finding. $4,539 of the campaign's spend is at stake, not lost. One source revision does not show the mapping is wrong.");
  });

  it("nothing about the demo is hard-coded: another campaign, branches and counts read through", () => {
    const b = briefCopy(view({ change: { ...view().change, campaign: "web-B07", releasedBranch: "B07", liveBranch: "B07", liveVersion: 5 }, leads: [changed("W-9", null, "B12")], spendAtStakeCents: 12_000 }));
    expect(b.headline).toBe("One lead arrived outside the approved branches. The mapping stayed at B07.");
    expect(b.detail).toContain("The live mapping of web-B07, read now, is still B07 (version 5)");
    expect(b.outcome).toContain("$120.00 of the campaign's spend is at stake, not lost");
  });

  it("reviewed: the decision and who made it", () => {
    const b = briefCopy(view({ state: "closed_acknowledged", decision: review() }));
    expect(b).toMatchObject({ state: "reviewed", status: { label: "Reviewed — no mapping change", tone: "good" } });
    expect(b.disposition).toBe("Reviewed — no mapping change, by Marketing analyst on Nov 2.");
  });

  it("reopened: leads with what is new since the review, and keeps it", () => {
    const b = briefCopy(
      view({
        reopenCount: 1,
        leads: [changed("CAL-2", "B44", "B41", true), changed("CAL-1", "B44", "B39")],
        reopened: { at: "2026-11-04T13:05:00.000Z", runId: 5, previous: review(), newLeads: 1, hiddenNewLeads: 0, otherNewFacts: [] },
      }),
    );
    expect(b).toMatchObject({ state: "reopened", status: { label: "Reopened — new evidence", tone: "bad" } });
    expect(b.whatsNew).toBe("New since the last review: one more lead points outside the approved branches.");
    expect(b.headline).toBe("Two leads changed branches. The mapping stayed at B44.");
    expect(b.disposition).toBe("Reopened by new evidence on Nov 4. The review of Nov 2 is kept below.");
  });

  it("a reopened case someone then puts under investigation reads as that decision, not as reopened", () => {
    const reopened = { at: "2026-11-04T13:05:00.000Z", runId: 5, previous: review(), newLeads: 1, hiddenNewLeads: 0, otherNewFacts: [] };
    const investigating = review({ id: 2, disposition: "needs_investigation", owner: "engineer", ownerLabel: "Integration engineer", reviewedAt: "2026-11-05T13:05:00.000Z" });
    const b = briefCopy(view({ state: "investigating", reopenCount: 1, reopened, decision: investigating }));
    expect(b).toMatchObject({ state: "investigating", status: { label: "Needs investigation" }, disposition: "Needs investigation — owned by Integration engineer since Nov 5." });
    expect(b.whatsNew).not.toBeNull(); // still known, shown below the decision
  });

  it("scoped: a lead outside the viewer's branches is counted, never named", () => {
    const b = briefCopy(view({ leads: [], hiddenLeads: 1 }));
    expect(b.headline).toBe("One lead now points outside the approved branches. The mapping stayed at B44.");
    expect(b.detail).toBe("One lead points to a branch outside your scope. The live mapping of lsa-B44-x, read now, is still B44 (version 2), as released; no check changed it.");
    expect(JSON.stringify(b)).not.toContain("B39");
  });

  it("after a newer release replaced the mapping, the page says so (finding #4)", () => {
    const b = briefCopy(view({ change: { ...view().change, liveBranch: "B05", liveVersion: 3, liveChangeId: 3, unchanged: false } }));
    expect(b.headline).toBe("One lead changed branches. The mapping is now B05, set by change #3 after this one.");
    expect(b.detail).toContain("Change #3 replaced this change's mapping; no check changed it.");
    expect(JSON.stringify(b)).not.toContain("No ChangeGuard release made this move");
  });

  it("no lead outside the approved branches: the share at the released branch, and no 'revision' wording (finding #6)", () => {
    const b = briefCopy(view({ leads: [], latest: { ...view().latest!, atTarget: 4, total: 12, verdict: "disagrees" }, release: { atTarget: 6, total: 12 } }));
    expect(b.headline).toBe("Fewer of the campaign's leads arrive at B44: 4 of 12 now, 6 of 12 at release. The mapping stayed at B44.");
    expect(b.outcome).toContain("A change in the evidence does not show the mapping is wrong.");
    expect(b.outcome).not.toMatch(/No source revisions/);
    const arrived = briefCopy(view({ leads: [changed("W-1", null, "B12")] }));
    expect(arrived.outcome).toContain("One lead outside the approved branches does not show the mapping is wrong.");
  });

  it("the mapping itself moved: said first", () => {
    const b = briefCopy(view({ mappingMoved: true, leads: [], change: { ...view().change, liveBranch: "B12", unchanged: false } }));
    expect(b.headline).toBe("The mapping is now B12, not the B44 this change released.");
  });
});
