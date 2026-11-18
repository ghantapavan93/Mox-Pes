import { ACTIVE_VERSION } from "@/lib/adapters/registry";
import { evidence } from "@/lib/ai/evidence";
import { CURRENCY_UNSTATED } from "@/lib/currency/coverage";
import type { Queryable } from "@/lib/db";
import { FRESHNESS_MAX_AGE_HOURS } from "@/lib/decision/verdicts";
import { traceBranchMetric, exactDollars } from "@/lib/lineage/trace";
import { METRICS } from "@/lib/metrics/definitions";
import { branchRows, freshness, paidCac } from "@/lib/metrics/scorecard";
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

/** The least part of ln(CAC Oct / CAC Sep) a hypothesis must account for to count as a driver. */
export const MATERIAL_SHARE = 0.1;

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
  const cac = (r: typeof sRow) => paidCac(r.paidSpendCents, r.paidAcquired);
  const sCac = cac(sRow);
  const oCac = cac(oRow);
  // Definition v4: no CAC without paid customers, nor for paid customers with no spend counted.
  const undefinedBecause = (r: typeof sRow) => (r.paidAcquired === 0 ? "no paid customers" : "no paid-media spend is mapped to the branch for its paid customers");
  const bmIds = [evidence.branchMetrics(b, "sep"), evidence.branchMetrics(b, "oct")];
  const question = `Why did ${b}'s paid CAC increase?`;
  const definitionVersion = METRICS.paidCac.version;

  const premise: CacChangeResult["premise"] =
    sCac === null || oCac === null
      ? { holds: null, detail: `Paid CAC is not defined for ${sCac === null ? "September" : "October"} (${undefinedBecause(sCac === null ? sRow : oRow)}), so a change cannot be measured.`, sepCacCents: sCac, octCacCents: oCac, evidenceIds: bmIds }
      : { holds: oCac > sCac, detail: `Paid CAC went from ${exactDollars(sCac)} in September to ${exactDollars(oCac)} in October (${oCac > sCac ? "+" : ""}${exactDollars(oCac - sCac)}).`, sepCacCents: sCac, octCacCents: oCac, evidenceIds: bmIds };

  // ln(CAC Oct / CAC Sep) = ln(spend Oct / spend Sep) − ln(paid Oct / paid Sep), from the
  // UNROUNDED parts, so the two shares add to exactly 100%. A share can be negative (paid
  // customers rose, which lowered CAC) or above 100% (the other part pulled the other way); both
  // are shown as they are, never clamped (review 2026-11-12, financial 12 and authorization 7).
  const decomposition =
    premise.holds && sRow.paidSpendCents > 0 && oRow.paidSpendCents > 0 && sRow.paidAcquired > 0 && oRow.paidAcquired > 0
      ? (() => {
          const spendLog = Math.log(oRow.paidSpendCents / sRow.paidSpendCents);
          const customerLog = -Math.log(oRow.paidAcquired / sRow.paidAcquired);
          const total = spendLog + customerLog;
          return total === 0 ? null : { spendShare: spendLog / total, customerShare: customerLog / total };
        })()
      : null;
  const share = (v: number) => `${v >= 0 ? "" : "−"}${pct(Math.abs(v))}`;

  // ── H1 spend up ──
  const spendDelta = oRow.paidSpendCents - sRow.paidSpendCents;
  const traceOct = await read(traceBranchMetric(db, viewer, { branchId: b, period: oct, metric: "paid_cac" }));
  const traceSep = await read(traceBranchMetric(db, viewer, { branchId: b, period: sep, metric: "paid_cac" }));
  // Per campaign, over every channel row it has in either month: a campaign reclassified within
  // a month has two rows, and its delta is the sum of them (review 2026-11-12, financial 9).
  const byCampaign = new Map<string, { sep: number; oct: number; evidenceId: string }>();
  for (const [month, t] of [["sep", traceSep], ["oct", traceOct]] as const) {
    for (const c of t.numerator.campaigns) {
      const e = byCampaign.get(c.externalCampaignId) ?? { sep: 0, oct: 0, evidenceId: c.evidenceId };
      e[month] += c.spendCents;
      byCampaign.set(c.externalCampaignId, e);
    }
  }
  const moves = [...byCampaign].map(([id, e]) => ({ id, evidenceId: e.evidenceId, delta: e.oct - e.sep })).sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
  // A driver must account for a material part of the change, not merely move in its direction.
  const spendMaterial = spendDelta > 0 && (decomposition === null || decomposition.spendShare >= MATERIAL_SHARE);
  const h1: HypothesisResult = {
    code: "H1",
    statement: "Paid media spend went up.",
    status: spendMaterial ? "SUPPORTED" : "CONTRADICTED",
    summary: `Paid spend ${exactDollars(sRow.paidSpendCents)} → ${exactDollars(oRow.paidSpendCents)} (${spendDelta >= 0 ? "+" : ""}${exactDollars(spendDelta)})${decomposition ? `; ${share(decomposition.spendShare)} of the CAC change on a log scale` : ""}${spendDelta > 0 && !spendMaterial ? `, under the ${pct(MATERIAL_SHARE)} needed to count as a driver` : ""}.`,
    test: `SUPPORTED if October paid spend is above September's and accounts for at least ${pct(MATERIAL_SHARE)} of ln(CAC Oct / CAC Sep); CONTRADICTED otherwise.`,
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
  // Customers who came through a paid campaign that is mapped to no branch: they arrived, they are
  // only outside the measured count (VP acceptance VP-01).
  const unmappedOct = traceOct.excluded.find((e) => e.code === "CAMPAIGN_UNMAPPED");
  if (unmappedOct) h2Counter.push({ label: "Customers of an unmapped campaign", value: `${unmappedOct.count} paid customer(s) serviced here are credited to a campaign mapped to no branch, so they are outside the count`, evidenceIds: unmappedOct.evidenceIds.slice(0, 5) });
  const customersMaterial = paidDelta < 0 && (decomposition === null || decomposition.customerShare >= MATERIAL_SHARE);
  const h2: HypothesisResult = {
    code: "H2",
    statement: "Fewer new customers came through paid channels.",
    status: customersMaterial ? (h2Counter.length > 0 ? "UNRESOLVED" : "SUPPORTED") : "CONTRADICTED",
    summary: `Paid customers ${sRow.paidAcquired} → ${oRow.paidAcquired} (${paidDelta >= 0 ? "+" : ""}${paidDelta})${decomposition ? `; ${share(decomposition.customerShare)} of the CAC change on a log scale` : ""}${paidDelta < 0 && !customersMaterial ? `, under the ${pct(MATERIAL_SHARE)} needed to count as a driver` : ""}.${customersMaterial && h2Counter.length ? " The drop may be partly missing attribution, not missing customers." : ""}`,
    test: `SUPPORTED if October has fewer paid customers than September, accounting for at least ${pct(MATERIAL_SHARE)} of ln(CAC Oct / CAC Sep), and nothing suggests they are only unattributed or held; UNRESOLVED when the unknown share rose or customers were held out; CONTRADICTED otherwise.`,
    evidence: [{ label: "Paid customers Sep → Oct", value: `${sRow.paidAcquired} → ${oRow.paidAcquired} (of ${sRow.acquired} → ${oRow.acquired} new customers)`, evidenceIds: bmIds }],
    counterevidence: h2Counter,
    wouldChange: "Held or unattributed October customers found to be paid (a replay of held call records, a mapping fix).",
  };

  // ── H3 misclassification ──
  // Only a condition inside the two months can move their figures: a coverage gap that starts
  // before the end of October, a mismatch or conflict seen in the period (review 2026-11-12,
  // financial 8: any open exception of any age supported H3).
  const gaps = await read(
    db.query<{ id: string; kind: string }>(
      `select id, kind from exceptions
       where status = 'open' and branch_id = $1 and kind in ('channel_coverage_gap', 'branch_mismatch', 'channel_conflict')
         and coalesce((evidence ->> 'gapStart')::date, (evidence ->> 'lastOccurredAt')::timestamptz::date, last_detected_at::date) >= $2::date
         and coalesce((evidence ->> 'gapStart')::date, (evidence ->> 'firstOccurredAt')::timestamptz::date, first_detected_at::date) < $3::date
       order by id limit 10`,
      [b, sep.from.toISOString().slice(0, 10), oct.to.toISOString().slice(0, 10)],
    ),
  );
  const oldMapper = await read(
    db.query<{ n: string }>(
      `select count(*) as n from ad_spend_daily s join campaign_branch_map m on m.campaign_id = s.campaign_id join raw_events re on re.id = s.raw_event_id
       where m.branch_id = $1 and s.spend_date >= $2::date and s.spend_date < $3::date and re.adapter_version <> $4`,
      [b, sep.from.toISOString().slice(0, 10), oct.to.toISOString().slice(0, 10), `ads@${ACTIVE_VERSION.ads}`],
    ),
  );
  const oldCount = Number(oldMapper.rows[0].n);
  // Paid figures split across branch rows: October customers this branch serviced whose campaign is
  // mapped to no branch, and October customers of this branch's campaigns serviced at another
  // branch (cost on one row, customers on another). Both are misassignment, whatever exception
  // reconciliation has opened (VP acceptance, first contact: VP-01 had both and H3 said none).
  // A customer is this branch's campaign's when the lead's own record names that campaign's
  // platform (v_lead_campaigns, R-46), not when another platform's campaign shares the id.
  const crossBranch = await read(
    db.query<{ branch_id: string; n: string }>(
      `select a.branch_id, count(*) as n
       from v_acquisitions a
       join v_lead_campaigns lc on lc.lead_id = a.lead_id
       join campaign_branch_map m on m.campaign_id = lc.campaign_id
       join channels ch on ch.code = a.channel_code
       where m.branch_id = $1 and a.branch_id <> $1 and ch.is_paid
         and a.initial_status = 'completed' and a.initial_completed_at >= $2 and a.initial_completed_at < $3
       group by a.branch_id order by a.branch_id`,
      [b, oct.from, oct.to],
    ),
  );
  const splits: EvidenceLine[] = [
    ...(unmappedOct ? [{ label: "Customers credited to an unmapped campaign", value: `${unmappedOct.count} October customer(s) serviced at ${b}: their campaign's cost is in no branch`, evidenceIds: unmappedOct.evidenceIds.slice(0, 5) }] : []),
    ...crossBranch.rows.map((r) => ({ label: `${b}'s campaigns' customers serviced at ${r.branch_id}`, value: `${r.n} October customer(s): the cost is on ${b}'s row, the customers on ${r.branch_id}'s`, evidenceIds: [evidence.branchMetrics(r.branch_id, "oct")] })),
  ];
  const h3Supported = gaps.rows.length > 0 || splits.length > 0;
  const h3: HypothesisResult = {
    code: "H3",
    statement: "Spend or leads are misclassified (wrong channel or branch), so the paid figures are wrong.",
    status: h3Supported ? "SUPPORTED" : oldCount > 0 ? "UNRESOLVED" : "CONTRADICTED",
    summary: h3Supported
      ? [
          gaps.rows.length > 0 ? `${gaps.rows.length} open classification exception(s) at ${b} (${[...new Set(gaps.rows.map((g) => g.kind))].join(", ")}).` : "",
          splits.length > 0 ? `Paid figures are split across branch rows: ${splits.map((s) => `${s.label} (${s.value})`).join("; ")}.` : "",
        ].filter(Boolean).join(" ")
      : oldCount > 0
        ? `No open classification exception, but ${oldCount} spend day(s) were classified by an older mapper than ads@${ACTIVE_VERSION.ads}.`
        : `No open classification exception, no October customer credited to an unmapped campaign or serviced away from its campaign's branch, and every spend day in both months was classified by the active mapper ads@${ACTIVE_VERSION.ads}.`,
    test: "SUPPORTED if an open coverage-gap, branch-mismatch or channel-conflict exception at the branch falls in September–October, or October paid customers are split across branch rows (credited to an unmapped campaign, or serviced away from their campaign's branch); UNRESOLVED if none but some spend was classified by an older mapper; CONTRADICTED otherwise.",
    evidence: [...gaps.rows.map((g) => ({ label: g.kind, value: `exception ${g.id}`, evidenceIds: [evidence.exception(Number(g.id))] })), ...splits],
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
  const held = await read(
    db.query<{ id: string; records: string; source: string | null; last: string | null; refused: boolean; days: string | null }>(
      `select id, (evidence ->> 'records') as records, evidence ->> 'source' as source, evidence ->> 'lastOccurredAt' as last,
              (evidence ? 'spendDates') as refused, evidence ->> 'campaignDays' as days
       from exceptions where status = 'open' and branch_id = $1 and kind = 'quarantined_source_records' order by id limit 10`,
      [b],
    ),
  );
  // Spend held at intake for its currency (excluded, so no quarantine exception shows it), per
  // month, for campaigns mapped to the branch, on days with no counted version (review
  // 2026-11-12, financial 7).
  const currencyHeld = await read(
    db.query<{ month: string; days: string; cents: string }>(
      // try_date (migration 0026): a quarantined record's impossible date is no day, not an error.
      `select case when try_date(re.payload ->> 'date') < $4::date then 'sep' else 'oct' end as month,
              count(distinct (re.payload ->> 'campaignId', re.payload ->> 'date')) as days,
              coalesce(sum(round(((re.payload ->> 'costMicros')::numeric) / 10000)), 0) as cents
       from raw_events re
       join ad_campaigns c on c.platform = re.payload ->> 'platform' and c.external_campaign_id = re.payload ->> 'campaignId'
       join campaign_branch_map m on m.campaign_id = c.id
       where re.source = 'ads' and ((re.status = 'excluded' and re.exclusion_code = $5) or re.status = 'quarantined')
         and m.branch_id = $1 and try_date(re.payload ->> 'date') >= $2::date and try_date(re.payload ->> 'date') < $3::date
         and not exists (select 1 from ad_spend_daily s where s.campaign_id = c.id and s.spend_date = try_date(re.payload ->> 'date'))
       group by 1`,
      [b, sep.from.toISOString().slice(0, 10), oct.to.toISOString().slice(0, 10), oct.from.toISOString().slice(0, 10), CURRENCY_UNSTATED],
    ),
  );
  const stopped = await read(
    db.query<{ ext: string; last_day: string }>(
      `select c.external_campaign_id as ext, max(s.spend_date)::text as last_day
       from ad_spend_daily s join campaign_branch_map m on m.campaign_id = s.campaign_id join ad_campaigns c on c.id = s.campaign_id
       where m.branch_id = $1 and s.spend_date >= $2::date and s.spend_date < $3::date
       group by c.external_campaign_id having max(s.spend_date) < ($3::date - 5)`,
      [b, sep.from.toISOString().slice(0, 10), oct.to.toISOString().slice(0, 10)],
    ),
  );
  // Missing data explains an INCREASE only in one direction: October customers missing, or
  // September spend missing, raise the measured change; missing October spend or September
  // customers lower it, so they are counterevidence, not support (review 2026-11-12, financial 8).
  const feedLine = (s: (typeof stale)[number]) => (s.lastRunStatus === "failed" ? "last run failed" : s.lastSuccessAt === null ? "no successful run on record" : `no successful run for ${Math.round(hours(s.lastSuccessAt))} h`);
  const raises: EvidenceLine[] = [];
  const lowers: EvidenceLine[] = [];
  for (const s of stale) {
    if (s.stream === "ads") lowers.push({ label: `Feed ${s.stream}`, value: `${feedLine(s)}: October spend may be missing, which would LOWER October CAC`, evidenceIds: [] });
    else raises.push({ label: `Feed ${s.stream}`, value: `${feedLine(s)}: October leads or customers may be missing, which raises October CAC`, evidenceIds: [] });
  }
  for (const h of held.rows) {
    if (h.refused) {
      // A refused newer spend revision leaves its earlier amount counted: no spend is missing, and
      // which way the newer revision would move CAC is not known (EGM review 2026-11-18, K4).
      lowers.push({
        label: "Refused spend revisions",
        value: `${h.days ?? "?"} campaign-day(s), exception ${h.id}: a newer revision was refused and the earlier amount still counts, so no spend is absent; which way the newer revision would move CAC is not known`,
        evidenceIds: [evidence.exception(Number(h.id))],
      });
      continue;
    }
    const line = { label: "Held source records", value: `${h.records ?? "?"} ${h.source ?? "source"} record(s), exception ${h.id}`, evidenceIds: [evidence.exception(Number(h.id))] };
    const septemberSpend = h.source === "ads" && h.last !== null && new Date(h.last).getTime() < oct.from.getTime();
    if (h.source !== "ads" || septemberSpend) raises.push({ ...line, value: `${line.value}: ${septemberSpend ? "September spend missing lowers September CAC" : "missing leads or customers raise CAC"}` });
    else lowers.push({ ...line, value: `${line.value}: October spend missing would lower October CAC` });
  }
  for (const r of currencyHeld.rows) {
    const line = { label: `Spend held for its currency (${r.month === "sep" ? "September" : "October"})`, value: `${r.days} campaign-day(s), ${exactDollars(Number(r.cents))} as written`, evidenceIds: [] };
    if (r.month === "sep") raises.push({ ...line, value: `${line.value}: September CAC is understated, which makes the change look larger` });
    else lowers.push({ ...line, value: `${line.value}: October CAC is understated, which hides part of an increase` });
  }
  for (const s of stopped.rows) lowers.push({ label: `Campaign ${s.ext}`, value: `no spend after ${s.last_day}: stopped spend lowers CAC, so it cannot explain an increase`, evidenceIds: [] });
  const h4: HypothesisResult = {
    code: "H4",
    statement: "An integration stopped or held records, so the measured change is partly missing data.",
    status: raises.length > 0 ? "SUPPORTED" : "CONTRADICTED",
    summary: raises.length
      ? `${raises.length} sign(s) of missing data that would make CAC look higher: ${raises.map((e) => `${e.label} (${e.value})`).join("; ")}.`
      : `No sign of missing data that would make CAC look higher: every customer feed is fresh (within ${FRESHNESS_MAX_AGE_HOURS} h), no lead or customer records are held at ${b}, and no September spend is held.${lowers.length ? ` ${lowers.length} sign(s) point the other way.` : ""}`,
    test: `SUPPORTED if data is missing in the direction that raises the measured CAC: a stale or failed lead or customer feed (> ${FRESHNESS_MAX_AGE_HOURS} h since success), held lead or customer records, or September spend held at intake; CONTRADICTED otherwise. Missing October spend lowers CAC and is listed as counterevidence.`,
    evidence: raises,
    counterevidence: lowers,
    wouldChange: "A failed run or a held batch found for October leads or customers, held September spend, or late-arriving October spend.",
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
