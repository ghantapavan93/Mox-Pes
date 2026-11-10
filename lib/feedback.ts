import type { Queryable } from "@/lib/db";
import { sha256 } from "@/lib/primitives";
import type { Scope } from "@/lib/metrics/scorecard";

/**
 * Offline conversion feedback to Google Ads — DRY RUN ONLY. Nothing here makes a network
 * call. It decides, from reconciled data, which serviced customers should be reported back
 * to Google Ads as conversions, and which should not, and why.
 *
 * Shape follows the Data Manager API `events:ingest` path that replaced
 * UploadClickConversions for new uploaders in 2026 (research/05-attribution-model.md).
 * Field names must be re-checked against Google's current reference before any real use.
 *
 * Rules (research/05; re-checked against Google's docs on 2026-11-09, audit area F):
 *   * this dry run matches on a click id (gclid) only. Google can also match a lead with no
 *     click id on hashed email/phone (enhanced conversions for leads, Data Manager `userData`)
 *     and on gbraid/wbraid; neither is implemented, so those rows are "no click id", NOT
 *     "unmatchable".
 *   * click age is approximated by the LEAD time (form sent / call started), which is at or
 *     after the click, so it under-estimates click age. Google's real limit is the conversion
 *     action's click-through window (90 days by default; older clicks fail EXPIRED_EVENT).
 *   * one stable transactionId per (lead, stage) — re-sends become adjustments, not duplicates
 *   * a cancelled plan is NOT sent. Data Manager cannot retract a conversion (its upgrade guide:
 *     it "doesn't support conversion retractions"; a value can be restated, the count stays).
 *     Nothing here records what was sent, so every cancelled row is "never sent → suppress".
 *   * a D2D/paid conflict is held for review rather than claimed by the ad platform
 *   * no consent fields are sent: consent is required for EEA users only, and this is a US
 *     business. A real uploader should still pass `consent` explicitly.
 */

export type FeedbackDecision = "upload" | "suppress_cancelled" | "held_channel_conflict" | "no_click_id" | "click_too_old" | "not_serviced";

export const DECISION_LABEL: Record<FeedbackDecision, string> = {
  upload: "Upload as conversion",
  suppress_cancelled: "Don't send: plan cancelled",
  held_channel_conflict: "Hold: D2D rep also signed",
  no_click_id: "No click id (hashed-identity matching not built)",
  click_too_old: "Too old: lead > 90 days ago",
  not_serviced: "Not yet a conversion: not serviced",
};

export interface FeedbackRow {
  customerId: number;
  leadId: number;
  branchId: string;
  decision: FeedbackDecision;
  clickId: string | null;
  /** When the lead arrived: at or after the click, used as the click-age proxy. */
  clickAt: Date;
  convertedAt: Date | null;
  valueCents: number;
}

const DECISION_SQL = `
  select a.crm_customer_id, a.lead_id, a.branch_id, l.click_id, l.occurred_at as click_at,
         a.initial_completed_at, a.annual_value_cents,
         case
           when a.initial_status <> 'completed' then 'not_serviced'
           when l.click_id is null then 'no_click_id'
           when $4::timestamptz - l.occurred_at > interval '90 days' then 'click_too_old'
           when a.channel_conflict then 'held_channel_conflict'
           when a.subscription_status = 'cancelled' then 'suppress_cancelled'
           else 'upload'
         end as decision
  from v_acquisitions a
  join leads l on l.id = a.lead_id
  where a.channel_code = 'google_search'
    and a.sold_at >= $1 and a.sold_at < $2
    and ($3::text[] is null or a.branch_id = any($3::text[]))`;

export async function feedbackSummary(db: Queryable, scope: Scope, now: Date): Promise<Record<FeedbackDecision, number>> {
  const { rows } = await db.query(`select decision, count(*) as n from (${DECISION_SQL}) d group by decision`, [scope.from, scope.to, scope.branchIds, now]);
  const out: Record<FeedbackDecision, number> = { upload: 0, suppress_cancelled: 0, held_channel_conflict: 0, no_click_id: 0, click_too_old: 0, not_serviced: 0 };
  for (const r of rows) out[r.decision as FeedbackDecision] = Number(r.n);
  return out;
}

export async function feedbackRows(db: Queryable, scope: Scope, now: Date, limit = 50): Promise<FeedbackRow[]> {
  const { rows } = await db.query(`${DECISION_SQL} order by a.initial_completed_at desc nulls last limit $5`, [scope.from, scope.to, scope.branchIds, now, limit]);
  return rows.map((r) => ({
    customerId: Number(r.crm_customer_id),
    leadId: Number(r.lead_id),
    branchId: r.branch_id,
    decision: r.decision,
    clickId: r.click_id,
    clickAt: r.click_at,
    convertedAt: r.initial_completed_at,
    valueCents: Number(r.annual_value_cents),
  }));
}

/** Stable across re-runs: the same lead reaching the same stage always has the same id. */
export function transactionId(leadId: number, stage = "initial_service_completed"): string {
  return sha256(`${leadId}:${stage}`).slice(0, 32);
}

/**
 * The event body that WOULD be sent for an "upload" row; null for every other decision (nothing
 * is sent for them). Value is booked annual plan value: a bidding signal, not revenue.
 */
export function toDataManagerEvent(row: FeedbackRow) {
  if (row.decision !== "upload") return null;
  return {
    transactionId: transactionId(row.leadId),
    eventTimestamp: row.convertedAt?.toISOString(),
    adIdentifiers: { gclid: row.clickId },
    conversionValue: row.valueCents / 100,
    currency: "USD",
    eventSource: "WEB",
  };
}
