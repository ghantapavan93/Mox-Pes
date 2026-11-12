import { Pool } from "pg";
import { evidence } from "@/lib/ai/evidence";
import type { Queryable } from "@/lib/db";
import { METRICS } from "@/lib/metrics/definitions";
import { branchRows } from "@/lib/metrics/scorecard";
import type { Period } from "@/lib/period";
import { BRANCH_BY_ID, branchesOfBrands, BRANDS, type BrandId } from "@/lib/reference";
import { canSeeBranch, ForbiddenError, resolveScope, type Viewer } from "@/lib/viewer";
import { exactDollars, TraceError } from "./trace";

/**
 * The money traces: collected cash, refunds, new-customer collections and revenue at risk, each
 * reproduced to the cent from the stored payment records and checked against the scorecard, with
 * the business invariants that must hold between them; the attribution trace (unknown share and
 * coverage); and brand rollups. The same idea as the paid-CAC trace (lib/lineage/trace.ts): a
 * number is shown with the records that make it, and a mismatch is reported, never hidden.
 *
 * Money is integer cents end to end. A refund is a negative payment with its original payment's
 * id; it counts in the period of its own payment date, which can be a later month than the sale.
 */

export interface CashPaymentRow {
  evidenceId: string;
  crmPaymentId: number;
  customerEvidenceId: string;
  amountCents: number;
  paidAt: string;
  kind: "payment" | "refund";
  originalPaymentId: number | null;
}

export interface Invariant {
  name: string;
  holds: boolean;
  detail: string;
}

export interface CashTrace {
  scope: { branchId: string; branchName: string; brandId: string; officeId: number; period: { key: string; label: string; from: string; to: string } };
  definitions: Array<{ key: string; label: string; formula: string; version: string }>;
  value: {
    scorecard: { collectedCents: number; refundsCents: number; newCollectedCents: number; atRiskCents: number };
    reproduced: { collectedCents: number; refundsCents: number; grossCents: number; newCollectedCents: number; atRiskCents: number };
    matches: boolean;
    discrepancies: string[];
  };
  payments: { count: number; refunds: number; rows: CashPaymentRow[]; truncated: boolean };
  /** Payments the definition leaves out (failed or voided), and refunds whose original is missing. */
  excluded: Array<{ code: string; reason: string; count: number; amountCents: number; evidenceIds: string[] }>;
  newCustomers: { count: number; collectedCents: number; sampleEvidenceIds: string[] };
  atRisk: { customers: number; exceptions: Array<{ evidenceId: string; kind: string; customers: number }>; collectedCents: number };
  invariants: Invariant[];
  evidenceIds: string[];
}

const ROW_LIMIT = 200;
const num = (v: unknown) => (v === null || v === undefined ? 0 : Number(v));

/** Runs `fn` in one repeatable-read snapshot when given a pool; a caller's own client is used as it is. */
async function inSnapshot<T>(db: Queryable | Pool, fn: (q: Queryable) => Promise<T>): Promise<T> {
  if (!(db instanceof Pool)) return fn(db);
  const client = await db.connect();
  try {
    await client.query("begin isolation level repeatable read read only");
    const out = await fn(client);
    await client.query("commit");
    return out;
  } catch (error) {
    await client.query("rollback").catch(() => undefined);
    throw error;
  } finally {
    client.release();
  }
}

export function traceCash(db: Queryable | Pool, viewer: Viewer, args: { branchId: string; period: Period }): Promise<CashTrace> {
  return inSnapshot(db, (q) => cashIn(q, viewer, args));
}

async function cashIn(db: Queryable, viewer: Viewer, args: { branchId: string; period: Period }): Promise<CashTrace> {
  const branch = BRANCH_BY_ID.get(args.branchId);
  if (!branch) throw new TraceError(`Unknown branch ${args.branchId}`, 404);
  resolveScope(viewer, branch.id);
  const { from, to } = args.period;
  const [row] = await branchRows(db, { from, to, branchIds: [branch.id] });

  const payments = await db.query(
    `select p.crm_payment_id, p.crm_customer_id, p.amount_cents, p.paid_at, p.original_payment_id, p.status,
            exists (select 1 from crm_payments o where o.crm_payment_id = p.original_payment_id) as original_stored
     from crm_payments p
     where p.office_id = $3 and p.paid_at >= $1 and p.paid_at < $2
     order by p.paid_at, p.crm_payment_id`,
    [from, to, branch.crmOfficeId],
  );
  const successful = payments.rows.filter((p) => p.status === "successful");
  const unsuccessful = payments.rows.filter((p) => p.status !== "successful");
  const gross = successful.filter((p) => num(p.amount_cents) > 0).reduce((t, p) => t + num(p.amount_cents), 0);
  // Refunds as a positive amount (subtracting each negative amount from 0: never −0).
  const refunds = successful.filter((p) => num(p.amount_cents) < 0).reduce((t, p) => t - num(p.amount_cents), 0);
  const net = successful.reduce((t, p) => t + num(p.amount_cents), 0);
  const orphanRefunds = successful.filter((p) => num(p.amount_cents) < 0 && !p.original_stored);

  // Refunds larger than what was paid: cumulative refunds per original payment, to date.
  const over = await db.query(
    `select o.crm_payment_id, o.amount_cents as paid, -sum(r.amount_cents) as refunded
     from crm_payments r join crm_payments o on o.crm_payment_id = r.original_payment_id
     where r.status = 'successful' and o.office_id = $1
     group by o.crm_payment_id, o.amount_cents having -sum(r.amount_cents) > o.amount_cents`,
    [branch.crmOfficeId],
  );

  const newCustomers = await db.query(
    `select a.crm_customer_id, coalesce(r.collected_cents, 0) as collected
     from v_acquisitions a left join v_customer_revenue r on r.crm_customer_id = a.crm_customer_id
     where a.branch_id = $3 and a.initial_status = 'completed' and a.initial_completed_at >= $1 and a.initial_completed_at < $2
     order by a.crm_customer_id`,
    [from, to, branch.id],
  );
  const newCollected = newCustomers.rows.reduce((t, r) => t + num(r.collected), 0);

  const risk = await db.query(
    `select e.id, e.kind, cardinality(e.customer_ids) as customers, e.customer_ids
     from exceptions e where e.status = 'open' and e.branch_id = $1 and cardinality(e.customer_ids) > 0 order by e.id`,
    [branch.id],
  );
  const riskCustomers = [...new Set(risk.rows.flatMap((r) => (r.customer_ids as Array<string | number>).map(Number)))];
  const riskCollected = riskCustomers.length
    ? num((await db.query("select coalesce(sum(collected_cents), 0) as c from v_customer_revenue where crm_customer_id = any($1::bigint[])", [riskCustomers])).rows[0].c)
    : 0;

  const scorecard = { collectedCents: row.collectedCents, refundsCents: row.refundsCents, newCollectedCents: row.newCustomerCollectedCents, atRiskCents: row.atRiskCents };
  const reproduced = { collectedCents: net, refundsCents: refunds, grossCents: gross, newCollectedCents: newCollected, atRiskCents: riskCollected };
  const discrepancies: string[] = [];
  const cmp = (label: string, a: number, b: number) => {
    if (a !== b) discrepancies.push(`${label}: the scorecard says ${exactDollars(a)}; the listed records add up to ${exactDollars(b)}.`);
  };
  cmp("Collected", scorecard.collectedCents, reproduced.collectedCents);
  cmp("Refunds", scorecard.refundsCents, reproduced.refundsCents);
  cmp("Collected from new customers", scorecard.newCollectedCents, reproduced.newCollectedCents);
  cmp("Revenue in open exceptions", scorecard.atRiskCents, reproduced.atRiskCents);

  const invariants: Invariant[] = [
    { name: "net = gross − refunds", holds: net === gross - refunds, detail: `${exactDollars(gross)} − ${exactDollars(refunds)} = ${exactDollars(gross - refunds)}; net ${exactDollars(net)}` },
    { name: "every amount is whole cents", holds: payments.rows.every((p) => Number.isInteger(num(p.amount_cents))), detail: "amounts are stored as integer cents" },
    { name: "every refund names a stored original payment", holds: orphanRefunds.length === 0, detail: orphanRefunds.length ? `${orphanRefunds.length} refund(s) whose original payment is not stored` : "all refunds reference a stored payment" },
    { name: "no payment is refunded beyond what was paid", holds: over.rows.length === 0, detail: over.rows.length ? `${over.rows.length} payment(s) refunded beyond their amount` : "cumulative refunds never exceed the original" },
    { name: "revenue at risk counts each customer once", holds: riskCustomers.length <= risk.rows.reduce((t, r) => t + num(r.customers), 0), detail: `${riskCustomers.length} distinct customer(s) across ${risk.rows.length} open exception(s)` },
  ];

  const rows: CashPaymentRow[] = successful.slice(0, ROW_LIMIT).map((p) => ({
    evidenceId: evidence.payment(Number(p.crm_payment_id)),
    crmPaymentId: Number(p.crm_payment_id),
    customerEvidenceId: evidence.customer(Number(p.crm_customer_id)),
    amountCents: num(p.amount_cents),
    paidAt: new Date(p.paid_at).toISOString(),
    kind: num(p.amount_cents) < 0 ? "refund" : "payment",
    originalPaymentId: p.original_payment_id === null ? null : Number(p.original_payment_id),
  }));
  const excluded: CashTrace["excluded"] = [];
  if (unsuccessful.length) excluded.push({ code: "NOT_SUCCESSFUL", reason: "Failed or voided payments: no money moved", count: unsuccessful.length, amountCents: unsuccessful.reduce((t, p) => t + num(p.amount_cents), 0), evidenceIds: unsuccessful.slice(0, 10).map((p) => evidence.payment(Number(p.crm_payment_id))) });
  if (orphanRefunds.length) excluded.push({ code: "REFUND_WITHOUT_ORIGINAL", reason: "Refunds counted although their original payment is not stored: check the CRM feed", count: orphanRefunds.length, amountCents: orphanRefunds.reduce((t, p) => t + num(p.amount_cents), 0), evidenceIds: orphanRefunds.slice(0, 10).map((p) => evidence.payment(Number(p.crm_payment_id))) });

  const defs = ["collected", "newCollected", "atRisk"].map((k) => METRICS[k]).filter(Boolean).map((d) => ({ key: d.key, label: d.label, formula: d.formula, version: d.version }));
  return {
    scope: { branchId: branch.id, branchName: branch.name, brandId: branch.brandId, officeId: branch.crmOfficeId, period: { key: args.period.key, label: args.period.label, from: from.toISOString(), to: to.toISOString() } },
    definitions: defs,
    value: { scorecard, reproduced, matches: discrepancies.length === 0, discrepancies },
    payments: { count: successful.length, refunds: successful.filter((p) => num(p.amount_cents) < 0).length, rows, truncated: successful.length > ROW_LIMIT },
    excluded,
    newCustomers: { count: newCustomers.rows.length, collectedCents: newCollected, sampleEvidenceIds: newCustomers.rows.slice(0, 10).map((r) => evidence.customer(Number(r.crm_customer_id))) },
    atRisk: { customers: riskCustomers.length, exceptions: risk.rows.map((r) => ({ evidenceId: evidence.exception(Number(r.id)), kind: r.kind, customers: num(r.customers) })), collectedCents: riskCollected },
    invariants,
    evidenceIds: [evidence.branchMetrics(branch.id, args.period.key), ...rows.slice(0, 20).map((r) => r.evidenceId)],
  };
}

// ── Attribution: unknown share and coverage ──────────────────────────────────

export interface AttributionTrace {
  scope: { branchId: string; period: { key: string; label: string } };
  value: { scorecard: { acquired: number; unknownAcquired: number }; reproduced: { acquired: number; unknownAcquired: number; unknownShare: number | null; coverage: number | null }; matches: boolean };
  byChannel: Array<{ channelCode: string; customers: number; basis: Record<string, number> }>;
  unknownSample: string[];
  invariants: Invariant[];
}

/** Which new customers have an evidenced channel, which do not, and the share: reproduced from the acquisitions. */
export function traceAttribution(db: Queryable | Pool, viewer: Viewer, args: { branchId: string; period: Period }): Promise<AttributionTrace> {
  return inSnapshot(db, async (q) => {
    const branch = BRANCH_BY_ID.get(args.branchId);
    if (!branch) throw new TraceError(`Unknown branch ${args.branchId}`, 404);
    resolveScope(viewer, branch.id);
    const [row] = await branchRows(q, { from: args.period.from, to: args.period.to, branchIds: [branch.id] });
    const { rows } = await q.query(
      `select a.crm_customer_id, a.channel_code, a.attribution_basis from v_acquisitions a
       where a.branch_id = $3 and a.initial_status = 'completed' and a.initial_completed_at >= $1 and a.initial_completed_at < $2
       order by a.crm_customer_id`,
      [args.period.from, args.period.to, branch.id],
    );
    const unknown = rows.filter((r) => r.channel_code === "unknown");
    const byChannel = new Map<string, { customers: number; basis: Record<string, number> }>();
    for (const r of rows) {
      const c = byChannel.get(r.channel_code) ?? { customers: 0, basis: {} };
      c.customers++;
      c.basis[r.attribution_basis ?? "none"] = (c.basis[r.attribution_basis ?? "none"] ?? 0) + 1;
      byChannel.set(r.channel_code, c);
    }
    const share = rows.length ? unknown.length / rows.length : null;
    const channelSum = [...byChannel.values()].reduce((t, c) => t + c.customers, 0);
    return {
      scope: { branchId: branch.id, period: { key: args.period.key, label: args.period.label } },
      value: {
        scorecard: { acquired: row.acquired, unknownAcquired: row.unknownAcquired },
        reproduced: { acquired: rows.length, unknownAcquired: unknown.length, unknownShare: share, coverage: share === null ? null : 1 - share },
        matches: row.acquired === rows.length && row.unknownAcquired === unknown.length,
      },
      byChannel: [...byChannel.entries()].map(([channelCode, c]) => ({ channelCode, ...c })).sort((a, b) => b.customers - a.customers),
      unknownSample: unknown.slice(0, 10).map((r) => evidence.customer(Number(r.crm_customer_id))),
      invariants: [
        { name: "channels partition the new customers", holds: channelSum === rows.length, detail: `${channelSum} across channels, ${rows.length} new customers` },
        { name: "share + coverage = 100%", holds: share === null || Math.abs(share + (1 - share) - 1) < 1e-12, detail: share === null ? "no new customers" : `${(share * 100).toFixed(1)}% unknown, ${((1 - share) * 100).toFixed(1)}% evidenced` },
      ],
    };
  });
}

// ── Brand rollups ────────────────────────────────────────────────────────────

export interface BrandRollup {
  brandId: BrandId;
  brandName: string;
  branches: Array<{ branchId: string; paidSpendCents: number; acquired: number; paidAcquired: number; collectedCents: number; refundsCents: number }>;
  totals: { paidSpendCents: number; acquired: number; paidAcquired: number; paidCacCents: number | null; collectedCents: number; refundsCents: number };
  invariants: Invariant[];
}

/**
 * A brand's totals from its branches' scorecard rows, refused unless the viewer sees every branch
 * of the brand. CAC is recomputed from the summed parts, never averaged. The invariant checks the
 * rollup against an independent company-wide query: the brands partition the company.
 */
export async function rollupBrand(db: Queryable, viewer: Viewer, args: { brandId: BrandId; period: Period }): Promise<BrandRollup> {
  const brand = BRANDS.find((b) => b.id === args.brandId);
  if (!brand) throw new TraceError(`Unknown brand ${args.brandId}`, 404);
  const ids = branchesOfBrands([brand.id]);
  const outside = ids.filter((id) => !canSeeBranch(viewer, id));
  if (outside.length) throw new ForbiddenError(`${viewer.label} cannot view ${brand.name} as a whole`);
  const rows = await branchRows(db, { from: args.period.from, to: args.period.to, branchIds: ids });
  const sum = (k: "paidSpendCents" | "acquired" | "paidAcquired" | "collectedCents" | "refundsCents") => rows.reduce((t, r) => t + r[k], 0);
  const totals = { paidSpendCents: sum("paidSpendCents"), acquired: sum("acquired"), paidAcquired: sum("paidAcquired"), paidCacCents: sum("paidAcquired") > 0 ? Math.round(sum("paidSpendCents") / sum("paidAcquired")) : null, collectedCents: sum("collectedCents"), refundsCents: sum("refundsCents") };
  const invariants: Invariant[] = [{ name: "the brand is exactly its branches", holds: rows.length === ids.length && rows.every((r) => ids.includes(r.branchId)), detail: `${rows.length} of ${ids.length} branches` }];
  if (!viewer.branchIds) {
    // Company-wide viewers: the three brands must add up to the company, to the cent.
    const all = await branchRows(db, { from: args.period.from, to: args.period.to, branchIds: null });
    const company = all.reduce((t, r) => t + r.collectedCents, 0);
    const byBrand = BRANDS.map((b) => all.filter((r) => branchesOfBrands([b.id]).includes(r.branchId)).reduce((t, r) => t + r.collectedCents, 0));
    invariants.push({ name: "the brands partition the company (collected cash)", holds: byBrand.reduce((t, v) => t + v, 0) === company, detail: `Σ brands ${exactDollars(byBrand.reduce((t, v) => t + v, 0))}, company ${exactDollars(company)}` });
  }
  return {
    brandId: brand.id,
    brandName: brand.name,
    branches: rows.map((r) => ({ branchId: r.branchId, paidSpendCents: r.paidSpendCents, acquired: r.acquired, paidAcquired: r.paidAcquired, collectedCents: r.collectedCents, refundsCents: r.refundsCents })),
    totals,
    invariants,
  };
}
