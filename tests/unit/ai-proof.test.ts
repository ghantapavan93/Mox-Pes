import { describe, expect, it } from "vitest";
import { metricFacts, statusFacts, type MetricFact } from "@/lib/ai/facts";
import { citedFacts, judge, proveStatement, type Proof } from "@/lib/ai/proof";
import { BRANCH_BY_ID, BRANDS } from "@/lib/reference";

/**
 * Proof-carrying claims (lib/ai/proof.ts): a statement is accepted only when each figure FOLLOWS
 * from the facts it cites — its metric, entity, period, sign and arithmetic — not when its
 * numbers merely appear in a tool output. The facts come from recorded tool steps exactly as an
 * investigation records them.
 */

const branchMetrics = (branchId: string, period: "oct" | "sep", over: Record<string, unknown> = {}) => ({
  kind: "tool_call",
  status: "ok",
  tool: "getBranchMetrics",
  evidenceIds: [`branch_metrics:${branchId}:${period}`],
  output: {
    branchId,
    branchName: branchId,
    period: { key: period, label: period },
    paidSpendCents: 482580,
    acquired: 25,
    paidAcquired: 20,
    unknownAcquired: 3,
    paidCacCents: 24129,
    unknownShare: 0.12,
    rawLeads: 90,
    prospects: 60,
    platformClaimed: 30,
    collectedCents: 10000000,
    refundsCents: 50000,
    openExceptions: 4,
    atRiskCents: 125000,
    channels: [],
    ...over,
  },
});

// October: $100,000 collected. September: $120,000 collected (the example to defeat).
const STEPS = [
  branchMetrics("B09", "oct"),
  branchMetrics("B09", "sep", { collectedCents: 12000000, paidSpendCents: 400000, paidAcquired: 20, paidCacCents: 20000, unknownShare: 0.1, acquired: 30, refundsCents: 0 }),
  branchMetrics("B12", "oct", { paidCacCents: 20000, paidSpendCents: 200000, paidAcquired: 10, collectedCents: 5000000 }),
];
const FACTS = metricFacts(STEPS);
const ALL_IDS = ["branch_metrics:B09:oct", "branch_metrics:B09:sep", "branch_metrics:B12:oct"];

function prove(text: string, ids: string[] = ALL_IDS, facts: MetricFact[] = FACTS, branchId = "B09") {
  const proofs = proveStatement(text, { branchId, facts: citedFacts(facts, ids) });
  return { proofs, model: judge(proofs, "model"), template: judge(proofs, "template") };
}

const verdicts = (proofs: Proof[]) => proofs.map((p) => p.verdict);

describe("the example to defeat: October revenue $100,000, September $120,000", () => {
  it("rejects 'October revenue increased by $20,000': the change is a decrease", () => {
    const { proofs, model } = prove("October revenue increased by $20,000.");
    expect(model?.status).toBe("UNSUPPORTED");
    expect(proofs[0]).toMatchObject({ verdict: "CONTRADICTED", relation: "change", direction: "decrease", claimedDirection: "increase", computed: -20000 });
    expect(proofs[0].formula).toBe("v(collected, B09, oct) − v(collected, B09, sep)");
    expect(proofs[0].inputs.map((i) => [i.period, i.value])).toEqual([["oct", 10000000], ["sep", 12000000]]);
  });

  it("accepts the true statement, with its proof", () => {
    const { proofs, model } = prove("October revenue decreased by $20,000 from September.");
    expect(model?.status).toBe("SUPPORTED");
    expect(proofs[0]).toMatchObject({ verdict: "VERIFIED", direction: "decrease", against: { entity: "B09", period: "sep" } });
  });

  it("checks both levels and the direction of 'from $120,000 to $100,000'", () => {
    expect(prove("B09 collections fell from $120,000 to $100,000.").model?.status).toBe("SUPPORTED");
    expect(prove("B09 collections rose from $120,000 to $100,000.").model?.status).toBe("UNSUPPORTED");
    expect(verdicts(prove("B09 collections fell from $120,000 to $110,000.").proofs)).toEqual(["VERIFIED", "CONTRADICTED"]);
  });

  it("checks a direction stated with no figure", () => {
    expect(prove("October revenue increased compared with September.").proofs[0]).toMatchObject({ relation: "direction", verdict: "CONTRADICTED" });
    expect(prove("October revenue declined compared with September.").model?.status).toBe("SUPPORTED");
  });

  it("checks a relative change", () => {
    expect(prove("Collected cash fell 16.7% from September.").model?.status).toBe("SUPPORTED");
    expect(prove("Collected cash fell 20% from September.").model?.status).toBe("UNSUPPORTED");
  });
});

describe("the fourteen ways a figure can be wrong", () => {
  it("A · wrong entity: a campaign's figure attributed to another campaign", () => {
    const trace = {
      kind: "tool_call",
      status: "ok",
      tool: "getMetricTrace",
      evidenceIds: ["branch_metrics:B09:oct", "campaign:11", "campaign:12"],
      output: {
        scope: { branchId: "B09", period: { key: "oct" } },
        value: { reproduced: { paidSpendCents: 482580, paidAcquired: 20, paidCacCents: 24129 }, matches: true },
        campaigns: [
          { externalCampaignId: "G-100", spendCents: 300000, assumedCurrencyCents: 0 },
          { externalCampaignId: "M-200", spendCents: 182580, assumedCurrencyCents: 0 },
        ],
        campaignsOmitted: 0,
      },
    };
    const facts = metricFacts([trace]);
    expect(prove("Campaign G-100 spent $3,000 in October.", ["campaign:11"], facts).model?.status).toBe("SUPPORTED");
    expect(prove("Campaign M-200 spent $3,000 in October.", ["campaign:12"], facts).model?.status).toBe("UNSUPPORTED");
  });

  it("B · wrong branch: B12's figure stated as B09's, or a branch the evidence does not cover", () => {
    expect(prove("B09's October paid CAC is $200.00.").model?.status).toBe("UNSUPPORTED");
    expect(prove("B12's October paid CAC is $200.00.").model?.status).toBe("SUPPORTED");
    const other = prove("B40's October paid CAC is $241.29.");
    expect(other.model?.status).toBe("UNSUPPORTED");
    expect(other.proofs[0].gap).toBe("fact_missing");
  });

  it("C · wrong period: October's value stated for September, or a period not cited", () => {
    expect(prove("B09's September paid CAC is $241.29.").model?.status).toBe("UNSUPPORTED");
    const uncited = prove("B09's September paid CAC is $200.00.", ["branch_metrics:B09:oct"]);
    expect(uncited.model?.status).toBe("UNSUPPORTED");
    expect(uncited.proofs[0].gap).toBe("period_missing");
  });

  it("D · wrong metric: the CAC figure called paid spend", () => {
    const r = prove("B09's October paid spend is $241.29.");
    expect(r.model?.status).toBe("UNSUPPORTED");
    expect(r.proofs[0]).toMatchObject({ verdict: "CONTRADICTED", subject: { metric: "paidSpend" }, computed: 4825.8 });
  });

  it("E · wrong sign: an increase stated as a decrease, and a negative change stated as positive", () => {
    expect(prove("B09's paid spend fell by $825.80 from September.").model?.status).toBe("UNSUPPORTED");
    expect(prove("B09's paid spend rose by $825.80 from September.").model?.status).toBe("SUPPORTED");
    expect(prove("B09's October collections changed by $20,000 compared with September.").model?.status).toBe("SUPPORTED");
    expect(prove("B09's October collections changed by −$20,000 compared with September.").model?.status).toBe("SUPPORTED");
    expect(prove("B09's paid spend changed by −$825.80 from September.").model?.status).toBe("UNSUPPORTED");
  });

  it("F · wrong arithmetic: the division does not give the result, or an operand is not a cited fact", () => {
    const right = prove("B09's October paid CAC is $241.29 ($4,825.80 ÷ 20 paid customers).");
    expect(right.model?.status).toBe("SUPPORTED");
    expect(right.proofs.find((p) => p.relation === "arithmetic")).toMatchObject({ verdict: "VERIFIED", formula: "$4,825.80 ÷ 20" });
    const wrong = prove("B09's October paid CAC: $4,825.80 ÷ 20 = $250.00.");
    expect(wrong.model?.status).toBe("UNSUPPORTED");
    expect(wrong.proofs.find((p) => p.relation === "arithmetic")?.reason).toMatch(/= 241\.29, not \$250\.00/);
    // Right arithmetic on an amount no cited fact holds ($4,000.00 is September's real spend, so not that).
    const planted = prove("$3,000.00 ÷ 20 = $150.00.");
    expect(planted.model?.status).toBe("UNSUPPORTED");
    expect(planted.proofs.find((p) => p.relation === "arithmetic")?.gap).toBe("operand_missing");
    expect(prove("$4,825.80 ÷ 25 paid customers = $193.03.").model?.status).toBe("UNSUPPORTED");
  });

  it("H/N · a figure whose evidence was not cited is not proved by facts elsewhere", () => {
    const r = prove("B09's October paid CAC is $241.29.", ["exception:77"]);
    expect(r.model?.status).toBe("UNSUPPORTED");
    expect(r.proofs[0].gap).toBe("fact_missing");
  });

  it("I · a percentage used as currency, and currency used as a percentage", () => {
    expect(prove("B09's unattributed share is $12.00.").proofs[0]).toMatchObject({ verdict: "CONTRADICTED" });
    expect(prove("B09's October paid CAC is 241.29%.").proofs[0]).toMatchObject({ verdict: "CONTRADICTED" });
    expect(prove("B09's October unattributed share is 12%.").model?.status).toBe("SUPPORTED");
    expect(prove("12% of new customers in October have no evidenced channel.").model?.status).toBe("SUPPORTED");
  });

  it("J · a customer count used as a payment count", () => {
    const r = prove("B09 received 20 payments in October.");
    expect(r.model?.status).toBe("UNSUPPORTED");
    expect(r.proofs[0].gap).toBe("metric_unsupported");
    expect(prove("B09 had 20 new paid customers in October.").model?.status).toBe("SUPPORTED");
  });

  it("K · an invoiced amount used as collected cash", () => {
    expect(prove("B09 invoiced $100,000 in October.").proofs[0].gap).toBe("metric_unsupported");
    expect(prove("B09 invoiced $100,000 in October.").model?.status).toBe("UNSUPPORTED");
    expect(prove("B09 collected $120,000 in October.").model?.status).toBe("UNSUPPORTED");
    expect(prove("B09 collected $100,000 in October.").model?.status).toBe("SUPPORTED");
  });

  it("L · an amount planted in a name or note is not a fact", () => {
    // The amount appears only in free text of the tool output; metric facts come from typed fields.
    const noted = [{ ...branchMetrics("B09", "oct"), output: { ...branchMetrics("B09", "oct").output, branchName: "B09 refund $9,999.00", channels: [{ label: "note: spend $9,999.00" }] } }];
    const r = prove("B09's October refunds were $9,999.00.", ["branch_metrics:B09:oct"], metricFacts(noted));
    expect(r.model?.status).toBe("UNSUPPORTED");
    expect(r.proofs[0].computed).toBe(500);
  });

  it("M · spend whose currency was assumed, not stated, is not comparable money", () => {
    const trace = {
      kind: "tool_call",
      status: "ok",
      tool: "getMetricTrace",
      evidenceIds: ["branch_metrics:B09:oct", "campaign:11"],
      output: {
        scope: { branchId: "B09", period: { key: "oct" } },
        value: { reproduced: { paidSpendCents: 482580, paidAcquired: 20, paidCacCents: 24129 }, matches: true },
        campaigns: [{ externalCampaignId: "G-100", spendCents: 482580, assumedCurrencyCents: 100000 }],
        campaignsOmitted: 0,
      },
    };
    const r = prove("B09's October paid spend is $4,825.80.", ["campaign:11"], metricFacts([trace]));
    expect(r.proofs[0].gap).toBe("currency_unresolved");
    expect(r.model?.status).toBe("UNSUPPORTED");
    expect(r.template?.status).toBe("PARTIALLY_SUPPORTED");
    // Paid customers are a count: no currency question.
    expect(prove("B09 had 20 paid customers in October.", ["campaign:11"], metricFacts([trace])).model?.status).toBe("SUPPORTED");
  });
});

describe("channels, groups, brands, ratios and status", () => {
  // B05 October: Google Search $1,400.00 / 7 customers; Local Services $600.00 / 3; Meta $0 / 2.
  const b05 = branchMetrics("B05", "oct", {
    paidSpendCents: 200000,
    paidAcquired: 10,
    paidCacCents: 20000,
    acquired: 12,
    channels: [
      { channelCode: "google_search", label: "Google Search", isPaid: true, spendCents: 140000, acquired: 7, cacCents: 20000, prospects: 20 },
      { channelCode: "google_lsa", label: "Google Local Services", isPaid: true, spendCents: 60000, acquired: 3, cacCents: 20000, prospects: 8 },
      { channelCode: "meta", label: "Meta", isPaid: true, spendCents: 0, acquired: 2, cacCents: null, prospects: 4 },
    ],
  });
  b05.evidenceIds = ["branch_metrics:B05:oct", "channel_metrics:B05:oct:google_search", "channel_metrics:B05:oct:google_lsa", "channel_metrics:B05:oct:meta"];
  const b06 = branchMetrics("B06", "oct", { paidSpendCents: 100000, paidAcquired: 5, paidCacCents: 20000, acquired: 6 });
  const b05sep = branchMetrics("B05", "sep", { paidSpendCents: 100000, paidAcquired: 10, paidCacCents: 10000 });
  const facts = metricFacts([b05, b06, b05sep]);
  const ids = [...b05.evidenceIds, "branch_metrics:B06:oct", "branch_metrics:B05:sep"];
  const p = (text: string, branch = "B05") => prove(text, ids, facts, branch);

  it("reads a channel's figures by its name or alias, and the channel named right after a figure", () => {
    expect(p("At B05 in October, Local Services cost $200.00 per new customer.").model?.status).toBe("SUPPORTED");
    expect(p("B05 spent $600.00 on Local Services in October.").model?.status).toBe("SUPPORTED");
    expect(p("B05's October spend of $2,000.00 included $1,400.00 on Google Search.").model?.status).toBe("SUPPORTED");
    expect(p("B05's October spend included $1,400.00 on Local Services.").model?.status).toBe("UNSUPPORTED");
  });

  it("compares two channels of one branch", () => {
    expect(p("B05's Local Services spend ($600.00) was $800.00 less than its Google Search spend ($1,400.00) in October.").model?.status).toBe("SUPPORTED");
    expect(p("B05's Local Services spend was $800.00 more than its Google Search spend in October.").model?.status).toBe("UNSUPPORTED");
  });

  it("checks a channel's share of the branch's metric", () => {
    expect(p("Google Search was 70% of B05's October paid media spend.").model?.status).toBe("SUPPORTED");
    expect(p("Local Services was 30% ($600.00) of B05's $2,000.00 of October paid media spend.").model?.status).toBe("SUPPORTED");
    expect(p("Google Search was 60% of B05's October paid media spend.").model?.status).toBe("UNSUPPORTED");
  });

  it("totals several named branches, and needs every one cited", () => {
    expect(p("B05 and B06 together spent $3,000.00 on paid media in October.").model?.status).toBe("SUPPORTED");
    expect(p("B05 and B06 together serviced 18 new customers in October.").model?.status).toBe("SUPPORTED");
    // CAC over both is summed spend ÷ summed paid customers ($3,000 ÷ 15), not the average of $200 and $200.
    expect(p("B05 and B06 together had a paid-media CAC of $200.00 in October.").model?.status).toBe("SUPPORTED");
    expect(prove("B05 and B06 together spent $3,000.00 on paid media in October.", ["branch_metrics:B05:oct"], facts, "B05").proofs[0].gap).toBe("fact_missing");
  });

  it("totals both months together", () => {
    expect(p("Across September and October together, B05's paid media spend was $3,000.00.").model?.status).toBe("SUPPORTED");
    expect(p("Across September and October together, B05's paid-media CAC was $150.00.").model?.status).toBe("SUPPORTED");
  });

  it("checks a multiple between two periods", () => {
    expect(p("B05's October paid-media CAC is twice its September CAC.").model?.status).toBe("SUPPORTED");
    expect(p("B05's October paid-media CAC is three times its September CAC.").model?.status).toBe("UNSUPPORTED");
  });

  it("checks brand membership and needs every branch of a brand for a brand total", () => {
    const brandOf = (id: string) => BRANCH_BY_ID.get(id)?.brandId;
    const own = BRANDS.find((b) => b.id === brandOf("B05"))!;
    const otherBrand = BRANDS.find((b) => b.id !== own.id)!;
    expect(p(`B05's October spend is ${own.name.split(" ")[0]} brand spend.`).proofs.find((x) => x.relation === "membership")?.verdict).toBe("VERIFIED");
    expect(p(`B05's October spend is ${otherBrand.name.split(" ")[0].replace(/'s$/, "")} brand spend.`).model?.status).toBe("UNSUPPORTED");
    const r = prove(`${own.name} spent $3,000.00 on paid media in October.`, ids, facts, "B05");
    expect(r.proofs[0].gap).toBe("fact_missing");
  });

  it("reads number words and zero words", () => {
    expect(p("B05 had two more new customers in October than in September.").model?.status).toBe("UNSUPPORTED");
    // 12 in October against 25 in September: a decrease of 13, not 2 more.
    expect(p("B05 had 2 more new customers in October than in September.").proofs[0]).toMatchObject({ verdict: "CONTRADICTED", direction: "decrease", computed: -13 });
    expect(p("Meta spent nothing at B05 in October.").model?.status).toBe("SUPPORTED");
    expect(p("B05 spent nothing on paid media in September.").model?.status).toBe("UNSUPPORTED");
  });

  it("refuses a company-wide superlative from part of the company", () => {
    expect(p("At $200.00, B05 has the lowest paid-media CAC in the company.").proofs.find((x) => x.figure === "lowest")?.gap).toBe("fact_missing");
  });

  it("treats a judgement of effectiveness as unproved", () => {
    expect(p("Google Search is a more effective channel than Local Services at B05.").model?.status).toBe("UNSUPPORTED");
  });

  it("withholds a number two tools disagree about", () => {
    const trace = { kind: "tool_call", status: "ok", tool: "getMetricTrace", evidenceIds: ["branch_metrics:B05:oct"], output: { scope: { branchId: "B05", period: { key: "oct" } }, value: { reproduced: { paidSpendCents: 200000, paidAcquired: 8, paidCacCents: 25000 }, matches: true }, campaigns: [], campaignsOmitted: 0 } };
    const r = prove("B05's October paid-media CAC is $200.00.", ["branch_metrics:B05:oct"], metricFacts([b05, trace]));
    expect(r.proofs[0].gap).toBe("conflicting_facts");
    expect(r.model?.status).toBe("UNSUPPORTED");
  });

  it("a figure right as stored but leaving held records out is a limitation in model text, kept in a template", () => {
    const held = branchMetrics("B05", "oct", { paidSpendCents: 60000, paidAcquired: 2, paidCacCents: 30000, paidAcquiredHeldOut: 3 });
    const r = prove("B05's October paid-media CAC is $300.00.", ["branch_metrics:B05:oct"], metricFacts([held]));
    expect(r.proofs[0]).toMatchObject({ verdict: "VERIFIED" });
    expect(r.proofs[0].inputs[0].incompleteReason).toMatch(/3 paid customer\(s\) credited to campaigns whose spend is held/);
    expect(r.model).toMatchObject({ status: "PARTIALLY_SUPPORTED", reason: expect.stringMatching(/correct as stored, but 3 paid customer/) });
    expect(r.template?.status).toBe("SUPPORTED");
  });

  it("checks readiness, the budget signal and completeness against what the tools said", () => {
    const readiness = {
      kind: "tool_call",
      status: "ok",
      tool: "getDecisionReadiness",
      evidenceIds: ["readiness:B05:oct:google_search"],
      output: { branchId: "B05", period: "oct", budgetSignal: { trustworthy: false }, channels: [{ channelCode: "google_search", label: "Google Search", readiness: { status: "not_ready" } }] },
    };
    const stale = { kind: "tool_call", status: "ok", tool: "getIngestionFailures", evidenceIds: [], output: { streams: [{ stream: "crm.payment", source: "crm", lastRunStatus: "succeeded", hoursSinceSuccess: 300, staleAfterHours: 48 }] } };
    const status = statusFacts([readiness, stale]);
    const q = (text: string) => {
      const proofs = proveStatement(text, { branchId: "B05", facts: citedFacts(facts, ids), status });
      return judge(proofs, "model")?.status;
    };
    expect(q("Google Search is decision-ready at B05 for October.")).toBe("UNSUPPORTED");
    expect(q("Google Search is not decision-ready at B05 for October.")).toBe("SUPPORTED");
    expect(q("B05's budget signal is trustworthy.")).toBe("UNSUPPORTED");
    expect(q("B05's payment records are complete for October.")).toBe("UNSUPPORTED");
    expect(q("B05's two October customers have not paid.")).toBe("UNSUPPORTED");
  });
});

describe("reading statements as people write them", () => {
  it("compares two branches", () => {
    expect(prove("B09's October paid CAC of $241.29 is higher than B12's $200.00.").model?.status).toBe("SUPPORTED");
    expect(prove("B09's October paid CAC is lower than B12's.").model?.status).toBe("UNSUPPORTED");
    expect(prove("B09's October paid CAC is $41.29 higher than B12's.").model?.status).toBe("SUPPORTED");
  });

  it("honours precision and qualifiers", () => {
    expect(prove("B09's October paid CAC is $241.").model?.status).toBe("SUPPORTED");
    expect(prove("B09's October paid CAC is $242.").model?.status).toBe("UNSUPPORTED");
    expect(prove("B09's October paid spend is about $4,800.").model?.status).toBe("SUPPORTED");
    expect(prove("B09's October paid spend is $4,800.").model?.status).toBe("UNSUPPORTED");
    expect(prove("B09's October paid spend is more than $4,000.").model?.status).toBe("SUPPORTED");
    expect(prove("B09's October paid spend is less than $4,000.").model?.status).toBe("UNSUPPORTED");
    expect(prove("B09 collected $0.1M in October.").model?.status).toBe("SUPPORTED");
  });

  it("carries the subject across the pieces of one statement", () => {
    const r = prove("B09's October paid CAC is $241.29; in September it was $200.00.");
    expect(verdicts(r.proofs)).toEqual(["VERIFIED", "VERIFIED"]);
    expect(r.proofs[1].subject).toMatchObject({ metric: "paidCac", period: "sep" });
  });

  it("reads a figure by the noun next to it, not the nearest metric word", () => {
    expect(prove("B09's October paid spend of $4,825.80 bought 20 paid customers.").model?.status).toBe("SUPPORTED");
    expect(prove("B09's October paid spend of $4,825.80 bought 25 paid customers.").model?.status).toBe("UNSUPPORTED");
  });

  it("does not certify what it cannot read (model text), but keeps templates", () => {
    const r = prove("B09's paid spend came from 12 campaigns in October.");
    expect(r.proofs[0].gap).toBe("metric_unknown");
    expect(r.model?.status).toBe("PARTIALLY_SUPPORTED");
    expect(r.template?.status).toBe("SUPPORTED");
  });

  it("treats a projection as a hypothesis, not a proved figure", () => {
    const r = prove("Fixing the mapping would lower B09's CAC to $180.00.");
    expect(r.proofs[0].gap).toBe("hypothetical");
    expect(r.model?.status).toBe("PARTIALLY_SUPPORTED");
  });

  it("asks for points when a share changes by a percentage", () => {
    expect(prove("B09's unattributed share rose 2 points from September.").model?.status).toBe("SUPPORTED");
    expect(prove("B09's unattributed share rose 2% from September.").proofs[0].gap).toBe("ambiguous");
  });

  it("states no proof for a sentence without figures or directions", () => {
    expect(prove("The mapping for G-100 was changed by marketing.").model).toBeNull();
  });

  it("derives gross payments from collected plus refunds, to the cent", () => {
    expect(prove("B09 took $100,500.00 in gross payments before refunds in October.").model?.status).toBe("SUPPORTED");
    expect(prove("B09's October net collections after refunds were $100,000.00.").model?.status).toBe("SUPPORTED");
  });
});
