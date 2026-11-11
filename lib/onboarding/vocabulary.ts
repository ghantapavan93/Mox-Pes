import { resolveBranch } from "./branches";
import { AD_PLATFORMS, CALL_SOURCES, PAYMENT_STATUSES, WEB_FORMS, type DatasetId, type TargetField } from "./targets";

/**
 * The canonical values each enum field accepts, and the translations a person is OFFERED for
 * common source spellings. An offered translation only takes effect once a person confirms it
 * and it is saved in a mapping version; the compiler never applies one by itself.
 */
export const CANONICAL: Record<string, readonly string[]> = {
  "calls.call_source": CALL_SOURCES,
  "web_leads.form_type": WEB_FORMS,
  "crm_payments.status": PAYMENT_STATUSES,
  "ad_spend.platform": AD_PLATFORMS,
};

export const VALUE_ALIASES: Record<string, Record<string, string>> = {
  "calls.call_source": {
    "google ads": "Google Ads", "google paid": "Google Ads", "google adwords": "Google Ads", "google cpc": "Google Ads", adwords: "Google Ads",
    lsa: "Google LSA", "local services": "Google LSA", "google local services": "Google LSA", "google lsa": "Google LSA",
    gmb: "Google My Business", "google business profile": "Google My Business", "google my business": "Google My Business",
    facebook: "Facebook", meta: "Facebook", "facebook ads": "Facebook", "meta ads": "Facebook", instagram: "Facebook",
    bing: "Bing", "microsoft ads": "Bing", "microsoft advertising": "Bing", "bing ads": "Bing", direct: "Direct",
  },
  "web_leads.form_type": { quote: "quote", "get a quote": "quote", "free quote": "quote", "request a quote": "quote", contact: "contact", "contact us": "contact", checkout: "checkout", "buy online": "checkout" },
  "crm_payments.status": {
    successful: "successful", success: "successful", paid: "successful", approved: "successful", settled: "successful", "1": "successful",
    failed: "failed", declined: "failed", "0": "failed", voided: "voided", void: "voided", "2": "voided",
  },
  "ad_spend.platform": { "google ads": "google_ads", google: "google_ads", "google lsa": "google_lsa", "local services": "google_lsa", "microsoft ads": "microsoft_ads", bing: "microsoft_ads", meta: "meta", facebook: "meta" },
};

/** A proposed translation for one source value (exact canonical value, alias, or a branch match). */
export function proposeValue(dataset: DatasetId, field: TargetField, value: string): string | null {
  const v = value.trim();
  if (field.kind === "branch") return resolveBranch(v)?.branchId ?? null;
  const canon = CANONICAL[`${dataset}.${field.key}`];
  if (!canon) return null;
  const exact = canon.find((c) => c.toLowerCase() === v.toLowerCase());
  return exact ?? VALUE_ALIASES[`${dataset}.${field.key}`]?.[v.toLowerCase()] ?? null;
}
