/**
 * The metric registry. Every number on screen names one of these keys, and the UI shows
 * the definition next to it. docs/metric-definitions.md is the long form.
 */
export interface MetricDefinition {
  key: string;
  label: string;
  formula: string;
  sources: string;
  caveat: string;
  /**
   * Which version of the definition the numbers apply, and what changed it. A trace names it,
   * so a number can be challenged against the exact rule that produced it. Bump it with a
   * dated note whenever the computation of the metric changes.
   */
  version: string;
}

export const METRICS: Record<string, MetricDefinition> = {
  paidSpend: {
    key: "paidSpend",
    version: "v1 (2026-10-31)",
    label: "Paid media spend",
    formula: "Σ cost of paid-media campaigns mapped to the branch, by spend date",
    sources: "Ad platforms → ad_spend_daily, campaign_branch_map",
    caveat: "Unmapped campaigns are excluded from every branch and shown as unallocated spend. Door-to-door commission is not media spend.",
  },
  prospects: {
    key: "prospects",
    version: "v2 (2026-11-11: calls the source marks outbound, spam or not-a-lead are no longer leads)",
    label: "Unique prospects",
    formula: "Distinct phone (else email) across all lead records in the period",
    sources: "Call tracking, website, D2D app → leads",
    caveat: "No transitive identity merge: a person who calls from one number and emails from an unrelated address counts twice.",
  },
  acquired: {
    key: "acquired",
    version: "v1 (2026-10-31)",
    label: "New customers serviced",
    formula: "Customers whose FIRST subscription's initial service was completed in the period",
    sources: "CRM subscriptions + appointments",
    caveat: "Existing customers adding a service are not new customers. Sold-but-not-yet-serviced customers are excluded until serviced.",
  },
  paidCac: {
    key: "paidCac",
    version: "v3 (2026-11-12: customers credited to a campaign whose spend was all held at intake left the denominator too, held-out IV-26; v2 2026-11-09: campaigns mapped to no branch, audit D-3)",
    label: "Paid-media CAC",
    formula: "Paid media spend ÷ new customers serviced whose first evidenced touch was a paid channel",
    sources: "paidSpend ÷ acquired (paid channels)",
    caveat: "Period CAC: spend and acquisitions are matched by calendar period, not by cohort. Recent periods look worse because their leads have not finished converting.",
  },
  unknownShare: {
    key: "unknownShare",
    version: "v1 (2026-10-31)",
    label: "Unattributed share",
    formula: "New customers serviced with channel 'unknown' ÷ all new customers serviced",
    sources: "v_acquisitions",
    caveat: "Unknown is never reassigned to a paid channel. A rise usually means a broken capture or linkage, not a change in customer behaviour.",
  },
  collected: {
    key: "collected",
    version: "v1 (2026-10-31)",
    label: "Collected revenue",
    formula: "Σ successful payments − refunds, by payment date, in the CRM office's branch",
    sources: "CRM payments",
    caveat: "Booked contract value and invoiced totals are never revenue. Includes the existing customer base.",
  },
  newCollected: {
    key: "newCollected",
    version: "v1 (2026-10-31)",
    label: "Collected from new customers",
    formula: "Σ successful payments − refunds, to date, from customers first serviced in the period",
    sources: "CRM payments joined to v_acquisitions",
    caveat: "Cash actually received, not contract value. Young customers have paid little so far — this grows with time.",
  },
  atRisk: {
    key: "atRisk",
    version: "v1 (2026-10-31)",
    label: "Revenue in open exceptions",
    formula: "Σ collected revenue of DISTINCT customers referenced by open exceptions",
    sources: "exceptions",
    caveat: "Revenue that exists but whose credit is not settled. Part of it cannot yet be tied to a lead, branch or channel (held source records, payments without a ticket, conflicting payloads); the rest is tied but its credit is disputed (branch mismatch, D2D / paid conflict). The Overview shows both parts. It is not lost revenue. Unmapped spend is reported separately as unallocated spend.",
  },
};
