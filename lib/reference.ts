/**
 * Reference data for the synthetic business. Branch names are deliberately fictional
 * (no real metros): a bad number next to a real city would read as a judgement on a
 * real branch. The SHAPE is modelled on public facts — 44 branches across several time
 * zones, one zone without daylight saving time.
 */

/**
 * Organization (shared kernel): Company → Brand → Branch → CRM office.
 *
 * The three brand NAMES are public (the company markets Moxie, Joshua's and Mission). Which
 * fictional branch belongs to which brand is SYNTHETIC: it gives the model a real multi-brand
 * shape without implying anything about a real location.
 */
export type BrandId = "moxie" | "joshuas" | "mission";

export interface Brand {
  id: BrandId;
  name: string;
}

export const BRANDS: Brand[] = [
  { id: "moxie", name: "Moxie Pest Control" },
  { id: "joshuas", name: "Joshua's Pest Control" },
  { id: "mission", name: "Mission Pest Control" },
];

export const BRAND_BY_ID = new Map(BRANDS.map((b) => [b.id, b]));

export interface Branch {
  id: string;
  name: string;
  region: "West" | "Southwest" | "Mountain" | "Central" | "East";
  timezone: string;
  crmOfficeId: number;
  /** Relative lead volume, 0.6–1.6. */
  size: number;
  /** The brand the branch trades under (synthetic assignment, see BRANDS). */
  brandId: BrandId;
}

/** Synthetic brand assignment by branch number; every other branch trades as Moxie. */
function brandOf(branchNumber: number): BrandId {
  if (branchNumber >= 27 && branchNumber <= 31) return "mission";
  if (branchNumber >= 40) return "joshuas";
  return "moxie";
}

const NAMES = [
  "Alder", "Aspen", "Birch", "Briar", "Canyon", "Cedar", "Clover", "Cobalt", "Coral", "Cypress", "Driftwood",
  "Elm", "Fern", "Flint", "Garnet", "Glacier", "Granite", "Harbor", "Hazel", "Heron", "Indigo", "Ivy",
  "Jasper", "Juniper", "Kestrel", "Lark", "Laurel", "Linden", "Maple", "Meadow", "Moss", "Oak",
  "Onyx", "Orchard", "Pine", "Quarry", "Raven", "Ridge", "Sage", "Sierra", "Slate", "Spruce", "Summit", "Willow",
] as const;

const REGIONS: Array<{ region: Branch["region"]; timezone: string; count: number }> = [
  { region: "West", timezone: "America/Los_Angeles", count: 6 },
  { region: "Southwest", timezone: "America/Phoenix", count: 5 },
  { region: "Mountain", timezone: "America/Denver", count: 5 },
  { region: "Central", timezone: "America/Chicago", count: 15 },
  { region: "East", timezone: "America/New_York", count: 13 },
];

const SIZES = [1.4, 0.9, 1.1, 0.7, 1.3, 1.0, 0.8, 1.2, 1.6, 0.6, 1.0];

export const BRANCHES: Branch[] = (() => {
  const branches: Branch[] = [];
  let i = 0;
  for (const { region, timezone, count } of REGIONS) {
    for (let k = 0; k < count; k++, i++) {
      branches.push({
        id: `B${String(i + 1).padStart(2, "0")}`,
        name: NAMES[i],
        region,
        timezone,
        crmOfficeId: 101 + i,
        size: SIZES[i % SIZES.length],
        brandId: brandOf(i + 1),
      });
    }
  }
  return branches;
})();

export const BRANCH_BY_ID = new Map(BRANCHES.map((b) => [b.id, b]));
export const BRANCH_BY_OFFICE = new Map(BRANCHES.map((b) => [b.crmOfficeId, b]));

/** Branch ids of the given brands, in branch order. */
export function branchesOfBrands(brandIds: readonly BrandId[]): string[] {
  return BRANCHES.filter((b) => brandIds.includes(b.brandId)).map((b) => b.id);
}

export type ChannelCode =
  | "google_search"
  | "google_lsa"
  | "microsoft"
  | "meta"
  | "organic_gbp"
  | "organic_search"
  | "sponsorship"
  | "d2d"
  | "unknown";

/**
 * How a channel's effect CAN be measured, which decides what evidence a budget decision may
 * rest on (Decision Lab):
 *   * touch_attributed — each lead carries the touch (click id, tracked number): attribution
 *     can rank it, an experiment can prove it.
 *   * rep_recorded — the sale records who sold it (door-to-door): credit comes from the CRM.
 *   * landing_inferred — organic search and AI answers: the landing page or a "how did you
 *     hear" answer, never a click id. Directional only.
 *   * experiment_only — sponsorships, arena and brand media: no per-lead touch exists, so only
 *     a geo or holdout test can show an effect. Attribution must never rank it.
 *   * no_evidence — the Unknown bucket: no source said where the customer came from.
 */
export type MeasurementClass = "touch_attributed" | "rep_recorded" | "landing_inferred" | "experiment_only" | "no_evidence";

export interface Channel {
  code: ChannelCode;
  label: string;
  isPaid: boolean;
  costBasis: "media" | "commission" | "sponsorship" | "none";
  measurement: MeasurementClass;
}

export const CHANNELS: Channel[] = [
  { code: "google_search", label: "Google Search", isPaid: true, costBasis: "media", measurement: "touch_attributed" },
  { code: "google_lsa", label: "Google Local Services", isPaid: true, costBasis: "media", measurement: "touch_attributed" },
  { code: "microsoft", label: "Microsoft Ads", isPaid: true, costBasis: "media", measurement: "touch_attributed" },
  { code: "meta", label: "Meta", isPaid: true, costBasis: "media", measurement: "touch_attributed" },
  { code: "organic_gbp", label: "Google Business Profile (organic)", isPaid: false, costBasis: "none", measurement: "touch_attributed" },
  { code: "organic_search", label: "Organic search & AI answers (SEO/GEO)", isPaid: false, costBasis: "none", measurement: "landing_inferred" },
  { code: "sponsorship", label: "Sponsorships & brand media", isPaid: true, costBasis: "sponsorship", measurement: "experiment_only" },
  { code: "d2d", label: "Door-to-door", isPaid: false, costBasis: "commission", measurement: "rep_recorded" },
  { code: "unknown", label: "Unknown", isPaid: false, costBasis: "none", measurement: "no_evidence" },
];

export const CHANNEL_BY_CODE = new Map(CHANNELS.map((c) => [c.code, c]));

export const AD_PLATFORM_CHANNEL: Record<string, ChannelCode> = {
  google_ads: "google_search",
  google_lsa: "google_lsa",
  microsoft_ads: "microsoft",
  meta: "meta",
};

/** Scenario anchors, named once so the seed, the tests and the demo script agree. */
export const SCENARIO = {
  /** Branch whose call-tracking feed changes shape mid-period (the flagship incident). */
  callFeedDriftBranch: "B20",
  callFeedDriftFrom: "2026-10-06T00:00:00Z",
  /** Website zip→branch lookup still sends these zips to B06 after they moved to B07. */
  realignedFromBranch: "B06",
  realignedToBranch: "B07",
  /** A new LSA campaign launched without a campaign→branch mapping. */
  unmappedSpendBranch: "B44",
  /**
   * ChangeGuard, HYPOTHETICAL: this branch's Local Services campaign is migrated by Google into a
   * Performance Max campaign with pay-per-lead goals (a real 2026 Google change; the date and the
   * branch are invented). The migrated campaign arrives typed PERFORMANCE_MAX with local services
   * enabled, and ads@1.0 classifies it by platform, filing its spend as Google Search.
   */
  lsaMigrationBranch: "B09",
  lsaMigrationAt: "2026-10-13T00:00:00Z",
} as const;
