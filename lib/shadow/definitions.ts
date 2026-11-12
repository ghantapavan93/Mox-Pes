import { z } from "zod";
import { METRICS } from "@/lib/metrics/definitions";

/**
 * The definition vocabulary of Shadow Mode (docs/agent-work/SHADOW-MODE.md §1): how another
 * reporting system describes what it computed, and the product's own metrics in the same terms.
 * Comparing two definitions is comparing these attributes, nothing cleverer: two numbers are
 * comparable only when every attribute agrees.
 */

export const FAMILIES = ["cac", "spend", "customers", "cash"] as const;
export type Family = (typeof FAMILIES)[number];

export const NUMERATORS = ["paid_media_spend_mapped_to_branch", "all_media_spend", "paid_media_spend_by_lead_branch"] as const;
export const POPULATIONS = ["new_customers_first_serviced_paid_first_touch", "new_customers_first_serviced", "customers_sold"] as const;
export const CASH_BASES = ["payment_date_net_of_refunds", "payment_date_gross", "invoice_date"] as const;
export const PERIOD_BASES = ["utc_day", "office_local_day"] as const;
export const BRANCH_BASES = ["campaign_mapping", "crm_office", "lead_branch"] as const;

/** An attribute the other system may declare. Unknown values are refused by the schema. */
export const DefinitionSchema = z.strictObject({
  id: z.string().min(1).max(120),
  version: z.string().min(1).max(40),
  family: z.enum(FAMILIES),
  numerator: z.enum(NUMERATORS).nullable().default(null),
  population: z.enum(POPULATIONS).nullable().default(null),
  cashBasis: z.enum(CASH_BASES).nullable().default(null),
  periodBasis: z.enum(PERIOD_BASES),
  branchBasis: z.enum(BRANCH_BASES).nullable().default(null),
});
export type Definition = z.infer<typeof DefinitionSchema>;

/** The attributes compared, in the order a reader is told about them. */
export const COMPARED = ["numerator", "population", "cashBasis", "periodBasis", "branchBasis"] as const;
export type Attribute = (typeof COMPARED)[number];

export type ScopeKind = "branch" | "brand" | "company";

/** The product's figures, each in the vocabulary, with the metric definition it reports. */
export type ProductMetric = "paidCac" | "paidSpend" | "companySpend" | "paidCustomers" | "newCustomers" | "collected" | "grossPayments";

export interface ProductDefinition {
  metric: ProductMetric;
  label: string;
  family: Family;
  numerator: Definition["numerator"];
  population: Definition["population"];
  cashBasis: Definition["cashBasis"];
  periodBasis: Definition["periodBasis"];
  branchBasis: Definition["branchBasis"];
  /** The versioned definition in lib/metrics/definitions.ts it is computed by. */
  definitionVersion: string;
  unit: "usd_cents" | "count";
}

const v = (key: string) => `${key} ${METRICS[key]?.version.split(" ")[0] ?? "unversioned"}`;

/**
 * At company scope the product's spend is every branch plus unallocated campaigns
 * (`all_media_spend`); at branch and brand scope it is the branches' mapped spend. Company CAC
 * uses branch spend only (SCHEMA.md of the acceptance pack).
 */
export function productDefinitions(scope: ScopeKind): ProductDefinition[] {
  const spendNumerator = scope === "company" ? "all_media_spend" : "paid_media_spend_mapped_to_branch";
  return [
    { metric: "paidCac", label: "Paid-media CAC", family: "cac", numerator: "paid_media_spend_mapped_to_branch", population: "new_customers_first_serviced_paid_first_touch", cashBasis: null, periodBasis: "utc_day", branchBasis: "campaign_mapping", definitionVersion: v("paidCac"), unit: "usd_cents" },
    { metric: scope === "company" ? "companySpend" : "paidSpend", label: scope === "company" ? "Media spend, every branch plus unallocated" : "Paid media spend", family: "spend", numerator: spendNumerator, population: null, cashBasis: null, periodBasis: "utc_day", branchBasis: "campaign_mapping", definitionVersion: v("paidSpend"), unit: "usd_cents" },
    { metric: "paidCustomers", label: "New customers serviced, first touch paid", family: "customers", numerator: null, population: "new_customers_first_serviced_paid_first_touch", cashBasis: null, periodBasis: "utc_day", branchBasis: "crm_office", definitionVersion: v("paidCac"), unit: "count" },
    { metric: "newCustomers", label: "New customers serviced", family: "customers", numerator: null, population: "new_customers_first_serviced", cashBasis: null, periodBasis: "utc_day", branchBasis: "crm_office", definitionVersion: v("acquired"), unit: "count" },
    { metric: "collected", label: "Collected revenue", family: "cash", numerator: null, population: null, cashBasis: "payment_date_net_of_refunds", periodBasis: "utc_day", branchBasis: "crm_office", definitionVersion: v("collected"), unit: "usd_cents" },
    { metric: "grossPayments", label: "Gross payments (refunds not subtracted)", family: "cash", numerator: null, population: null, cashBasis: "payment_date_gross", periodBasis: "utc_day", branchBasis: "crm_office", definitionVersion: v("collected"), unit: "usd_cents" },
  ];
}

/** The attributes on which two definitions disagree. */
export function differences(theirs: Definition, ours: ProductDefinition): Attribute[] {
  return COMPARED.filter((a) => (theirs[a] ?? null) !== (ours[a] ?? null));
}

/**
 * The product metric a snapshot is about: within its family, the one that agrees on the most
 * attributes (ties: the first listed). Null when the product has no metric of that family.
 */
export function counterpart(theirs: Definition, scope: ScopeKind): { ours: ProductDefinition; differs: Attribute[] } | null {
  let best: { ours: ProductDefinition; differs: Attribute[] } | null = null;
  for (const ours of productDefinitions(scope)) {
    if (ours.family !== theirs.family) continue;
    const differs = differences(theirs, ours);
    if (!best || differs.length < best.differs.length) best = { ours, differs };
  }
  return best;
}
