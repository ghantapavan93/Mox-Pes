import { describe, expect, it } from "vitest";
import { isCausalImpactClaim } from "@/lib/ai/analyst";

/**
 * The grounding rule that drops an AI conclusion that something CAUSED a business improvement
 * (only a measured experiment can show that). It is a phrase rule, not understanding: these
 * cases pin both directions, including the ones an independent review found slipping through
 * (decimals, "May" read as a hedge, "caused revenue to rise", "cut CAC") and the reporting
 * statements it must not drop.
 */
const CAUSAL = [
  "The mapping change increased revenue at B44 by $12,000.",
  "Revenue rose 8% after the release because of the corrected campaign mapping.",
  "Revenue rose 12.5% after the remap.",
  "The remap boosted revenue 20% in May.",
  "The new mapping caused revenue to rise.",
  "The fix added 40 new customers.",
  "The corrected mapping cut CAC by 30%.",
  "The release brought in 12 more paying customers.",
  "This change led to more conversions at B09.",
];
const NOT_CAUSAL = [
  "The change may have increased revenue; this is not measured.",
  "119 records quarantined; 53 new customers lose their lead record.",
  "The ads@1.0 mapper caused 53 customers to lose their channel credit.",
  "Paid CAC at B09 moved from $267 to $490 after the reclassification.",
  "Unmapped spend grew to $4,200 with no customers attributed.",
  "Campaign 88 generated 41 leads and 0 customers.",
  "Paid customers increased from 3 to 5 after the remap in the preview.",
  "Spend of $4,539.34 is unallocated because the campaign has no branch mapping.",
];

describe("causal business-impact claims", () => {
  it.each(CAUSAL)("drops: %s", (text) => expect(isCausalImpactClaim(text)).toBe(true));
  it.each(NOT_CAUSAL)("keeps: %s", (text) => expect(isCausalImpactClaim(text)).toBe(false));
});
