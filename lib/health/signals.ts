import { accountsAwaitingCurrency } from "@/lib/currency/rules";
import type { Queryable } from "@/lib/db";
import { FRESHNESS_MAX_AGE_HOURS } from "@/lib/decision/verdicts";
import { exactDollars } from "@/lib/lineage/trace";
import { branchRows, freshness } from "@/lib/metrics/scorecard";
import type { Period } from "@/lib/period";

/**
 * Targeted reliability signals: a few conditions that make a figure wrong or incomplete, each
 * one actionable by a named role, and none shown when there is nothing to do. No scores, no
 * trend alarms: a signal says what is wrong, how much it affects, and where to fix it.
 */

export interface ReliabilitySignal {
  code: "currency_unstated" | "currency_rule_pending" | "held_spend_customers" | "partly_held_spend" | "refund_integrity" | "stale_feed";
  severity: "high" | "medium";
  /** What is wrong, with its size. */
  text: string;
  /** Who acts, and where. */
  owner: "integration engineer" | "approver";
  href: string;
}

export async function reliabilitySignals(db: Queryable, args: { period: Period; now: Date }): Promise<ReliabilitySignal[]> {
  const out: ReliabilitySignal[] = [];
  // Sequential: `db` may be one transaction client.
  const awaiting = await accountsAwaitingCurrency(db);
  if (awaiting.length > 0) {
    const days = awaiting.reduce((t, a) => t + a.campaignDays, 0);
    const cents = awaiting.reduce((t, a) => t + a.amountCents, 0);
    out.push({ code: "currency_unstated", severity: "medium", text: `${awaiting.length} ad account(s) send spend with no stated currency: ${days} campaign-day(s), ${exactDollars(cents)} as written, are not counted until a rule says the account reports in USD.`, owner: "integration engineer", href: "/integrations?view=pipeline#currency" });
  }
  const pending = await db.query<{ n: string }>("select count(*) as n from currency_rules where authorized_at is null and revoked_at is null");
  if (Number(pending.rows[0].n) > 0) {
    out.push({ code: "currency_rule_pending", severity: "medium", text: `${pending.rows[0].n} currency rule(s) wait for a second person to authorize them; until then their accounts' spend is not counted.`, owner: "approver", href: "/integrations?view=pipeline#currency" });
  }
  const rows = await branchRows(db, { from: args.period.from, to: args.period.to, branchIds: null });
  const held = rows.filter((r) => r.heldCampaignAcquired > 0);
  if (held.length > 0) {
    out.push({ code: "held_spend_customers", severity: "high", text: `${held.reduce((t, r) => t + r.heldCampaignAcquired, 0)} paid customer(s) at ${held.length} branch(es) are left out of paid CAC (${args.period.label}) because their campaign's spend is held at intake: the CAC leaves those campaigns out.`, owner: "integration engineer", href: "/integrations?view=pipeline#currency" });
  }
  // Some days held, some counted: the customers stay in, part of their cost does not.
  const partly = rows.filter((r) => r.partlyHeldAcquired > 0);
  if (partly.length > 0) {
    out.push({ code: "partly_held_spend", severity: "high", text: `${partly.reduce((t, r) => t + r.partlyHeldAcquired, 0)} paid customer(s) at ${partly.length} branch(es) are counted in paid CAC (${args.period.label}) while some days of their campaign's spend are held at intake: that CAC is understated.`, owner: "integration engineer", href: "/integrations?view=pipeline#currency" });
  }
  const refunds = await db.query<{ orphan: string; over: string }>(
    `select (select count(*) from crm_payments r where r.amount_cents < 0 and r.status = 'successful'
               and not exists (select 1 from crm_payments o where o.crm_payment_id = r.original_payment_id)) as orphan,
            (select count(*) from (select o.crm_payment_id from crm_payments r join crm_payments o on o.crm_payment_id = r.original_payment_id
                                   where r.status = 'successful' group by o.crm_payment_id, o.amount_cents having -sum(r.amount_cents) > o.amount_cents) x) as over`,
  );
  const orphan = Number(refunds.rows[0].orphan);
  const over = Number(refunds.rows[0].over);
  if (orphan + over > 0) {
    out.push({ code: "refund_integrity", severity: "high", text: `Collected cash rests on refunds that do not add up: ${orphan} refund(s) whose original payment is not stored, ${over} payment(s) refunded beyond their amount.`, owner: "integration engineer", href: "/exceptions" });
  }
  const streams = await freshness(db);
  const hours = (d: Date | null) => (d ? (args.now.getTime() - new Date(d).getTime()) / 3_600_000 : Number.POSITIVE_INFINITY);
  const stale = streams.filter((s) => hours(s.lastSuccessAt) > FRESHNESS_MAX_AGE_HOURS);
  if (stale.length > 0) {
    out.push({ code: "stale_feed", severity: "medium", text: `${stale.map((s) => s.stream).join(", ")}: no successful run in ${FRESHNESS_MAX_AGE_HOURS} h; figures built on ${stale.length === 1 ? "it" : "them"} are incomplete for the latest days.`, owner: "integration engineer", href: "/integrations?view=pipeline#failed-runs" });
  }
  return out;
}
