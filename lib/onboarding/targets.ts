import type { SourceName } from "@/lib/adapters/contract";

/**
 * What an unfamiliar export can be onboarded AS: the target datasets and their fields.
 *
 * Each dataset compiles to the payload shape of an existing, versioned source mapper, so a dry
 * run validates an uploaded row with exactly the rules a live delivery meets (lib/onboarding/
 * compile.ts). There is one validation path, not a second, looser one for files.
 *
 * Authority decides what a file may do (docs/agent-work/SOURCE-AUTHORITY.md):
 *   publish     the file may become ledger records after independent approval. Calls and web
 *               leads arrive by push; a file is a legitimate backfill of missed deliveries.
 *   reconcile   the file is only COMPARED with the ledger. The CRM API owns payments and the ad
 *               platforms own spend; an export is a secondary copy, so it can reveal a
 *               disagreement but never overwrite the authoritative feed.
 */

export type DatasetId = "calls" | "web_leads" | "crm_payments" | "ad_spend";

export type FieldKind = "identifier" | "datetime" | "date" | "phone" | "email" | "zip" | "money" | "integer" | "enum" | "text" | "branch";

/**
 * What a money column can mean. Similar-looking columns are not interchangeable: an invoice
 * total is not cash collected, and a contracted annual value is not money at all yet.
 */
export const MONEY_MEANINGS = {
  collected_payment: "Cash collected by one payment (a refund is a negative payment)",
  invoice_total: "What an invoice or ticket billed, paid or not",
  refund_adjusted_cash: "Collected cash net of refunds over some period",
  recognized_revenue: "Revenue recognized by accounting rules",
  contract_annual_value: "Contracted annual plan value (a promise, not collected money)",
  gross_sales: "Sales booked before cancellations and refunds",
  forecast_value: "A forecast or estimate",
  lifetime_value: "Estimated customer lifetime value",
  ad_cost: "Advertising cost charged by an ad platform",
} as const;
export type MoneyMeaning = keyof typeof MONEY_MEANINGS;

export interface TargetField {
  key: string;
  label: string;
  /** What the value means in the business, in one sentence. */
  meaning: string;
  kind: FieldKind;
  required: boolean;
  /** Header vocabulary seen in real exports. Matching is token based (lib/onboarding/assistant.ts). */
  synonyms: string[];
  /** enum fields: the canonical values the mapper accepts. */
  values?: readonly string[];
  /** money fields: the only meaning this field accepts. Anything else must be refused. */
  moneyMeaning?: MoneyMeaning;
  /** Free text that is stored and later read by people and the AI: treat as untrusted. */
  untrustedText?: boolean;
  /** Personal data: never shown in profiles, hashed before it reaches a projection. */
  personal?: boolean;
}

export interface TargetDataset {
  id: DatasetId;
  label: string;
  description: string;
  source: SourceName;
  entity: string;
  authority: "publish" | "reconcile";
  /** Who owns the facts this dataset describes. */
  systemOfRecord: string;
  fields: TargetField[];
}

export const CALL_SOURCES = ["Google Ads", "Google LSA", "Google My Business", "Facebook", "Bing", "Direct"] as const;
export const WEB_FORMS = ["quote", "contact", "checkout"] as const;
export const PAYMENT_STATUSES = ["successful", "failed", "voided"] as const;
export const AD_PLATFORMS = ["google_ads", "google_lsa", "microsoft_ads", "meta"] as const;

export const DATASETS: Record<DatasetId, TargetDataset> = {
  calls: {
    id: "calls",
    label: "Tracked phone calls",
    description: "One row per inbound call from a call-tracking system.",
    source: "calls",
    entity: "call",
    authority: "publish",
    systemOfRecord: "Call-tracking platform",
    fields: [
      { key: "call_id", label: "Call ID", meaning: "The call-tracking system's id for the call", kind: "identifier", required: true, synonyms: ["call id", "id", "call identifier", "call sid", "callid"] },
      { key: "started_at", label: "Call start", meaning: "When the call started", kind: "datetime", required: true, synonyms: ["start time", "started at", "call time", "date time", "call start", "start", "datetime"] },
      { key: "branch", label: "Branch", meaning: "The branch the call was routed to", kind: "branch", required: true, synonyms: ["branch", "office", "location", "branch tag", "company", "routed to"] },
      { key: "caller_phone", label: "Caller phone", meaning: "The number the customer called from", kind: "phone", required: true, personal: true, synonyms: ["customer phone number", "caller number", "caller phone", "phone", "from number", "caller", "customer phone"] },
      { key: "tracking_number", label: "Tracking number", meaning: "The tracking number that was dialed", kind: "phone", required: false, synonyms: ["tracking number", "tracking phone number", "tracking #", "dialed number", "to number"] },
      { key: "call_source", label: "Call source", meaning: "The marketing source the tracking number belongs to", kind: "enum", required: true, values: CALL_SOURCES, synonyms: ["source", "call source", "marketing source", "channel", "medium"] },
      { key: "click_id", label: "Click ID (gclid)", meaning: "The ad click id captured by the tracking script", kind: "identifier", required: false, synonyms: ["gclid", "click id", "google click id"] },
      { key: "campaign", label: "Campaign", meaning: "The ad campaign attached to the call", kind: "text", required: false, synonyms: ["campaign", "campaign name", "utm campaign"] },
      { key: "note", label: "Agent note", meaning: "Free text written by the person who took the call", kind: "text", required: false, untrustedText: true, synonyms: ["note", "notes", "agent note", "comments", "summary"] },
    ],
  },
  web_leads: {
    id: "web_leads",
    label: "Website form leads",
    description: "One row per submitted quote, contact or checkout form.",
    source: "web",
    entity: "lead",
    authority: "publish",
    systemOfRecord: "Website event pipeline",
    fields: [
      { key: "lead_id", label: "Lead ID", meaning: "The id of the form submission", kind: "identifier", required: true, synonyms: ["lead id", "submission id", "message id", "id", "form id", "entry id"] },
      { key: "submitted_at", label: "Submitted at", meaning: "When the form was submitted", kind: "datetime", required: true, synonyms: ["submitted at", "timestamp", "date submitted", "created at", "submission time", "date"] },
      { key: "branch", label: "Branch", meaning: "The branch the lead belongs to", kind: "branch", required: true, synonyms: ["branch", "office", "location", "branch id"] },
      { key: "form_type", label: "Form type", meaning: "Which form was submitted", kind: "enum", required: true, values: WEB_FORMS, synonyms: ["form", "form type", "form name"] },
      { key: "zip", label: "ZIP code", meaning: "The service ZIP code entered", kind: "zip", required: true, synonyms: ["zip", "zip code", "postal code", "postcode"] },
      { key: "phone", label: "Phone", meaning: "Phone number entered on the form", kind: "phone", required: false, personal: true, synonyms: ["phone", "phone number", "mobile", "telephone"] },
      { key: "email", label: "Email", meaning: "Email entered on the form", kind: "email", required: false, personal: true, synonyms: ["email", "email address", "e-mail"] },
      { key: "utm_source", label: "UTM source", meaning: "utm_source on the landing URL", kind: "text", required: false, synonyms: ["utm source", "source"] },
      { key: "utm_medium", label: "UTM medium", meaning: "utm_medium on the landing URL", kind: "text", required: false, synonyms: ["utm medium", "medium"] },
      { key: "utm_campaign", label: "UTM campaign", meaning: "utm_campaign on the landing URL", kind: "text", required: false, synonyms: ["utm campaign", "campaign"] },
      { key: "click_id", label: "Click ID (gclid)", meaning: "The ad click id on the landing URL", kind: "identifier", required: false, synonyms: ["gclid", "click id"] },
      { key: "message", label: "Message", meaning: "Free text the visitor typed", kind: "text", required: false, untrustedText: true, personal: true, synonyms: ["message", "comments", "notes", "details"] },
    ],
  },
  crm_payments: {
    id: "crm_payments",
    label: "CRM payments",
    description: "One row per payment or refund recorded in the CRM.",
    source: "crm",
    entity: "payment",
    authority: "reconcile",
    systemOfRecord: "CRM (FieldRoutes-style API)",
    fields: [
      { key: "payment_id", label: "Payment ID", meaning: "The CRM's id for the payment", kind: "identifier", required: true, synonyms: ["payment id", "paymentid", "payment #", "transaction id", "receipt id"] },
      { key: "customer_id", label: "Customer ID", meaning: "The CRM's id for the paying customer", kind: "identifier", required: true, synonyms: ["customer id", "cust #", "cust id", "customer number", "account number", "customerid"] },
      { key: "branch", label: "Branch / office", meaning: "The CRM office the payment was recorded in", kind: "branch", required: true, synonyms: ["office", "office id", "branch", "location", "officeid"] },
      { key: "ticket_id", label: "Ticket / invoice ID", meaning: "The invoice the payment was applied to", kind: "identifier", required: false, synonyms: ["ticket id", "invoice id", "invoice #", "ticket #", "ticketid"] },
      { key: "amount", label: "Payment amount", meaning: "Cash collected by this payment; a refund is negative", kind: "money", required: true, moneyMeaning: "collected_payment", synonyms: ["amount", "payment amount", "amount paid", "net paid", "paid", "applied amount", "amount received", "amount collected"] },
      { key: "original_payment_id", label: "Refunded payment ID", meaning: "For a refund, the payment it reverses", kind: "identifier", required: false, synonyms: ["original payment id", "refund of", "original payment", "reversed payment"] },
      { key: "status", label: "Payment status", meaning: "Whether the payment succeeded, failed or was voided", kind: "enum", required: true, values: PAYMENT_STATUSES, synonyms: ["status", "payment status", "state"] },
      { key: "paid_at", label: "Payment date", meaning: "When the payment was recorded, in the office's local time", kind: "datetime", required: true, synonyms: ["date", "payment date", "paid at", "date paid", "posted", "created", "transaction date"] },
    ],
  },
  ad_spend: {
    id: "ad_spend",
    label: "Ad spend by day",
    description: "One row per campaign per day from an ad platform report.",
    source: "ads",
    entity: "spend_day",
    authority: "reconcile",
    systemOfRecord: "Ad platform (Google, Microsoft, Meta)",
    fields: [
      { key: "platform", label: "Platform", meaning: "Which ad platform charged the spend", kind: "enum", required: true, values: AD_PLATFORMS, synonyms: ["platform", "network", "publisher", "ad platform"] },
      { key: "account_id", label: "Ad account ID", meaning: "The ad account the campaign belongs to", kind: "identifier", required: true, synonyms: ["account id", "customer id", "ad account", "account"] },
      { key: "campaign_id", label: "Campaign ID", meaning: "The platform's id for the campaign", kind: "identifier", required: true, synonyms: ["campaign id", "campaignid", "campaign #"] },
      { key: "campaign_name", label: "Campaign name", meaning: "The campaign's name", kind: "text", required: true, synonyms: ["campaign", "campaign name"] },
      { key: "date", label: "Day", meaning: "The day, in the ad account's time zone", kind: "date", required: true, synonyms: ["day", "date", "report date"] },
      { key: "cost", label: "Cost", meaning: "What the platform charged that day", kind: "money", required: true, moneyMeaning: "ad_cost", synonyms: ["cost", "spend", "amount spent", "cost usd", "spend usd"] },
      // Platforms state the account's currency in a column of its own. Read, it goes to the
      // deployed mapper, which refuses any currency but USD; nothing is converted (BYOF-WORKFLOW.md).
      { key: "currency", label: "Currency", meaning: "The currency the cost is stated in, as a three-letter code (USD). Only US dollars are summed; nothing is converted", kind: "text", required: false, synonyms: ["currency", "currency code", "account currency", "cost currency"] },
      { key: "clicks", label: "Clicks", meaning: "Clicks the platform counted that day", kind: "integer", required: true, synonyms: ["clicks", "link clicks"] },
      { key: "conversions", label: "Platform conversions", meaning: "Conversions the platform claims; not verified revenue", kind: "integer", required: true, synonyms: ["conversions", "conv", "results", "all conv"] },
    ],
  },
};

export const DATASET_IDS = Object.keys(DATASETS) as DatasetId[];

export function isDatasetId(value: unknown): value is DatasetId {
  return typeof value === "string" && Object.hasOwn(DATASETS, value);
}
