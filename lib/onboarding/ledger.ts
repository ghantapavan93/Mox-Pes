import type { Queryable } from "@/lib/db";
import type { LeadRow, PaymentRow, SpendDayRow } from "@/lib/adapters/contract";
import { PERIODS } from "@/lib/period";
import { instantToWallTime, wallTimeToInstant } from "@/lib/primitives";
import { BRANCH_BY_OFFICE } from "@/lib/reference";
import type { RowOutcome } from "./compile";
import type { DatasetId } from "./targets";

/**
 * Compares the eligible rows of a dry run with what the ledger already holds.
 *
 * The rule a file follows: it may ADD what the ledger is missing; it may never CHANGE what the
 * ledger has. A row whose record is already in the ledger is "matches_ledger" when every
 * compared fact agrees and "differs_from_ledger" when one does not. A difference is reported,
 * fact by fact, and is never published: changing a recorded fact is a correction, and
 * corrections go through the Action Center's proposal, dry run and independent approval.
 *
 * A discrepancy is not automatically an error in either system. Compared facts are only those
 * with the same meaning and grain on both sides (one payment's amount, status, customer,
 * office and time; one campaign-day's cost, clicks and conversions).
 */

export interface FactDiff {
  fact: string;
  file: string;
  ledger: string;
}

/**
 * The ledger record a matched or differing row was compared with (release design §5.3), stored on
 * its row result so the result can link to it. `journey` is a Customer Journeys id: the CRM
 * customer id, or "P-<identity id>" for a prospect; null while the lead has no identity yet.
 */
export type LedgerTarget =
  | { kind: "lead"; leadId: number; branchId: string | null; journey: string | null }
  | { kind: "payment"; branchId: string | null; journey: string }
  | { kind: "spend_day"; branchId: string | null; channel: string; day: string };

export interface LedgerRowResult {
  row: number;
  externalId: string;
  disposition: "eligible" | "matches_ledger" | "differs_from_ledger";
  diffs: FactDiff[];
  /** Matched and differing rows only: the record they were compared with. */
  target?: LedgerTarget;
}

const mondayOf = (day: string) => {
  const d = new Date(`${day}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - ((d.getUTCDay() + 6) % 7));
  return d.toISOString().slice(0, 10);
};

/**
 * Where a ledger target opens: a lead or a payment on its journey; a spend day on its branch's
 * paid-spend trace, selected on its channel and week in the month that holds the day, or the whole
 * window when no month does. Null when there is nothing to open (a lead without an identity, a
 * campaign mapped to no branch). The caller checks the viewer may see `target.branchId`.
 */
export function ledgerHref(target: LedgerTarget): string | null {
  switch (target.kind) {
    case "lead":
      return target.journey ? `/customers/${encodeURIComponent(target.journey)}` : null;
    case "payment":
      return `/customers/${encodeURIComponent(target.journey)}`;
    case "spend_day": {
      if (!target.branchId) return null;
      const at = Date.parse(`${target.day}T00:00:00Z`);
      const month = (["sep", "oct"] as const).find((k) => PERIODS[k].from.getTime() <= at && at < PERIODS[k].to.getTime());
      const base = `/branches/${encodeURIComponent(target.branchId)}/trace`;
      if (!month) return `${base}?period=all&metric=paid_spend`;
      return `${base}?period=${month}&metric=paid_spend&channel=${encodeURIComponent(target.channel)}&week=${mondayOf(target.day)}#selection`;
    }
  }
}

export interface MoneyReconciliation {
  /** What the money column measures, in words. */
  meaning: string;
  fileTotalCents: number;
  /** File rows whose record is in the ledger: what the file says vs what the ledger says. */
  matchedFileCents: number;
  matchedLedgerCents: number;
  /** matchedFileCents - matchedLedgerCents; equals the sum of the per-row amount differences. */
  matchedDifferenceCents: number;
  /** File rows the ledger does not have. */
  notInLedgerCents: number;
  notInLedgerRows: number;
  /** Ledger records inside the file's scope (same offices or campaigns, same period) that the file lacks. */
  ledgerOnly: { rows: number; cents: number; examples: string[]; scope: string };
}

export interface LedgerComparison {
  rows: LedgerRowResult[];
  money: MoneyReconciliation | null;
  counts: { eligible: number; matches: number; differs: number };
}

const iso = (d: Date | string) => new Date(d).toISOString().replace(".000Z", "Z");
const dollars = (cents: number) => `${cents < 0 ? "-" : ""}$${(Math.abs(cents) / 100).toFixed(2)}`;

function eligibleRows(outcomes: RowOutcome[]) {
  return outcomes.filter((o): o is Extract<RowOutcome, { disposition: "eligible" }> => o.disposition === "eligible");
}

async function compareLeads(db: Queryable, source: "calls" | "web", outcomes: RowOutcome[]): Promise<LedgerComparison> {
  const rows = eligibleRows(outcomes);
  const ids = rows.map((r) => (r.projection.row as LeadRow).sourceLeadId);
  const existing = new Map(
    (
      await db.query<{
        id: string; source_lead_id: string; branch_id: string | null; channel_code: string; occurred_at: Date; campaign_external_id: string | null;
        identity_id: string | null; crm_customer_id: string | null;
      }>(
        `select l.id, l.source_lead_id, l.branch_id, l.channel_code, l.occurred_at, l.campaign_external_id, i.id as identity_id, i.crm_customer_id
         from leads l
         left join lateral (
           select i.id, i.crm_customer_id from identity_links k join identities i on i.id = k.identity_id
           where k.record_table = 'leads' and k.record_id = l.id and i.retired_at is null
           order by k.id desc limit 1
         ) i on true
         where l.source = $1 and l.source_lead_id = any($2::text[])`,
        [source, ids],
      )
    ).rows.map((r) => [r.source_lead_id, r]),
  );
  const results: LedgerRowResult[] = rows.map((r) => {
    const lead = r.projection.row as LeadRow;
    const have = existing.get(lead.sourceLeadId);
    if (!have) return { row: r.row, externalId: r.externalId, disposition: "eligible", diffs: [] };
    const diffs: FactDiff[] = [];
    if ((have.branch_id ?? "") !== (lead.branchId ?? "")) diffs.push({ fact: "branch", file: lead.branchId ?? "none", ledger: have.branch_id ?? "none" });
    if (have.channel_code !== lead.channelCode) diffs.push({ fact: "channel", file: lead.channelCode, ledger: have.channel_code });
    if (iso(have.occurred_at) !== iso(lead.occurredAt)) diffs.push({ fact: "time", file: iso(lead.occurredAt), ledger: iso(have.occurred_at) });
    if ((have.campaign_external_id ?? "") !== (lead.campaignExternalId ?? "")) diffs.push({ fact: "campaign", file: lead.campaignExternalId ?? "none", ledger: have.campaign_external_id ?? "none" });
    const journey = have.crm_customer_id !== null ? have.crm_customer_id : have.identity_id !== null ? `P-${have.identity_id}` : null;
    const target: LedgerTarget = { kind: "lead", leadId: Number(have.id), branchId: have.branch_id, journey };
    return { row: r.row, externalId: r.externalId, disposition: diffs.length ? "differs_from_ledger" : "matches_ledger", diffs, target };
  });
  return { rows: results, money: null, counts: countOf(results) };
}

async function comparePayments(db: Queryable, outcomes: RowOutcome[]): Promise<LedgerComparison> {
  const rows = eligibleRows(outcomes);
  const payments = rows.map((r) => ({ r, p: r.projection.row as PaymentRow }));
  const existing = new Map(
    (
      await db.query<{ crm_payment_id: string; amount_cents: string; status: string; crm_customer_id: string; office_id: number; paid_at: Date }>(
        "select crm_payment_id, amount_cents, status, crm_customer_id, office_id, paid_at from crm_payments where crm_payment_id = any($1::bigint[])",
        [payments.map((x) => x.p.crmPaymentId)],
      )
    ).rows.map((r) => [Number(r.crm_payment_id), r]),
  );
  const money: MoneyReconciliation = {
    meaning: "Cash collected per payment (refunds negative), successful payments only",
    fileTotalCents: 0, matchedFileCents: 0, matchedLedgerCents: 0, matchedDifferenceCents: 0, notInLedgerCents: 0, notInLedgerRows: 0,
    ledgerOnly: { rows: 0, cents: 0, examples: [], scope: "" },
  };
  // Collected cash counts successful payments only, on both sides, so a voided payment in either
  // system shows as a status difference and a cash difference, never as silent agreement.
  const cash = (amount: number, status: string) => (status === "successful" ? amount : 0);
  const results: LedgerRowResult[] = payments.map(({ r, p }) => {
    const fileCash = cash(p.amountCents, p.status);
    money.fileTotalCents += fileCash;
    const have = existing.get(p.crmPaymentId);
    if (!have) {
      money.notInLedgerCents += fileCash;
      money.notInLedgerRows++;
      return { row: r.row, externalId: r.externalId, disposition: "eligible", diffs: [] };
    }
    const ledgerCash = cash(Number(have.amount_cents), have.status);
    money.matchedFileCents += fileCash;
    money.matchedLedgerCents += ledgerCash;
    const diffs: FactDiff[] = [];
    // "collected cash" carries the money difference row by row, so the per-row cash differences
    // always sum to the matched difference, whether amount, status or both changed (data review #6).
    if (fileCash !== ledgerCash) diffs.push({ fact: "collected cash", file: dollars(fileCash), ledger: dollars(ledgerCash) });
    if (Number(have.amount_cents) !== p.amountCents) diffs.push({ fact: "amount", file: dollars(p.amountCents), ledger: dollars(Number(have.amount_cents)) });
    if (have.status !== p.status) diffs.push({ fact: "status", file: p.status, ledger: have.status });
    if (Number(have.crm_customer_id) !== p.crmCustomerId) diffs.push({ fact: "customer", file: String(p.crmCustomerId), ledger: have.crm_customer_id });
    if (have.office_id !== p.officeId) diffs.push({ fact: "office", file: String(p.officeId), ledger: String(have.office_id) });
    if (r.dayGrain.includes("paid_at")) {
      // The file gave a day, not a time: compare the office-local day only.
      const zone = BRANCH_BY_OFFICE.get(p.officeId)?.timezone ?? "UTC";
      const fileDay = instantToWallTime(p.paidAt, zone).slice(0, 10);
      const ledgerDay = instantToWallTime(new Date(have.paid_at), zone).slice(0, 10);
      if (fileDay !== ledgerDay) diffs.push({ fact: "paid on", file: fileDay, ledger: ledgerDay });
    } else if (iso(have.paid_at) !== iso(p.paidAt)) diffs.push({ fact: "paid at", file: iso(p.paidAt), ledger: iso(have.paid_at) });
    const target: LedgerTarget = { kind: "payment", branchId: BRANCH_BY_OFFICE.get(have.office_id)?.id ?? null, journey: have.crm_customer_id };
    return { row: r.row, externalId: r.externalId, disposition: diffs.length ? "differs_from_ledger" : "matches_ledger", diffs, target };
  });
  money.matchedDifferenceCents = money.matchedFileCents - money.matchedLedgerCents;

  if (payments.length > 0) {
    const offices = [...new Set(payments.map((x) => x.p.officeId))];
    // A day-only row covers its whole office-local day: the window ends at the next local
    // midnight, not at the start of the last day (data review #5).
    const ends = payments.map(({ r, p }) => {
      if (!r.dayGrain.includes("paid_at")) return p.paidAt.getTime();
      const zone = BRANCH_BY_OFFICE.get(p.officeId)?.timezone ?? "UTC";
      const next = new Date(`${instantToWallTime(p.paidAt, zone).slice(0, 10)}T00:00:00Z`);
      next.setUTCDate(next.getUTCDate() + 1);
      return wallTimeToInstant(`${next.toISOString().slice(0, 10)} 00:00:00`, zone).getTime() - 1;
    });
    let start = Number.POSITIVE_INFINITY;
    let end = Number.NEGATIVE_INFINITY;
    for (const [i, x] of payments.entries()) {
      start = Math.min(start, x.p.paidAt.getTime());
      end = Math.max(end, ends[i]);
    }
    const from = new Date(start);
    const to = new Date(end);
    const only = await db.query<{ crm_payment_id: string; amount_cents: string; status: string }>(
      `select crm_payment_id, amount_cents, status from crm_payments
       where office_id = any($1::int[]) and paid_at between $2 and $3 and not (crm_payment_id = any($4::bigint[]))
       order by paid_at, crm_payment_id`,
      [offices, from, to, payments.map((x) => x.p.crmPaymentId)],
    );
    money.ledgerOnly = {
      rows: only.rows.length,
      cents: only.rows.reduce((s, x) => s + cash(Number(x.amount_cents), x.status), 0),
      examples: only.rows.slice(0, 5).map((x) => `payment ${x.crm_payment_id}`),
      scope: `${offices.length} office(s), ${iso(from)} to ${iso(to)}`,
    };
  }
  return { rows: results, money, counts: countOf(results) };
}

async function compareSpend(db: Queryable, outcomes: RowOutcome[]): Promise<LedgerComparison> {
  const rows = eligibleRows(outcomes);
  const days = rows.map((r) => ({ r, s: r.projection.row as SpendDayRow }));
  const existing = new Map(
    (
      await db.query<{ platform: string; external_campaign_id: string; spend_date: string; cost_cents: string; clicks: number; platform_conversions: number; channel_code: string; branch_id: string | null }>(
        `select c.platform, c.external_campaign_id, to_char(d.spend_date, 'YYYY-MM-DD') as spend_date, d.cost_cents, d.clicks, d.platform_conversions,
           c.channel_code, m.branch_id
         from ad_spend_daily d join ad_campaigns c on c.id = d.campaign_id
         left join campaign_branch_map m on m.campaign_id = c.id
         where (c.platform, c.external_campaign_id) in (select * from unnest($1::text[], $2::text[]))`,
        [days.map((x) => x.s.platform), days.map((x) => x.s.externalCampaignId)],
      )
    ).rows.map((r) => [`${r.platform}:${r.external_campaign_id}:${r.spend_date}`, r]),
  );
  const money: MoneyReconciliation = {
    meaning: "Advertising cost charged by the platform, per campaign per day",
    fileTotalCents: 0, matchedFileCents: 0, matchedLedgerCents: 0, matchedDifferenceCents: 0, notInLedgerCents: 0, notInLedgerRows: 0,
    ledgerOnly: { rows: 0, cents: 0, examples: [], scope: "" },
  };
  const results: LedgerRowResult[] = days.map(({ r, s }) => {
    money.fileTotalCents += s.costCents;
    const have = existing.get(`${s.platform}:${s.externalCampaignId}:${s.spendDate}`);
    if (!have) {
      money.notInLedgerCents += s.costCents;
      money.notInLedgerRows++;
      return { row: r.row, externalId: r.externalId, disposition: "eligible", diffs: [] };
    }
    money.matchedFileCents += s.costCents;
    money.matchedLedgerCents += Number(have.cost_cents);
    const diffs: FactDiff[] = [];
    if (Number(have.cost_cents) !== s.costCents) diffs.push({ fact: "cost", file: dollars(s.costCents), ledger: dollars(Number(have.cost_cents)) });
    if (have.clicks !== s.clicks) diffs.push({ fact: "clicks", file: String(s.clicks), ledger: String(have.clicks) });
    if (have.platform_conversions !== s.platformConversions) diffs.push({ fact: "platform conversions", file: String(s.platformConversions), ledger: String(have.platform_conversions) });
    const target: LedgerTarget = { kind: "spend_day", branchId: have.branch_id, channel: have.channel_code, day: have.spend_date };
    return { row: r.row, externalId: r.externalId, disposition: diffs.length ? "differs_from_ledger" : "matches_ledger", diffs, target };
  });
  money.matchedDifferenceCents = money.matchedFileCents - money.matchedLedgerCents;
  if (days.length > 0) {
    const dates = days.map((x) => x.s.spendDate).sort();
    const keys = new Set(days.map((x) => `${x.s.platform}:${x.s.externalCampaignId}:${x.s.spendDate}`));
    const campaigns = [...new Set(days.map((x) => `${x.s.platform}:${x.s.externalCampaignId}`))];
    const only = (
      await db.query<{ k: string; cost_cents: string }>(
        `select c.platform || ':' || c.external_campaign_id || ':' || to_char(d.spend_date, 'YYYY-MM-DD') as k, d.cost_cents
         from ad_spend_daily d join ad_campaigns c on c.id = d.campaign_id
         where c.platform || ':' || c.external_campaign_id = any($1::text[]) and d.spend_date between $2::date and $3::date
         order by d.spend_date`,
        [campaigns, dates[0], dates[dates.length - 1]],
      )
    ).rows.filter((x) => !keys.has(x.k));
    money.ledgerOnly = {
      rows: only.length,
      cents: only.reduce((s, x) => s + Number(x.cost_cents), 0),
      examples: only.slice(0, 5).map((x) => x.k),
      scope: `${campaigns.length} campaign(s), ${dates[0]} to ${dates[dates.length - 1]}`,
    };
  }
  return { rows: results, money, counts: countOf(results) };
}

function countOf(rows: LedgerRowResult[]) {
  return {
    eligible: rows.filter((r) => r.disposition === "eligible").length,
    matches: rows.filter((r) => r.disposition === "matches_ledger").length,
    differs: rows.filter((r) => r.disposition === "differs_from_ledger").length,
  };
}

export async function compareWithLedger(db: Queryable, dataset: DatasetId, outcomes: RowOutcome[]): Promise<LedgerComparison> {
  switch (dataset) {
    case "calls":
      return compareLeads(db, "calls", outcomes);
    case "web_leads":
      return compareLeads(db, "web", outcomes);
    case "crm_payments":
      return comparePayments(db, outcomes);
    case "ad_spend":
      return compareSpend(db, outcomes);
  }
}

/** Branch scope check used before anything is shown or published. */
export function branchOfProjection(dataset: DatasetId, outcome: Extract<RowOutcome, { disposition: "eligible" }>): string | null {
  const row = outcome.projection.row as unknown as Record<string, unknown>;
  if (dataset === "calls" || dataset === "web_leads") return (row.branchId as string | null) ?? null;
  if (dataset === "crm_payments") return BRANCH_BY_OFFICE.get(row.officeId as number)?.id ?? null;
  return null;
}
