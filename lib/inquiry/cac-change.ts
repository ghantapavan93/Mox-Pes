import { ACTIVE_VERSION } from "@/lib/adapters/registry";
import { evidence } from "@/lib/ai/evidence";
import type { Queryable } from "@/lib/db";
import { FRESHNESS_MAX_AGE_HOURS } from "@/lib/decision/verdicts";
import { traceBranchMetric, exactDollars } from "@/lib/lineage/trace";
import { METRICS } from "@/lib/metrics/definitions";
import { branchRows, freshness } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import type { Viewer } from "@/lib/viewer";

/**
 * "Why did <branch>'s paid CAC increase?" tested as six competing hypotheses, deterministically,
 * over a bounded set of reads (one snapshot, fixed queries; nothing loops on the data):
 *
 *   H1 paid spend went up            H4 an integration stopped or held records
 *   H2 paid customers went down      H5 the metric definition changed
 *   H3 spend or leads misclassified  H6 October's conversions have not matured yet
 *
 * Each ends SUPPORTED, CONTRADICTED, UNRESOLVED or NOT_TESTABLE with the evidence it rests on,
 * the counterevidence searched for and found, and what would change the verdict. The premise
 * itself is tested first: if CAC did not increase, the question is answered as such.
 *
 * September is the comparison month and October the month asked about: the two complete months
 * the records cover (lib/period.ts).
 */

export type HypothesisStatus = "SUPPORTED" | "CONTRADICTED" | "UNRESOLVED" | "NOT_TESTABLE";
export type HypothesisCode = "H1" | "H2" | "H3" | "H4" | "H5" | "H6";

export interface EvidenceLine {
  label: string;
  value: string;
  evidenceIds: string[];
}

export interface HypothesisResult {
  code: HypothesisCode;
  statement: string;
  status: HypothesisStatus;
  summary: string;
  /** How it was tested: the rule, so a reader can check it. */
  test: string;
  evidence: EvidenceLine[];
  /** What was searched for that would cut against the verdict, and what was found. */
  counterevidence: EvidenceLine[];
  /** What new evidence would change this verdict. */
  wouldChange: string;
}

export interface CacChangeResult {
  branchId: string;
  question: string;
  periods: { from: "sep"; to: "oct" };
  premise: { holds: boolean | null; detail: string; sepCacCents: number | null; octCacCents: number | null; evidenceIds: string[] };
  /** ln(CACo/CACs) = ln(So/Ss) − ln(Po/Ps): the part of the change from spend and from paid customers. */
  decomposition: { spendShare: number; customerShare: number } | null;
  hypotheses: HypothesisResult[];
  conclusion: { status: "explained" | "partly_explained" | "unexplained" | "premise_false" | "not_testable"; text: string; drivers: HypothesisCode[] };
  whatWouldChange: string[];
  definitionVersion: string;
  reads: number;
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

/** Runs the six tests for one branch, in the caller's snapshot, as the viewer (scope-checked by the trace). */
export async function testCacChange(db: Queryable, viewer: Viewer, args: { branchId: string; now: Date }): Promise<CacChangeResult> {
  const b = args.branchId;
  let reads = 0;
  const read = async <T>(p: Promise<T>) => {
    reads++;
    return p;
  };
  const sep = PERIODS.sep;
  const oct = PERIODS.oct;
  const [sRow] = await read(branchRows(db, { from: sep.from, to: sep.to, branchIds: [b] }));
  const [oRow] = await read(branchRows(db, { from: oct.from, to: oct.to, branchIds: [b] }));
  const cac = (r: typeof sRow) => (r.paidAcquired > 0 ? Math.round(r.paidSpendCents / r.paidAcquired) : null);
  const sCac = cac(sRow);
  const oCac = cac(oRow);
  const bmIds = [evidence.branchMetrics(b, "sep"), evidence.branchMetrics(b, "oct")];
  const question = `Why did ${b}'s paid CAC increase?`;
  const definitionVersion = METRICS.paidCac.version;

  const premise: CacChangeResult["premise"] =
    sCac === null || oCac === null
      ? { holds: null, detail: `Paid CAC is not defined for ${sCac === null ? "September" : "October"} (no paid customers), so a change cannot be measured.`, sepCacCents: sCac, octCacCents: oCac, evidenceIds: bmIds }
      : { holds: oCac > sCac, detail: `Paid CAC went from ${exactDollars(sCac)} in September to ${exactDollars(oCac)} in October (${oCac > sCac ? "+" : ""}${exactDollars(oCac - sCac)}).`, sepCacCents: sCac, octCacCents: oCac, evidenceIds: bmIds };

  const decomposition =
    premise.holds && sRow.paidSpendCents > 0 && oRow.paidSpendCents > 0 && sRow.paidAcquired > 0 && oRow.paidAcquired > 0 && sCac !== oCac
      ? (() => {
          const total = Math.log((oCac as number) / (sCac as number));
          return { spendShare: Math.log(oRow.paidSpendCents / sRow.paidSpendCents) / total, customerShare: -Math.log(oRow.paidAcquired / sRow.paidAcquired) / total };
        })()
      : null;

  // ── H1 spend up ──
  const spendDelta = oRow.paidSpendCents - sRow.paidSpendCents;
  const traceOct = await read(traceBranchMetric(db, viewer, { branchId: b, period: oct, metric: "paid_cac" }));
  const traceSep = await read(traceBranchMetric(db, viewer, { branchId: b, period: sep, metric: "paid_cac" }));
  const sepByCampaign = new Map(traceSep.numerator.campaigns.map((c) => [c.externalCampaignId, c.spendCents]));
  const moves = traceOct.numerator.campaigns
    .map((c) => ({ id: c.externalCampaignId, evidenceId: c.evidenceId, delta: c.spendCents - (sepByCampaign.get(c.externalCampaignId) ?? 0) }))
    .sort((x, y) => y.delta - x.delta);
  const h1: HypothesisResult = {
    code: "H1",
    statement: "Paid media spend went up.",
    status: spendDelta > 0 ? "SUPPORTED" : "CONTRADICTED",
    summary: `Paid spend ${exactDollars(sRow.paidSpendCents)} → ${exactDollars(oRow.paidSpendCents)} (${spendDelta >= 0 ? "+" : ""}${exactDollars(spendDelta)})${decomposition ? `; about ${pct(Math.max(0, decomposition.spendShare))} of the CAC change on a log scale` : ""}.`,
    test: "SUPPORTED if October paid spend is above September's; CONTRADICTED otherwise. Size: the spend part of ln(CAC Oct / CAC Sep).",
    evidence: [
      { label: "Paid spend Sep → Oct", value: `${exactDollars(sRow.paidSpendCents)} → ${exactDollars(oRow.paidSpendCents)}`, evidenceIds: bmIds },
      ...moves.slice(0, 3).filter((m) => m.delta !== 0).map((m) => ({ label: `Campaign ${m.id}`, value: `${m.delta > 0 ? "+" : ""}${exactDollars(m.delta)}`, evidenceIds: [m.evidenceId] })),
    ],
    counterevidence: traceOct.value.matches ? [] : [{ label: "The October trace does not reproduce", value: traceOct.value.discrepancies.join(" "), evidenceIds: [evidence.branchMetrics(b, "oct")] }],
    wouldChange: "A restatement of October spend, or October spend found mapped to the wrong branch.",
  };

  // ── H2 paid customers down ──
  const paidDelta = oRow.paidAcquired - sRow.paidAcquired;
  const unknownUp = oRow.acquired > 0 && sRow.acquired > 0 && oRow.unknownAcquired / oRow.acquired > sRow.unknownAcquired / sRow.acquired;
  const h2Counter: EvidenceLine[] = [];
  if (unknownUp) h2Counter.push({ label: "Unknown-channel share rose", value: `${pct(sRow.unknownAcquired / sRow.acquired)} → ${pct(oRow.unknownAcquired / oRow.acquired)}: some paid customers may have lost their evidence, not stopped coming`, evidenceIds: bmIds });
  if (oRow.heldCampaignAcquired > 0) h2Counter.push({ label: "Customers left out with held spend", value: `${oRow.heldCampaignAcquired} paid customer(s) credited to campaigns whose spend is held at intake`, evidenceIds: [evidence.branchMetrics(b, "oct")] });
  const h2: HypothesisResult = {
    code: "H2",
    statement: "Fewer new customers came through paid channels.",
    status: paidDelta < 0 ? (h2Counter.length > 0 ? "UNRESOLVED" : "SUPPORTED") : "CONTRADICTED",
    summary: `Paid customers ${sRow.paidAcquired} → ${oRow.paidAcquired} (${paidDelta >= 0 ? "+" : ""}${paidDelta})${decomposition ? `; about ${pct(Math.max(0, decomposition.customerShare))} of the CAC change on a log scale` : ""}.${paidDelta < 0 && h2Counter.length ? " The drop may be partly missing attribution, not missing customers." : ""}`,
    test: "SUPPORTED if October has fewer paid customers than September and nothing suggests they are only unattributed or held; UNRESOLVED when the unknown share rose or customers were held out; CONTRADICTED if paid customers did not fall.",
    evidence: [{ label: "Paid customers Sep → Oct", value: `${sRow.paidAcquired} → ${oRow.paidAcquired} (of ${sRow.acquired} → ${oRow.acquired} new customers)`, evidenceIds: bmIds }],
    counterevidence: h2Counter,
    wouldChange: "Held or unattributed October customers found to be paid (a replay of held call records, a mapping fix).",
  };

  // ── H3 misclassification ──
  const gaps = await read(db.query<{ id: string; kind: string }>("select id, kind from exceptions where status = 'open' and branch_id = $1 and kind in ('channel_coverage_gap', 'branch_mismatch', 'channel_conflict') order by id limit 10", [b]));
  const oldMapper = await read(
    db.query<{ n: string }>(
      `select count(*) as n from ad_spend_daily s join campaign_branch_map m on m.campaign_id = s.campaign_id join raw_events re on re.id = s.raw_event_id
       where m.branch_id = $1 and s.spend_date >= $2::date and s.spend_date < $3::date and re.adapter_version <> $4`,
      [b, sep.from.toISOString().slice(0, 10), oct.to.toISOString().slice(0, 10), `ads@${ACTIVE_VERSION.ads}`],
    ),
  );
  const oldCount = Number(oldMapper.rows[0].n);
  const h3: HypothesisResult = {
    code: "H3",
    statement: "Spend or leads are misclassified (wrong channel or branch), so the paid figures are wrong.",
    status: gaps.rows.length > 0 ? "SUPPORTED" : oldCount > 0 ? "UNRESOLVED" : "CONTRADICTED",
    summary:
      gaps.rows.length > 0
        ? `${gaps.rows.length} open classification exception(s) at ${b} (${[...new Set(gaps.rows.map((g) => g.kind))].join(", ")}).`
        : oldCount > 0
          ? `No open classification exception, but ${oldCount} spend day(s) were classified by an older mapper than ads@${ACTIVE_VERSION.ads}.`
          : `No open classification exception, and every spend day in both months was classified by the active mapper ads@${ACTIVE_VERSION.ads}.`,
    test: "SUPPORTED if an open coverage-gap, branch-mismatch or channel-conflict exception exists at the branch; UNRESOLVED if none but some spend was classified by an older mapper; CONTRADICTED otherwise.",
    evidence: gaps.rows.map((g) => ({ label: g.kind, value: `exception ${g.id}`, evidenceIds: [evidence.exception(Number(g.id))] })),
    counterevidence: [],
    wouldChange: "A new reconciliation run finding a coverage gap or a mismatch, or a mapper comparison showing a different channel.",
  };

  // ── H4 integration stopped / records held ──
  const streams = await read(freshness(db));
  const hours = (d: Date | null) => (d ? (args.now.getTime() - new Date(d).getTime()) / 3_600_000 : Number.POSITIVE_INFINITY);
  const stale: Array<{ stream: string; lastRunStatus: string | null; lastSuccessAt: Date | null }> = streams.filter((s) => hours(s.lastSuccessAt) > FRESHNESS_MAX_AGE_HOURS || s.lastRunStatus === "failed");
  // The feeds paid CAC is built from: one with no successful run on record is missing data too.
  for (const needed of ["ads", "calls", "crm.payment"]) {
    if (!streams.some((s) => s.stream === needed)) stale.push({ stream: needed, lastRunStatus: null, lastSuccessAt: null });
  }
  const held = await read(db.query<{ id: string; records: string }>("select id, (evidence ->> 'records') as records from exceptions where status = 'open' and branch_id = $1 and kind = 'quarantined_source_records' order by id limit 10", [b]));
  const stopped = await read(
    db.query<{ ext: string; last_day: string }>(
      `select c.external_campaign_id as ext, max(s.spend_date)::text as last_day
       from ad_spend_daily s join campaign_branch_map m on m.campaign_id = s.campaign_id join ad_campaigns c on c.id = s.campaign_id
       where m.branch_id = $1 and s.spend_date >= $2::date and s.spend_date < $3::date
       group by c.external_campaign_id having max(s.spend_date) < ($3::date - 5)`,
      [b, sep.from.toISOString().slice(0, 10), oct.to.toISOString().slice(0, 10)],
    ),
  );
  const h4Evidence: EvidenceLine[] = [
    ...stale.map((s) => ({ label: `Feed ${s.stream}`, value: s.lastRunStatus === "failed" ? "last run failed" : s.lastSuccessAt === null ? "no successful run on record" : `no successful run for ${Math.round(hours(s.lastSuccessAt))} h`, evidenceIds: [] })),
    ...held.rows.map((h) => ({ label: "Held source records", value: `${h.records ?? "?"} record(s), exception ${h.id}`, evidenceIds: [evidence.exception(Number(h.id))] })),
    ...stopped.rows.map((s) => ({ label: `Campaign ${s.ext}`, value: `no spend after ${s.last_day}`, evidenceIds: [] })),
  ];
  const h4: HypothesisResult = {
    code: "H4",
    statement: "An integration stopped or held records, so October is missing data.",
    status: h4Evidence.length > 0 ? "SUPPORTED" : "CONTRADICTED",
    summary: h4Evidence.length ? `${h4Evidence.length} sign(s) of missing data: ${h4Evidence.map((e) => `${e.label} (${e.value})`).join("; ")}.` : `Every feed is fresh (within ${FRESHNESS_MAX_AGE_HOURS} h), no records are held at ${b}, and no mapped campaign's spend stops before the last five days of October.`,
    test: `SUPPORTED if a feed is stale (> ${FRESHNESS_MAX_AGE_HOURS} h since success) or failed, records are held at the branch, or a mapped campaign's spend stops more than five days before the period ends; CONTRADICTED otherwise.`,
    evidence: h4Evidence,
    counterevidence: [],
    wouldChange: "A failed run or a held batch found for October, or a campaign whose October spend arrives late.",
  };

  // ── H5 definition changed ──
  const h5: HypothesisResult = {
    code: "H5",
    statement: "The definition of paid CAC changed.",
    status: "CONTRADICTED",
    summary: `Both months are computed now, under the same definition (${definitionVersion.split(" ")[0]}): a definition change cannot create a difference between them.`,
    test: "Both periods are recomputed from stored records under the current definition; a change between them cannot come from the definition. (Whether a number reported earlier used an older version is not stored.)",
    evidence: [{ label: "Definition", value: definitionVersion, evidenceIds: [evidence.metricDefinition("paidCac")] }],
    counterevidence: [],
    wouldChange: "Comparing with a CAC that was reported earlier, under an older definition: that comparison would be between definitions, not months.",
  };

  // ── H6 immature conversions ──
  const conv = await read(
    db.query<{ month: string; leads: string; converted: string }>(
      // One pass each: the branch's paid prospects, and the prospects that became serviced customers.
      `with paid_leads as (
         select l.prospect_key, min(l.occurred_at) as first_at
         from v_leads l join channels ch on ch.code = l.channel_code and ch.is_paid
         where l.effective_branch_id = $1 and l.occurred_at >= $2 and l.occurred_at < $3 and l.prospect_key is not null
         group by l.prospect_key),
       converted as (
         select distinct coalesce(x.phone_hash, x.email_hash) as prospect_key
         from v_acquisitions a join leads x on x.id = a.lead_id
         where a.branch_id = $1 and a.initial_status = 'completed')
       select case when pl.first_at < $4 then 'sep' else 'oct' end as month, count(*) as leads, count(c.prospect_key) as converted
       from paid_leads pl left join converted c on c.prospect_key = pl.prospect_key group by 1`,
      [b, sep.from, oct.to, oct.from],
    ),
  );
  const lag = await read(
    db.query<{ median_days: string | null }>(
      `select percentile_cont(0.5) within group (order by extract(epoch from (a.initial_completed_at - l.occurred_at)) / 86400) as median_days
       from v_acquisitions a join leads l on l.id = a.lead_id
       where a.branch_id = $1 and a.initial_status = 'completed' and a.initial_completed_at >= $2 and a.initial_completed_at < $3`,
      [b, sep.from, sep.to],
    ),
  );
  const by = Object.fromEntries(conv.rows.map((r) => [r.month, { leads: Number(r.leads), converted: Number(r.converted) }]));
  const s6 = by.sep ?? { leads: 0, converted: 0 };
  const o6 = by.oct ?? { leads: 0, converted: 0 };
  const medianDays = lag.rows[0]?.median_days === null || lag.rows[0]?.median_days === undefined ? null : Number(lag.rows[0].median_days);
  let h6: HypothesisResult;
  if (s6.leads < 10 || o6.leads < 10 || medianDays === null) {
    h6 = {
      code: "H6",
      statement: "October's paid leads have not finished converting yet (period CAC, not cohort CAC).",
      status: "NOT_TESTABLE",
      summary: `Too little to compare: ${s6.leads} September and ${o6.leads} October paid prospects${medianDays === null ? ", and no September conversion to measure a lag from" : ""} (at least 10 of each are needed).`,
      test: "Needs at least 10 paid prospects in each month and a measured September lead-to-service lag.",
      evidence: [],
      counterevidence: [],
      wouldChange: "More paid prospects, or a few more weeks of October conversions.",
    };
  } else {
    const rateS = s6.converted / s6.leads;
    const rateO = o6.converted / o6.leads;
    const windowDays = 30;
    const immatureShare = Math.min(1, medianDays / windowDays);
    const supported = rateO < rateS && immatureShare >= 0.2;
    const contradicted = rateO >= rateS || immatureShare < 0.1;
    h6 = {
      code: "H6",
      statement: "October's paid leads have not finished converting yet (period CAC, not cohort CAC).",
      status: supported ? "SUPPORTED" : contradicted ? "CONTRADICTED" : "UNRESOLVED",
      summary: `Paid prospects converted ${pct(rateS)} in September (${s6.converted}/${s6.leads}) and ${pct(rateO)} so far in October (${o6.converted}/${o6.leads}); September's median lead-to-service lag is ${medianDays.toFixed(1)} days, so about ${pct(immatureShare)} of a month's leads are still inside it at month end.`,
      test: "SUPPORTED if October converts below September and at least 20% of a month's leads are still inside the September median lag at month end; CONTRADICTED if October converts as well as September or under 10% are inside the lag; UNRESOLVED otherwise.",
      evidence: [{ label: "Paid prospect conversion Sep → Oct", value: `${pct(rateS)} → ${pct(rateO)}`, evidenceIds: bmIds }],
      counterevidence: rateO < rateS && !supported ? [{ label: "Lower conversion, short lag", value: "October converts worse, but the lag is short: the drop looks real, not only timing", evidenceIds: [] }] : [],
      wouldChange: "October conversions recorded over the next weeks (re-test then): if they catch up, H6 is supported; if not, it is contradicted.",
    };
  }

  const hypotheses = [h1, h2, h3, h4, h5, h6];
  const supported = hypotheses.filter((h) => h.status === "SUPPORTED").map((h) => h.code);
  const unresolved = hypotheses.filter((h) => h.status === "UNRESOLVED" || h.status === "NOT_TESTABLE");
  const conclusion: CacChangeResult["conclusion"] =
    premise.holds === null
      ? { status: "not_testable", text: premise.detail, drivers: [] }
      : premise.holds === false
        ? { status: "premise_false", text: `${premise.detail} It did not increase, so there is no increase to explain.`, drivers: [] }
        : supported.length === 0
          ? { status: "unexplained", text: `${premise.detail} None of the six hypotheses is supported by the records.`, drivers: [] }
          : {
              status: unresolved.length ? "partly_explained" : "explained",
              text: `${premise.detail} Supported: ${supported.map((c) => `${c} (${hypotheses.find((h) => h.code === c)?.statement.replace(/\.$/, "").toLowerCase()})`).join("; ")}.${supported.some((c) => c === "H3" || c === "H4") ? " Part of the change may be measurement, not marketing." : ""}${unresolved.length ? ` Open: ${unresolved.map((h) => h.code).join(", ")}.` : ""}`,
              drivers: supported,
            };
  const whatWouldChange = hypotheses.filter((h) => h.status !== "CONTRADICTED" || h.code === "H1" || h.code === "H2").map((h) => `${h.code}: ${h.wouldChange}`);
  return { branchId: b, question, periods: { from: "sep", to: "oct" }, premise, decomposition, hypotheses, conclusion, whatWouldChange, definitionVersion, reads };
}
