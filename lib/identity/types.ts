/**
 * Identity resolution vocabulary, shared by the resolver, the queries, the API and the UI.
 * Kept free of I/O so client components can import the labels.
 */

export type IdentityKind = "customer" | "prospect";

/** How a source record was attached to its identity. Every rule is deterministic. */
export type IdentityRule =
  | "crm_customer_anchor"
  | "exact_phone_hash"
  | "exact_email_hash"
  | "prospect_phone_hash"
  | "prospect_email_hash"
  | "reviewer_accepted";

export const IDENTITY_RULES: IdentityRule[] = [
  "crm_customer_anchor",
  "exact_phone_hash",
  "exact_email_hash",
  "prospect_phone_hash",
  "prospect_email_hash",
  "reviewer_accepted",
];

export const RULE_LABEL: Record<IdentityRule, string> = {
  crm_customer_anchor: "CRM customer record (anchor)",
  exact_phone_hash: "Exact phone hash, one CRM customer",
  exact_email_hash: "Exact email hash, one CRM customer",
  prospect_phone_hash: "Prospect grouped by phone hash",
  prospect_email_hash: "Prospect grouped by email hash",
  reviewer_accepted: "Accepted by a reviewer",
};

export type ConflictKind = "shared_phone" | "shared_email" | "phone_email_disagree" | "previously_rejected";

export const CONFLICT_KIND_LABEL: Record<ConflictKind, string> = {
  shared_phone: "Phone hash shared by several CRM customers",
  shared_email: "Email hash shared by several CRM customers",
  phone_email_disagree: "Phone and email point at different CRM customers",
  previously_rejected: "Exact match a reviewer rejected before",
};

export type ConflictStatus = "pending" | "accepted" | "rejected" | "superseded";

/**
 * Where a customer is in the business: prospect (no CRM customer), sold (an active subscription,
 * no completed service yet), serviced (a completed appointment), cancelled (every subscription
 * cancelled). "unknown" = a CRM customer whose subscriptions have not been delivered yet.
 */
export type Lifecycle = "prospect" | "sold" | "serviced" | "cancelled" | "unknown";

export const LIFECYCLE_FILTERS = ["prospect", "sold", "serviced", "cancelled"] as const;
export type LifecycleFilter = (typeof LIFECYCLE_FILTERS)[number];

export const LIFECYCLE_TONE: Record<Lifecycle, "neutral" | "accent" | "good" | "bad" | "warn"> = {
  prospect: "neutral",
  sold: "accent",
  serviced: "good",
  cancelled: "bad",
  unknown: "warn",
};

/** The route segment for an identity: a CRM customer id, or `P-<identityId>` for a prospect. */
export function journeyPath(identity: { kind: IdentityKind; crmCustomerId: number | null; identityId: number }): string {
  return identity.kind === "customer" && identity.crmCustomerId !== null
    ? `/customers/${identity.crmCustomerId}`
    : `/customers/P-${identity.identityId}`;
}

/** Parses a `/customers/[id]` segment. Null = not a valid journey reference. */
export function parseJourneyRef(segment: string): { kind: "customer"; crmCustomerId: number } | { kind: "prospect"; identityId: number } | null {
  if (/^\d{1,15}$/.test(segment)) return { kind: "customer", crmCustomerId: Number(segment) };
  const prospect = /^P-(\d{1,15})$/i.exec(segment);
  return prospect ? { kind: "prospect", identityId: Number(prospect[1]) } : null;
}
