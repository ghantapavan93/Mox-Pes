import type { Queryable } from "@/lib/db";

/**
 * Which ad accounts have an authorized "reports in USD" rule (lib/currency/rules.ts). Kept apart
 * from the rules' actions so the projection (lib/ingest/project.ts) can consult it without a cycle.
 */
export const CURRENCY_UNSTATED = "CURRENCY_UNSTATED";

/** The active rules, as keys "platform:account" ("*" wildcards: every account, or company-wide). */
export async function activeCurrencyRules(db: Queryable): Promise<Set<string>> {
  const { rows } = await db.query<{ platform: string; ad_account_id: string }>("select platform, ad_account_id from currency_rules where authorized_at is not null and revoked_at is null");
  return new Set(rows.map((r) => `${r.platform}:${r.ad_account_id}`));
}

/** Whether an active rule covers this platform's account. */
export function covered(rules: ReadonlySet<string>, platform: string, adAccountId: string): boolean {
  return rules.has(`${platform}:${adAccountId}`) || rules.has(`${platform}:*`) || rules.has("*:*");
}
