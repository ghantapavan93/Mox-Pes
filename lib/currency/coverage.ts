import type { Queryable } from "@/lib/db";

/**
 * Which ad accounts have an authorized "reports in USD" rule (lib/currency/rules.ts). Kept apart
 * from the rules' actions so the projection (lib/ingest/project.ts) can consult it without a cycle.
 */
export const CURRENCY_UNSTATED = "CURRENCY_UNSTATED";

/**
 * One transaction-scoped advisory lock orders currency decisions against the spend they decide:
 * the projection's gate holds it shared for the rest of its transaction; authorizing and revoking
 * a rule hold it exclusively. A revoke therefore waits for in-flight ingests to commit (so it sees
 * every row they counted under the rule), and an ingest that starts after a revoke sees it.
 * Without this, a revoke racing an ads poll could leave money counted as USD with no live rule
 * (review 2026-11-12, finding 1).
 */
export const CURRENCY_RULE_LOCK = 742_011;

export async function lockCurrencyShared(db: Queryable): Promise<void> {
  await db.query("select pg_advisory_xact_lock_shared($1)", [CURRENCY_RULE_LOCK]);
}

export async function lockCurrencyExclusive(db: Queryable): Promise<void> {
  await db.query("select pg_advisory_xact_lock($1)", [CURRENCY_RULE_LOCK]);
}

/** The active rules, as keys "platform:account" ("*" wildcards: every account, or company-wide). */
export async function activeCurrencyRules(db: Queryable): Promise<Set<string>> {
  const { rows } = await db.query<{ platform: string; ad_account_id: string }>("select platform, ad_account_id from currency_rules where authorized_at is not null and revoked_at is null");
  return new Set(rows.map((r) => `${r.platform}:${r.ad_account_id}`));
}

/** Whether an active rule covers this platform's account. */
export function covered(rules: ReadonlySet<string>, platform: string, adAccountId: string): boolean {
  return rules.has(`${platform}:${adAccountId}`) || rules.has(`${platform}:*`) || rules.has("*:*");
}
