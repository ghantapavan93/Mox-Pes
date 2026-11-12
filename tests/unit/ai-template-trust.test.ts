import { describe, expect, it } from "vitest";
import { buildClaims, evidenceFacts, groundDraft } from "@/lib/ai/analyst";
import type { DraftFindings, Observation } from "@/lib/ai/contract";
import { evidence } from "@/lib/ai/evidence";
import { claimNumbers } from "@/lib/ai/numbers";
import { judge, type Proof } from "@/lib/ai/proof";
import { rendered, type Render } from "@/lib/ai/rendered";

/**
 * R-38: a sentence the product writes from a calculation was certified unless something in it
 * was contradicted, so a sentence with an unproved part read as verified ("supported" beside
 * "0 of 2 propositions follow"). The rule now, for every author: a claim is SUPPORTED only when
 * every figure and status it states is proved — against a metric fact, or (templates only)
 * against the field of the returned record it renders (lib/ai/rendered.ts).
 *
 * Steps are recorded tool calls exactly as runInvestigation records them.
 */

const BM = evidence.branchMetrics("B09", "oct");
const READY = ["google_search", "google_lsa", "meta", "microsoft"].map((c) => evidence.readiness("B09", "oct", c));

const STEPS = [
  {
    kind: "tool_call",
    status: "ok",
    tool: "getBranchMetrics",
    evidenceIds: [BM],
    output: { branchId: "B09", period: { key: "oct", label: "Oct" }, paidSpendCents: 100000, acquired: 6, paidAcquired: 4, unknownAcquired: 1, paidCacCents: 25000, unknownShare: 1 / 6, collectedCents: 120000, refundsCents: 5000, channels: [] },
  },
  {
    kind: "tool_call",
    status: "ok",
    tool: "getBranchMetrics",
    evidenceIds: [evidence.branchMetrics("B09", "sep")],
    output: { branchId: "B09", period: { key: "sep", label: "Sep" }, paidSpendCents: 90000, acquired: 5, paidAcquired: 3, unknownAcquired: 1, paidCacCents: 30000, unknownShare: 0.2, collectedCents: 100000, refundsCents: 0, channels: [] },
  },
  {
    kind: "tool_call",
    status: "ok",
    tool: "getMetricTrace",
    evidenceIds: [BM, "campaign:1", "campaign:2", "campaign:3", "campaign:4", "customer:501", "customer:502", "raw_event:10"],
    output: {
      scope: { branchId: "B09", period: { key: "oct" } },
      metric: { key: "paid_cac" },
      value: { matches: true, reproduced: { paidSpendCents: 100000, paidAcquired: 4, paidCacCents: 25000 } },
      campaigns: [
        { externalCampaignId: "gs-B09", spendCents: 60000, channelCode: "google_search", evidenceId: "campaign:1" },
        { externalCampaignId: "lsa-B09", spendCents: 30000, channelCode: "google_lsa", evidenceId: "campaign:2" },
        { externalCampaignId: "fb-B09", spendCents: 9000, channelCode: "meta", evidenceId: "campaign:3" },
        { externalCampaignId: "ms-B09", spendCents: 1000, channelCode: "microsoft", evidenceId: "campaign:4" },
      ],
      campaignsOmitted: 0,
      excluded: [{ code: "CAMPAIGN_UNMAPPED", count: 2, reason: "unmapped", evidenceIds: ["customer:501", "customer:502"] }],
    },
  },
  {
    kind: "tool_call",
    status: "ok",
    tool: "getDecisionReadiness",
    evidenceIds: READY,
    output: {
      branchId: "B09",
      period: "oct",
      budgetSignal: { trustworthy: true },
      channels: [
        { channelCode: "google_search", label: "Google Search", readiness: { status: "ready" } },
        { channelCode: "google_lsa", label: "Google Local Services", readiness: { status: "not_ready" } },
        { channelCode: "meta", label: "Meta", readiness: { status: "not_ready" } },
        { channelCode: "microsoft", label: "Microsoft Ads", readiness: { status: "ready" } },
      ],
    },
  },
  {
    kind: "tool_call",
    status: "ok",
    tool: "getCustomerJourney",
    evidenceIds: ["customer:415347", "lead:1", "lead:2", "lead:3"],
    output: {
      money: { collectedCents: 120000, paymentsCents: 125000, refundsCents: 5000, invoicedCents: 130000, failedOrVoidedCents: 0 },
      leads: [{ source: "calls" }, { source: "calls" }, { source: "web" }],
      flags: { pendingConflicts: 1, openExceptions: [{ id: 77, kind: "quarantined_source_records" }] },
    },
  },
];
const FACTS = evidenceFacts(STEPS);
const RETURNED = new Set(STEPS.flatMap((s) => s.evidenceIds));

const draft = (observations: Observation[]): DraftFindings => ({
  summary: "s",
  observations,
  suspectedCause: null,
  confidence: { level: "medium", why: "test" },
  recommendedNextAction: "n",
  expectedEffect: "e",
  risks: [],
  missingInformation: [],
  proposals: [],
});

const obs = (text: string, evidenceIds: string[] = [BM], renders: Render[] = []): Observation => rendered({ text, evidenceIds, status: "verified" as const }, renders);

/** The claim the analyst makes of one verified sentence, by the given author. */
function claimOf(o: Observation, origin: "template" | "model" = "template", stale?: Map<string, string>) {
  const g = groundDraft(draft([o]), RETURNED, FACTS, { origin, branchId: "B09", stale });
  const claim = buildClaims(g, FACTS).find((c) => c.text === o.text);
  return { claim, kept: g.draft.observations.find((x) => x.text === o.text) ?? null, dropped: g.report.dropped.find((x) => x.text === o.text) ?? null };
}

const campaigns: Render = { figure: "4", tool: "getMetricTrace", evidenceId: BM, path: "#campaigns + campaignsOmitted" };

describe("R-38 · a template is certified by proofs, not by being a template", () => {
  it("a compound sentence with an unproved record figure is not certified", () => {
    const { claim, kept } = claimOf(obs("B09, Oct 1–30, 2026 (UTC): paid media spend $1,000.00 across 4 campaign(s)."));
    expect(claim?.status).toBe("PARTIALLY_SUPPORTED");
    expect(claim?.reason).toMatch(/not certified: 1 of 2 propositions are proved/);
    expect(kept?.status).toBe("hypothesis");
  });

  it("the same sentence is certified once the trace field it renders is declared and matches", () => {
    const { claim } = claimOf(obs("B09, Oct 1–30, 2026 (UTC): paid media spend $1,000.00 across 4 campaign(s).", [BM], [campaigns]));
    expect(claim?.status).toBe("SUPPORTED");
    expect(claim?.proofs?.map((p) => [p.figure, p.relation, p.verdict])).toEqual([
      ["$1,000.00", "level", "VERIFIED"],
      ["4", "record", "VERIFIED"],
    ]);
    expect(claim?.reason).toMatch(/its proposition follows from the facts they cite; its record figure equals the field/);
  });

  it("a template that renders the wrong field is rejected, not certified", () => {
    const { claim, dropped } = claimOf(obs("B09, Oct 1–30, 2026 (UTC): paid media spend $1,000.00 across 4 campaign(s).", [BM], [{ ...campaigns, path: "campaignsOmitted" }]));
    expect(claim?.status).toBe("UNSUPPORTED");
    expect(dropped?.reason).toMatch(/campaignsOmitted of branch_metrics:B09:oct is 0/);
  });

  it("a verified calculation embedded in a template stays certified", () => {
    const { claim } = claimOf(obs("B09, Oct 1–30, 2026 (UTC): paid-media CAC $250.00 = $1,000.00 paid spend ÷ 4 new customers whose first evidenced touch was paid."));
    expect(claim?.status).toBe("SUPPORTED");
    expect(claim?.proofs?.every((p) => p.verdict === "VERIFIED")).toBe(true);
  });

  it("a count of readiness verdicts is proved, and a wrong count is contradicted", () => {
    const right = claimOf(obs("Decision readiness at B09: 2 of 4 paid channel(s) not ready to move budget; the budget signal is trustworthy.", READY));
    expect(right.claim?.status).toBe("SUPPORTED");
    expect(right.claim?.proofs?.map((p) => [p.figure, p.verdict])).toEqual([
      ["2 of 4", "VERIFIED"],
      ["", "VERIFIED"],
    ]);
    const wrong = claimOf(obs("Decision readiness at B09: 3 of 4 paid channel(s) not ready to move budget; the budget signal is trustworthy.", READY));
    expect(wrong.claim?.status).toBe("UNSUPPORTED");
    expect(wrong.dropped?.reason).toMatch(/2 of the 4 channel verdicts returned for B09 are not ready/);
  });

  it("a correct number with the wrong meaning is rejected: gross stated as collected", () => {
    // $1,250.00 is in the evidence (payments before refunds), but collected cash is $1,200.00.
    for (const origin of ["template", "model"] as const) {
      const { claim } = claimOf(obs("B09, Oct 1–30, 2026 (UTC): collected cash $1,250.00."), origin);
      expect(claim?.status).toBe("UNSUPPORTED");
    }
  });

  it("a wrong direction or a wrong denominator is rejected", () => {
    expect(claimOf(obs("From September to October, B09's paid-media CAC rose from $300.00 to $250.00.", [BM, evidence.branchMetrics("B09", "sep")])).claim?.status).toBe("UNSUPPORTED");
    expect(claimOf(obs("B09, Oct 1–30, 2026 (UTC): paid-media CAC $250.00 = $1,000.00 paid spend ÷ 5 new customers whose first evidenced touch was paid.")).claim?.status).toBe("UNSUPPORTED");
  });

  it("an unmeasured cause in a template sentence is rejected", () => {
    const { claim } = claimOf(obs("B09's collections rose because of the October campaigns."));
    expect(claim?.status).toBe("UNSUPPORTED");
    expect(claim?.type).toBe("CAUSAL");
  });

  it("a figure resting on a superseded source revision is rejected", () => {
    const { claim, dropped } = claimOf(obs("B09, Oct 1–30, 2026 (UTC): paid media spend $1,000.00.", [BM, "raw_event:10"]), "template", new Map([["raw_event:10", "raw_event:11"]]));
    expect(claim?.status).toBe("UNSUPPORTED");
    expect(dropped?.reason).toMatch(/superseded/);
  });

  it("another branch's or another period's figure is not certified from B09's October facts", () => {
    expect(claimOf(obs("B12, Oct 1–30, 2026 (UTC): paid media spend $1,000.00.")).claim?.status).toBe("PARTIALLY_SUPPORTED");
    expect(claimOf(obs("B09, August 2026: paid media spend $1,000.00.")).claim?.status).toBe("PARTIALLY_SUPPORTED");
  });

  it("one customer's money is certified against the journey's own fields, and a wrong field is caught", () => {
    const text = "Money: $1,200.00 collected = $1,250.00 successful payments − $50.00 refunds; $1,300.00 invoiced; $0.00 failed or voided (never counted).";
    const money = (figure: string, key: string): Render => ({ figure, tool: "getCustomerJourney", evidenceId: "customer:415347", path: `money.${key}` });
    const right = [money("$1,200.00", "collectedCents"), money("$1,250.00", "paymentsCents"), money("$50.00", "refundsCents"), money("$1,300.00", "invoicedCents"), money("$0.00", "failedOrVoidedCents")];
    expect(claimOf(obs(text, ["customer:415347"], right)).claim?.status).toBe("SUPPORTED");
    expect(claimOf(obs(text, ["customer:415347"])).claim?.status).toBe("PARTIALLY_SUPPORTED");
    const swapped = right.map((r) => (r.figure === "$1,300.00" ? { ...r, path: "money.paymentsCents" } : r));
    expect(claimOf(obs(text, ["customer:415347"], swapped)).claim?.status).toBe("UNSUPPORTED");
  });
});

describe("R-38 · what stays out of a template's reach", () => {
  it("model text cannot certify itself with a declared render", () => {
    // The declaration lives outside the draft schema the model submits; a model-written
    // observation carrying one is read as model text, and its record figure stays unproved.
    const { claim } = claimOf(obs("B09, Oct 1–30, 2026 (UTC): paid media spend $1,000.00 across 4 campaign(s).", [BM], [campaigns]), "model");
    expect(claim?.status).not.toBe("SUPPORTED");
  });

  it("a figure that only happens to appear in a record proves nothing: model text with an unrelated 2", () => {
    // The trace holds a count of 2 (customers left out of the CAC); "2 refunds" is not it.
    const { claim } = claimOf(obs("B09 had 2 refunds in October.", [BM, "customer:501"]), "model");
    expect(claim?.status).not.toBe("SUPPORTED");
  });

  it("misleading wording around a true figure is not certified (model text)", () => {
    expect(claimOf(obs("B09's paid-media CAC per paying customer was $250.00 in October."), "model").claim?.status).not.toBe("SUPPORTED");
  });

  it("a quoted record summary is a quotation: its figures are not the sentence's, even across a semicolon", () => {
    const { claim } = claimOf(obs('Exception 77 is open at B09: "31 records from calls quarantined; 12 new customers lose their lead record".', ["exception:77"].filter((id) => RETURNED.has(id)).concat([BM])));
    expect(claim?.proofs ?? []).toEqual([]);
  });

  it("a zip code or a rep's number is an identifier, not a figure", () => {
    expect(claimNumbers("Example: customer 416080 lives in zip 15147, is serviced by B07.")).toEqual([]);
    expect(claimNumbers("Customer 408245 was sold by rep 1973 on 2026-08-27.")).toEqual([]);
  });

  it("a branch id inside a campaign id is not a branch named (model text about a campaign)", () => {
    const steps = [
      {
        kind: "tool_call",
        status: "ok",
        tool: "getMetricTrace",
        evidenceIds: [evidence.branchMetrics("B44", "sep"), "campaign:9"],
        output: {
          scope: { branchId: "B44", period: { key: "sep" } },
          metric: { key: "paid_cac" },
          value: { matches: true, reproduced: { paidSpendCents: 50000, paidAcquired: 2, paidCacCents: 25000 } },
          campaigns: [{ externalCampaignId: "lsa-B44", spendCents: 50000, channelCode: "google_lsa", evidenceId: "campaign:9", paidCustomersCredited: 2 }],
          campaignsOmitted: 0,
          excluded: [],
        },
      },
    ];
    const facts = evidenceFacts(steps);
    const o = obs("In September, campaign lsa-B44 spent $500.00; campaign lsa-B44 is credited with 2 paid customer(s).", [evidence.branchMetrics("B44", "sep"), "campaign:9"]);
    const g = groundDraft(draft([o]), new Set(steps[0].evidenceIds), facts, { origin: "model", branchId: "B44" });
    expect(buildClaims(g, facts).find((c) => c.text === o.text)?.status).toBe("SUPPORTED");
  });
});

describe("R-38 · the invariant behind the UI", () => {
  it("SUPPORTED never stands beside a proposition that is not proved, whoever wrote it", () => {
    const one = (verdict: Proof["verdict"], gap: Proof["gap"]): Proof => ({
      piece: "p", figure: "1", subject: { metric: null, entity: null, period: null }, against: null, relation: "level", formula: "", inputs: [], unit: null,
      computed: null, claimed: null, qualifier: "exact", direction: null, claimedDirection: null, precision: 0, rounding: "", verdict, gap, reason: "r",
    });
    const kinds: Proof[] = [
      one("VERIFIED", null),
      one("CONTRADICTED", null),
      ...(["metric_unknown", "metric_unsupported", "fact_missing", "period_missing", "currency_unresolved", "conflicting_facts", "hypothetical", "unread", "evidence_stale", "ambiguous"] as const).map((g) => one("UNRESOLVED", g)),
    ];
    let checked = 0;
    for (const a of kinds) for (const b of kinds) for (const c of [null, ...kinds]) {
      const proofs = [a, b, ...(c ? [c] : [])];
      for (const origin of ["template", "model"] as const) {
        const j = judge(proofs, origin);
        checked += 1;
        if (j?.status === "SUPPORTED") expect(proofs.every((p) => p.verdict === "VERIFIED")).toBe(true);
      }
    }
    expect(checked).toBe(2 * 12 * 12 * 13);
  });
});
