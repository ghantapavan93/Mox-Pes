import type { Pool } from "pg";
import type { Queryable } from "@/lib/db";
import { rollupBrand, traceCash } from "@/lib/lineage/cash";
import { traceBranchMetric } from "@/lib/lineage/trace";
import { branchRows, paidCac } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { BRANCH_BY_ID } from "@/lib/reference";
import { ForbiddenError, VIEWERS } from "@/lib/viewer";
import type { BackfillReport } from "./connector";
import type { OracleResult } from "./oracle";
import type { StagePlan } from "./scenario";

/**
 * A stage's gates. Each answers one question about the twin AFTER the stage, from the product's
 * own reads (views, scorecard, traces, viewer checks) set against either the independent
 * reference (lib/twin/oracle.ts) or the state recorded before the stage. A gate that cannot be
 * decided fails: nothing is passed by default.
 *
 *   A  customer attribution   each customer's credited lead = the reference; no lead credits two customers
 *   B  lead eligibility       the calls counted as leads = the reference; no excluded call credits anyone
 *   C  duplicate delivery     a delivery sent again changes nothing and stores nothing new
 *   D  source evidence        every stored record and lead row from before is still there, unchanged
 *   E  advertising spend      unchanged to the cent, row for row
 *   F  collected cash         unchanged to the cent, row for row
 *   G  CAC explained          each CAC that moved: same spend, the reference's paid customers
 *   H  traces reproduce       each stage branch's CAC and cash traces reproduce the scorecard and the reference
 *   I  outside the stage      every branch outside the stage is exactly as before
 *   J  access                 a scoped viewer is refused another branch's and another brand's figures
 *   F1 backfill under faults  every job finished; every new record stored once and projected
 *   F2 interruption           a step that committed and was not acknowledged was resumed without a second effect
 */

export type GateId = "A" | "B" | "C" | "D" | "E" | "F" | "G" | "H" | "I" | "J" | "F1" | "F2";
export interface Gate {
  id: GateId;
  label: string;
  status: "pass" | "fail" | "not_applicable";
  detail: string;
  evidence?: Record<string, unknown>;
}

export const GATE_LABEL: Record<GateId, string> = {
  A: "No lead credits two customers; each credit matches the reference",
  B: "Excluded calls are not leads; counted calls match the reference",
  C: "Duplicate delivery has no second effect",
  D: "Historical source evidence is kept",
  E: "Company advertising spend unchanged",
  F: "Collected cash unchanged",
  G: "Every CAC change explained: same spend, the reference's paid customers",
  H: "CAC and cash traces reproduce the result",
  I: "Branches outside the stage unaffected",
  J: "Out-of-scope branch and brand access refused",
  F1: "Backfill under source faults completed and reconciled",
  F2: "Interrupted work recovered from durable state",
};

export interface BusinessRow {
  paidSpendCents: number;
  prospects: number;
  acquired: number;
  paidAcquired: number;
  unknownAcquired: number;
  collectedCents: number;
  refundsCents: number;
  newCustomerCollectedCents: number;
  paidCacCents: number | null;
}

export interface Snapshot {
  takenAt: string;
  /** How long the 44-branch scorecard query took: compared before and after, a regression check. */
  scorecardMs: number;
  branches: Record<string, BusinessRow>;
  spend: { digest: string; totalCents: number; rows: number };
  payments: { digest: string; collectedCents: number; rows: number };
  raw: { maxId: number; count: number; digest: string };
  leads: { maxId: number; rows: number };
  history: { replays: number; audit: number };
}

const num = (v: unknown) => Number(v ?? 0);

/** What the gates compare against: the business figures and the stored evidence, at one moment. */
export async function takeSnapshot(db: Queryable): Promise<Snapshot> {
  const started = Date.now();
  const rows = await branchRows(db, { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: null });
  const scorecardMs = Date.now() - started;
  const branches: Record<string, BusinessRow> = {};
  for (const r of rows) {
    branches[r.branchId] = {
      paidSpendCents: r.paidSpendCents, prospects: r.prospects, acquired: r.acquired, paidAcquired: r.paidAcquired, unknownAcquired: r.unknownAcquired,
      collectedCents: r.collectedCents, refundsCents: r.refundsCents, newCustomerCollectedCents: r.newCustomerCollectedCents, paidCacCents: paidCac(r.paidSpendCents, r.paidAcquired),
    };
  }
  const spend = await db.query<{ digest: string | null; cents: string | null; n: string }>("select md5(string_agg(s::text, '|' order by s.campaign_id, s.spend_date)) as digest, sum(cost_cents) as cents, count(*) as n from ad_spend_daily s");
  const payments = await db.query<{ digest: string | null; cents: string | null; n: string }>(
    "select md5(string_agg(p::text, '|' order by p.crm_payment_id)) as digest, sum(amount_cents) filter (where status = 'successful') as cents, count(*) as n from crm_payments p",
  );
  const raw = await db.query<{ max: string | null; n: string; digest: string | null }>("select max(id) as max, count(*) as n, md5(string_agg(id::text || ':' || payload_hash, ',' order by id)) as digest from raw_events");
  const leads = await db.query<{ max: string | null; n: string }>("select max(id) as max, count(*) as n from leads");
  const history = await db.query<{ replays: string; audit: string }>("select (select count(*) from replays) as replays, (select count(*) from audit_log) as audit");
  return {
    takenAt: new Date().toISOString(),
    scorecardMs,
    branches,
    spend: { digest: spend.rows[0].digest ?? "", totalCents: num(spend.rows[0].cents), rows: num(spend.rows[0].n) },
    payments: { digest: payments.rows[0].digest ?? "", collectedCents: num(payments.rows[0].cents), rows: num(payments.rows[0].n) },
    raw: { maxId: num(raw.rows[0].max), count: num(raw.rows[0].n), digest: raw.rows[0].digest ?? "" },
    leads: { maxId: num(leads.rows[0].max), rows: num(leads.rows[0].n) },
    history: { replays: num(history.rows[0].replays), audit: num(history.rows[0].audit) },
  };
}

/** Every lead, credit and branch figure, as one digest: what a duplicate delivery must not move. */
export async function businessDigest(db: Queryable): Promise<string> {
  const { rows } = await db.query<{ leads: string | null; credit: string | null }>(
    `select (select md5(string_agg(concat_ws(',', id, effective_branch_id, channel_code, attribution_evidence, raw_event_id), '|' order by id)) from v_leads) as leads,
            (select md5(string_agg(concat_ws(',', crm_customer_id, lead_id, channel_code, initial_status), '|' order by crm_customer_id)) from v_acquisitions) as credit`,
  );
  const figures = await branchRows(db, { from: PERIODS.all.from, to: PERIODS.all.to, branchIds: null });
  return `${rows[0].leads}:${rows[0].credit}:${JSON.stringify(figures.map((r) => [r.branchId, r.prospects, r.acquired, r.paidAcquired, r.unknownAcquired, r.paidSpendCents, r.collectedCents]))}`;
}

export interface DeliverReport {
  records: number;
  byVersion: Record<string, number>;
  first: { inserted: number; duplicates: number; quarantined: number; excluded: number; projected: number };
  again: { inserted: number; duplicates: number };
  rawCountAfterFirst: number;
  rawCountAfterAgain: number;
  digestAfterFirst: string;
  digestAfterAgain: string;
}

export interface AttributionChange {
  customerId: number;
  branchId: string | null;
  fromChannel: string;
  toChannel: string;
  fromLeadBranch: string | null;
  toLeadBranch: string | null;
  paidBefore: boolean;
  paidAfter: boolean;
}

export interface Attribution {
  changed: number;
  inPeriod: number;
  paidToUnpaid: number;
  unpaidToPaid: number;
  outsideStage: number;
  sample: AttributionChange[];
}

/** The change's own effect on credit: the reference before vs after this stage's routing, on the same data. */
export function attributionChanges(prev: OracleResult, cur: OracleResult, stage: StagePlan): Attribution {
  const changes: AttributionChange[] = [];
  for (const [customer, lead] of cur.credit) {
    if (prev.credit.get(customer) === lead) continue;
    const a = prev.acquisitions.get(customer);
    const b = cur.acquisitions.get(customer);
    if (!a || !b) continue;
    changes.push({ customerId: customer, branchId: b.branchId, fromChannel: a.channelCode, toChannel: b.channelCode, fromLeadBranch: a.leadBranchId, toLeadBranch: b.leadBranchId, paidBefore: a.paid && a.inPeriod, paidAfter: b.paid && b.inPeriod });
  }
  changes.sort((x, y) => x.customerId - y.customerId);
  const counted = changes.filter((c) => cur.acquisitions.get(c.customerId)?.inPeriod);
  return {
    changed: changes.length,
    inPeriod: counted.length,
    paidToUnpaid: changes.filter((c) => c.paidBefore && !c.paidAfter).length,
    unpaidToPaid: changes.filter((c) => !c.paidBefore && c.paidAfter).length,
    outsideStage: changes.filter((c) => c.branchId !== null && !stage.branchIds.includes(c.branchId)).length,
    sample: [...changes.filter((c) => c.branchId !== null && !stage.branchIds.includes(c.branchId)), ...changes.filter((c) => c.branchId === null || stage.branchIds.includes(c.branchId))].slice(0, 40),
  };
}

export interface GateInput {
  twin: Pool;
  stage: StagePlan;
  before: Snapshot;
  after: Snapshot;
  oracle: OracleResult;
  attribution: Attribution;
  deliver: DeliverReport | null;
  backfill: BackfillReport | null;
  /** Set when this stage was interrupted and resumed. `afterStep`: the last step acknowledged before the loss. */
  resumed: null | { afterStep: string | null; reproject: Array<{ from: string; alreadyProcessed: boolean }>; redelivered: boolean };
  /** Stored records of the stage the new version could not read when re-projecting (left as the old version read them). */
  reprojectUnreadable?: number;
}

const pass = (id: GateId, detail: string, evidence?: Record<string, unknown>): Gate => ({ id, label: GATE_LABEL[id], status: "pass", detail, evidence });
const fail = (id: GateId, detail: string, evidence?: Record<string, unknown>): Gate => ({ id, label: GATE_LABEL[id], status: "fail", detail, evidence });
const dollars = (cents: number | null) => (cents === null ? "n/a" : `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`);
const BUSINESS_KEYS: Array<keyof BusinessRow> = ["paidSpendCents", "prospects", "acquired", "paidAcquired", "unknownAcquired", "collectedCents", "refundsCents", "newCustomerCollectedCents"];
/** The business figures that differ, field by field (never by serialised text: jsonb reorders keys). */
export const differences = (a: BusinessRow | undefined, b: BusinessRow | undefined) => BUSINESS_KEYS.filter((k) => (a?.[k] ?? 0) !== (b?.[k] ?? 0));

export async function evaluateGates(g: GateInput): Promise<Gate[]> {
  const { twin, stage, before, after, oracle } = g;
  const gates: Gate[] = [];
  const inStage = new Set(stage.branchIds);

  // ── A · attribution ──
  const acq = await twin.query<{ crm_customer_id: string; lead_id: string | null }>("select crm_customer_id, lead_id from v_acquisitions");
  const creditMismatch: Array<{ customerId: number; product: number | null; reference: number | null }> = [];
  const seen = new Set<number>();
  for (const r of acq.rows) {
    const customer = Number(r.crm_customer_id);
    seen.add(customer);
    const product = r.lead_id === null ? null : Number(r.lead_id);
    const reference = oracle.credit.has(customer) ? oracle.credit.get(customer)! : undefined;
    if (reference === undefined || product !== reference) creditMismatch.push({ customerId: customer, product, reference: reference ?? null });
  }
  // Both directions: a customer the reference credits that the product does not list at all.
  for (const [customer, lead] of oracle.credit) if (!seen.has(customer)) creditMismatch.push({ customerId: customer, product: null, reference: lead });
  const doubled = await twin.query<{ lead_id: string; n: string }>("select lead_id, count(*) as n from v_acquisitions where lead_id is not null group by 1 having count(*) > 1 limit 10");
  const branchMismatch: Array<{ branchId: string; product: Record<string, number>; reference: Record<string, number> }> = [];
  for (const [b, row] of Object.entries(after.branches)) {
    const ref = oracle.branches.get(b) ?? { prospects: 0, acquired: 0, paidAcquired: 0, unknownAcquired: 0 };
    const product = { prospects: row.prospects, acquired: row.acquired, paidAcquired: row.paidAcquired, unknownAcquired: row.unknownAcquired };
    if (JSON.stringify(product) !== JSON.stringify({ prospects: ref.prospects, acquired: ref.acquired, paidAcquired: ref.paidAcquired, unknownAcquired: ref.unknownAcquired })) branchMismatch.push({ branchId: b, product, reference: { ...ref } });
  }
  gates.push(
    creditMismatch.length === 0 && doubled.rowCount === 0 && branchMismatch.filter((m) => m.product.acquired !== m.reference.acquired || m.product.paidAcquired !== m.reference.paidAcquired || m.product.unknownAcquired !== m.reference.unknownAcquired).length === 0
      ? pass("A", `All ${acq.rows.length} customers are credited exactly as the reference credits them, and no lead credits more than one. ${g.attribution.changed} credit(s) moved in this stage (${g.attribution.paidToUnpaid} left a paid channel, ${g.attribution.unpaidToPaid} returned to one).`, { customers: acq.rows.length, attribution: g.attribution })
      : fail("A", `${creditMismatch.length} customer credit(s) differ from the reference; ${doubled.rowCount} lead(s) credit more than one customer; ${branchMismatch.length} branch(es) count customers differently.`, { creditMismatch: creditMismatch.slice(0, 20), doubled: doubled.rows, branchMismatch: branchMismatch.slice(0, 10) }),
  );

  // ── B · lead eligibility ──
  const counted = new Set((await twin.query<{ id: string }>("select source_lead_id as id from v_leads where source = 'calls'")).rows.map((r) => r.id));
  const excludedRows = (await twin.query<{ id: string; code: string }>("select source_lead_id as id, excluded_code as code from leads where source = 'calls' and excluded_code is not null")).rows;
  const countedButExcluded = [...counted].filter((id) => !oracle.countedCalls.has(id));
  const missing = [...oracle.countedCalls].filter((id) => !counted.has(id));
  const wrongCode = excludedRows.filter((r) => oracle.excludedCalls.has(r.id) && oracle.excludedCalls.get(r.id) !== r.code);
  const creditsExcluded = await twin.query<{ n: string }>("select count(*) as n from v_acquisitions a join leads l on l.id = a.lead_id where l.excluded_code is not null");
  const prospectMismatch = branchMismatch.filter((m) => m.product.prospects !== m.reference.prospects);
  const unreadable = await twin.query<{ n: string }>("select count(*) as n from raw_events where source = 'calls' and status = 'quarantined' and id > $1", [before.raw.maxId]);
  // A stored record the new version cannot read is left as the old version read it (re-projection
  // never drops what was counted); intake under the new version would hold it instead. The two
  // paths disagree on it, so the stage cannot pass with any (review 2026-11-12, data 3).
  const notReadable = g.reprojectUnreadable ?? 0;
  const bOk = countedButExcluded.length === 0 && missing.length === 0 && wrongCode.length === 0 && Number(creditsExcluded.rows[0].n) === 0 && prospectMismatch.length === 0 && notReadable === 0;
  gates.push(
    bOk
      ? pass("B", `${counted.size} calls are counted and ${oracle.excludedCalls.size} are excluded (outbound, spam, not a lead), exactly as the reference reads the stored records; no excluded call credits a customer; prospects match in every branch; calls@1.2 read every stored record of the stage.${Number(unreadable.rows[0].n) ? ` ${unreadable.rows[0].n} call record(s) received in this stage could not be read and are held for replay; each lead keeps its last readable version.` : ""}`, { counted: counted.size, excluded: oracle.excludedCalls.size, unreadableHeld: Number(unreadable.rows[0].n) })
      : fail("B", `${countedButExcluded.length} call(s) counted that the reference excludes, ${missing.length} not counted that it counts, ${wrongCode.length} with another reason, ${creditsExcluded.rows[0].n} customer(s) credited to an excluded call, ${prospectMismatch.length} branch(es) with other prospect counts, ${notReadable} stored record(s) calls@1.2 cannot read left as calls@1.1 counted them.`, { countedButExcluded: countedButExcluded.slice(0, 20), missing: missing.slice(0, 20), wrongCode: wrongCode.slice(0, 10), prospectMismatch: prospectMismatch.slice(0, 10), notReadable }),
  );

  // ── C · duplicates ──
  if (g.deliver) {
    const d = g.deliver;
    const ok = d.digestAfterFirst === d.digestAfterAgain && d.rawCountAfterAgain === d.rawCountAfterFirst && d.again.inserted === 0 && d.again.duplicates === d.records;
    const fromBackfill = g.backfill?.jobs.reduce((t, j) => t + (j.stats.duplicates ?? 0), 0) ?? 0;
    gates.push(
      ok && (g.backfill?.expected.storedTwice ?? 0) === 0
        ? pass("C", `The stage's ${d.records} call deliveries were sent again: the second delivery stored nothing new, counted ${d.again.duplicates} re-deliveries, and left every lead, credit and branch figure identical. The backfill re-read ${fromBackfill} records already stored, each absorbed as a duplicate.`, { deliver: d, backfillDuplicates: fromBackfill })
        : fail("C", `A repeated delivery had an effect: ${d.again.inserted} new record(s), ${d.again.duplicates} of ${d.records} counted as re-deliveries, figures ${d.digestAfterFirst === d.digestAfterAgain ? "unchanged" : "CHANGED"}; ${g.backfill?.expected.storedTwice ?? 0} backfilled record(s) stored twice.`, { deliver: d }),
    );
  } else gates.push(fail("C", "No delivery report: the duplicate check did not run."));

  // ── D · evidence ──
  const kept = await twin.query<{ n: string; digest: string | null }>("select count(*) as n, md5(string_agg(id::text || ':' || payload_hash, ',' order by id)) as digest from raw_events where id <= $1", [before.raw.maxId]);
  const leadsKept = await twin.query<{ n: string }>("select count(*) as n from leads where id <= $1", [before.leads.maxId]);
  const dOk = Number(kept.rows[0].n) === before.raw.count && kept.rows[0].digest === before.raw.digest && Number(leadsKept.rows[0].n) === before.leads.rows && after.history.replays >= before.history.replays && after.history.audit >= before.history.audit;
  gates.push(
    dOk
      ? pass("D", `All ${before.raw.count} records stored before the stage are still stored, byte for byte (digest ${before.raw.digest.slice(0, 12)}); ${after.raw.count - before.raw.count} were added. No lead row was deleted: excluded calls keep their rows and history. Replays and audit entries only grew.`, { rawBefore: before.raw.count, rawAfter: after.raw.count, leadsBefore: before.leads.rows, leadsAfter: after.leads.rows })
      : fail("D", `Stored evidence changed: ${kept.rows[0].n} of ${before.raw.count} earlier records remain${kept.rows[0].digest === before.raw.digest ? "" : ", and their contents differ"}; ${leadsKept.rows[0].n} of ${before.leads.rows} lead rows remain.`),
  );

  // ── E · spend ──
  gates.push(
    after.spend.digest === before.spend.digest && after.spend.totalCents === before.spend.totalCents
      ? pass("E", `Company advertising spend is ${dollars(after.spend.totalCents)} before and after, across the same ${after.spend.rows} campaign-days, row for row.`)
      : fail("E", `Spend changed: ${dollars(before.spend.totalCents)} → ${dollars(after.spend.totalCents)} (${before.spend.rows} → ${after.spend.rows} rows).`),
  );

  // ── F · cash ──
  const cashMoved = Object.keys(after.branches).filter((b) => after.branches[b].collectedCents !== before.branches[b]?.collectedCents || after.branches[b].refundsCents !== before.branches[b]?.refundsCents);
  gates.push(
    after.payments.digest === before.payments.digest && cashMoved.length === 0
      ? pass("F", `Collected cash is ${dollars(after.payments.collectedCents)} before and after, over the same ${after.payments.rows} payment rows; no branch's collected or refunded total moved. The stage delivered no payment record.`)
      : fail("F", `Cash changed though the stage delivered no payment: ${dollars(before.payments.collectedCents)} → ${dollars(after.payments.collectedCents)}; branches ${cashMoved.join(", ") || "none"}.`),
  );

  // ── G · CAC explained ──
  // For a calls-only change the numerator must not move (E proves spend row for row) and the
  // denominator must be the reference's paid customers (A); the CAC is then recomputed here,
  // in integer cents, not with the scorecard's function. G does NOT re-derive spend from the ad
  // payloads: it relies on E for that (review 2026-11-12, financial 4).
  // Definition v4: no CAC without paid customers, nor with no spend counted for them.
  const cacOf = (spend: number, paid: number) => (paid > 0 && spend > 0 ? Math.floor((2 * spend + paid) / (2 * paid)) : null);
  const moved = Object.keys(after.branches).filter((b) => after.branches[b].paidCacCents !== before.branches[b]?.paidCacCents);
  const unexplained = Object.keys(after.branches).filter((b) => {
    const a = after.branches[b];
    const ref = oracle.branches.get(b);
    return a.paidSpendCents !== before.branches[b]?.paidSpendCents || (ref?.paidAcquired ?? 0) !== a.paidAcquired || a.paidCacCents !== cacOf(before.branches[b]?.paidSpendCents ?? 0, ref?.paidAcquired ?? 0);
  });
  gates.push(
    unexplained.length === 0
      ? pass("G", moved.length === 0 ? "No branch's paid CAC moved." : `Paid CAC moved in ${moved.length} branch(es): ${moved.map((b) => `${b} ${dollars(before.branches[b]?.paidCacCents ?? null)} → ${dollars(after.branches[b].paidCacCents)} (spend ${dollars(after.branches[b].paidSpendCents)} unchanged; paid customers ${before.branches[b]?.paidAcquired ?? 0} → ${after.branches[b].paidAcquired}, as the reference counts)`).join("; ")}.`, { moved })
      : fail("G", `CAC moved without the right explanation in ${unexplained.join(", ")}: its spend moved, or its paid customers differ from the reference.`, { unexplained }),
  );

  // ── H · traces ── (four branches at a time: each trace reads on its own pool connections)
  const traceFailures: string[] = [];
  const queue = [...stage.branchIds];
  const traceOne = async (b: string) => {
    const t = await traceBranchMetric(twin, VIEWERS.marketing, { branchId: b, period: PERIODS.all, metric: "paid_cac" });
    if (!t.value.matches) traceFailures.push(`${b} CAC trace: ${t.value.discrepancies.join(" ")}`);
    if (t.value.reproduced.paidAcquired !== (oracle.branches.get(b)?.paidAcquired ?? 0)) traceFailures.push(`${b} CAC trace lists ${t.value.reproduced.paidAcquired} paid customers; the reference counts ${oracle.branches.get(b)?.paidAcquired ?? 0}`);
    const c = await traceCash(twin, VIEWERS.marketing, { branchId: b, period: PERIODS.all });
    if (!c.value.matches) traceFailures.push(`${b} cash trace: ${c.value.discrepancies.join(" ")}`);
  };
  await Promise.all(Array.from({ length: Math.min(4, queue.length) }, async () => {
    for (let b = queue.shift(); b !== undefined; b = queue.shift()) await traceOne(b);
  }));
  traceFailures.sort();
  gates.push(
    traceFailures.length === 0
      ? pass("H", `For each of the ${stage.branchIds.length} stage branch(es), the CAC trace reproduces the scorecard's spend and paid customers from the listed records and agrees with the reference, and the cash trace reproduces collected cash to the cent.`)
      : fail("H", traceFailures.slice(0, 6).join(" "), { traceFailures }),
  );

  // ── I · outside the stage ──
  // Totals can hide a move (a customer's channel changes, the branch's counts do not), so a
  // customer of a branch outside the stage whose credit the change moves fails the gate too
  // (review 2026-11-12, financial 3).
  const outside = Object.keys(after.branches).filter((b) => !inStage.has(b));
  const movedOutside = outside.filter((b) => differences(before.branches[b], after.branches[b]).length > 0);
  const crossings = g.attribution.sample.filter((c) => c.branchId !== null && !inStage.has(c.branchId));
  const crossedBranches = [...new Set(crossings.map((c) => c.branchId!))].filter((b) => !movedOutside.includes(b));
  gates.push(
    outside.length === 0
      ? pass("I", "Every branch is in this stage: there is no branch outside it.")
      : movedOutside.length === 0 && g.attribution.outsideStage === 0
        ? pass("I", `All ${outside.length} branches outside the stage report exactly what they reported before it, figure for figure, and none of their customers' credits moved, though the stage also delivered records to them (read with calls@1.1).`, { outside: outside.length })
        : fail("I", `A branch outside the stage changed: ${[
            ...movedOutside.map((b) => `${b} (brand ${BRANCH_BY_ID.get(b)?.brandId}: ${differences(before.branches[b], after.branches[b]).map((k) => `${k} ${before.branches[b]?.[k]} → ${after.branches[b][k]}`).join(", ")})`),
            ...crossedBranches.map((b) => `${b} (brand ${BRANCH_BY_ID.get(b)?.brandId}: a customer's credited channel moved; its totals did not)`),
          ].join("; ")}. ${g.attribution.outsideStage} customer credit(s) outside the stage moved because a call tagged to a stage branch was their first touch.`, { movedOutside, crossings }),
  );

  // ── J · access ──
  const refusals: string[] = [];
  const allowed: string[] = [];
  const expectRefusal = async (what: string, run: () => Promise<unknown>) => {
    try {
      await run();
      refusals.push(`NOT REFUSED: ${what}`);
    } catch (error) {
      if (error instanceof ForbiddenError) allowed.push(what);
      else throw error;
    }
  };
  const other = stage.branchIds.find((b) => b !== VIEWERS.partner.branchIds![0]) ?? "B01";
  await expectRefusal(`partner (${VIEWERS.partner.branchIds!.join(", ")}) reading ${other}'s CAC trace`, () => traceBranchMetric(twin, VIEWERS.partner, { branchId: other, period: PERIODS.all, metric: "paid_cac" }));
  const foreign = stage.branchIds.find((b) => !VIEWERS.brand.branchIds!.includes(b)) ?? "B01";
  await expectRefusal(`brand lead (${VIEWERS.brand.brandIds!.join(", ")}) reading ${foreign}'s cash trace`, () => traceCash(twin, VIEWERS.brand, { branchId: foreign, period: PERIODS.all }));
  await expectRefusal(`brand lead (${VIEWERS.brand.brandIds!.join(", ")}) rolling up brand moxie`, () => rollupBrand(twin, VIEWERS.brand, { brandId: "moxie", period: PERIODS.all }));
  const own = stage.branchIds.find((b) => VIEWERS.brand.branchIds!.includes(b));
  let control = "no stage branch belongs to the brand lead's brand";
  if (own) {
    await traceCash(twin, VIEWERS.brand, { branchId: own, period: PERIODS.all });
    control = `the brand lead can read ${own}, its own brand's branch`;
  }
  gates.push(
    refusals.length === 0
      ? pass("J", `Refused, as they must be: ${allowed.join("; ")}. Control: ${control}.`)
      : fail("J", refusals.join("; ")),
  );

  // ── F1 · backfill under faults ──
  const bf = g.backfill;
  if (!bf) gates.push(fail("F1", "No backfill report: the backfill did not run."));
  else {
    const unfinished = bf.jobs.filter((j) => j.state !== "succeeded" && !bf.jobs.some((r) => r.retryOf === j.id && r.state === "succeeded"));
    const complete = unfinished.length === 0 && bf.expected.stored === bf.expected.records && bf.expected.projected === bf.expected.records && bf.expected.storedTwice === 0;
    const faultsSeen = Object.entries(bf.calls.byStatus).filter(([s]) => s !== "200").map(([s, n]) => `${n}× ${s}`).join(", ") || "none";
    const detail = `${bf.jobs.length} sync job(s) for ${bf.offices.length} office(s) made ${bf.calls.total} calls (source errors: ${faultsSeen}); ${bf.retriesScheduled} retr${bf.retriesScheduled === 1 ? "y" : "ies"} scheduled, ${Math.round(bf.simulatedWaitMs / 1000)} s waited (simulated)${bf.runbookRetries.length ? `, ${bf.runbookRetries.length} job(s) retried by the runbook after using up their attempts` : ""}${bf.workerDeath ? `; a worker died after committing ${bf.workerDeath.committedBatches} batch(es) of job ${bf.workerDeath.jobId}, which was ${bf.workerDeath.requeued ? "re-queued after its heartbeat went stale and resumed after id " + bf.workerDeath.resumedAfterId : "never re-queued"}` : ""}. ${bf.expected.stored} of the ${bf.expected.records} new CRM records reached the ledger, each once.`;
    gates.push(complete ? pass("F1", detail, { backfill: bf }) : fail("F1", `${detail} Unfinished: ${unfinished.map((j) => `job ${j.id} (office ${j.officeId} ${j.entity}: ${j.state}, ${j.lastErrorKind ?? "—"})`).join(", ") || "none"}.`, { backfill: bf, unfinished }));
  }

  // ── F2 · interruption ──
  if (!g.resumed && !bf?.workerDeath) gates.push({ id: "F2", label: GATE_LABEL.F2, status: "not_applicable", detail: "Nothing was interrupted in this stage." });
  else {
    const notes: string[] = [];
    let ok = true;
    if (g.resumed) {
      notes.push(`The rollout runner was lost after acknowledging ${g.resumed.afterStep ? `the "${g.resumed.afterStep}" step` : "no step of this stage"}; a new runner resumed from the acknowledged steps and re-ran the rest.`);
      for (const r of g.resumed.reproject) {
        notes.push(`Re-projection from calls@${r.from}: ${r.alreadyProcessed ? "its idempotency key was found, and the stored result returned; nothing ran twice" : "ran for the first time on resume"}.`);
      }
      if (g.resumed.redelivered) notes.push("The deliveries the lost runner had committed were sent again and absorbed as duplicates (gate C).");
    }
    if (bf?.workerDeath) {
      const resumed = bf.jobs.find((j) => j.id === bf.workerDeath!.jobId);
      const jobOk = bf.workerDeath.requeued && resumed?.state === "succeeded";
      ok &&= jobOk;
      notes.push(`Sync job ${bf.workerDeath.jobId}: its worker died after ${bf.workerDeath.committedBatches} committed batch(es); ${jobOk ? `re-queued on a stale heartbeat and finished by another worker (attempt ${resumed?.attempts})` : "NOT recovered"}.`);
    }
    const stuck = await twin.query<{ n: string }>("select count(*) as n from sync_jobs where state = 'running'");
    if (Number(stuck.rows[0].n) > 0) {
      ok = false;
      notes.push(`${stuck.rows[0].n} sync job(s) are still marked running.`);
    }
    // The business result after recovery is checked by A and B against the reference.
    gates.push(ok ? pass("F2", `${notes.join(" ")} No job is left running; gates A–H checked the state that recovery produced.`) : fail("F2", notes.join(" ")));
  }
  return gates;
}
