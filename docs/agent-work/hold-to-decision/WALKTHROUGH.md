# The 90-second walkthrough

Ninety seconds, on the isolated world from `GUIDE.md`. Every number on screen comes from the
fixture's synthetic records. Start with the world advanced to **Partial** (`advance.ts partial`),
the role set to Marketing analyst, and the Overview open at `/?period=oct&branch=B09`.

The opening line about B20 is optional. B09 at 5 of 18 days is the first thing you click.

| Time | Do | Say |
|---|---|---|
| 0:00–0:10 (optional) | Overview, all branches | "B20's reported paid CAC went from $296.58 in September to $490.11 in October. Before anyone acts on it, the product holds that decision: 119 call records failed validation and 53 new customers lost the lead record that credits them. A jump like that can be measurement, not marketing." |
| 0:10–0:25 | Overview, B09: read the status line | "B09 is a synthetic scenario. Google is moving eligible Local Services advertisers to Performance Max campaigns with pay-per-lead goals. Our older mapper filed that spend under Google Search; Google didn't. The product says *Still on hold · 5 of 18 days verified*." |
| 0:25–0:40 | Open the incident (**Open incident #…**). Point at the headline and the reason | "Oct 26 to Oct 30 are covered. The decision needs the whole window, Oct 13 to Oct 30, and 13 dates still have no record. Five good days are not enough." |
| 0:40–0:55 | Click the one primary action, **Open the records for Oct 12–Oct 18** | "These dates say *no spend record*. That is not $0: no record says what the channel spent." |
| 0:55–1:15 | In a terminal: `advance.ts rest`. Reload the incident, then **Open decision readiness** | "The source re-sent the rest. *Coverage hold cleared · 18 of 18 days verified*: $2,123.52 moved from Search to Local Services, no amount changed, and B09's October spend stayed $16,649.23. Decision Lab says *Ready for review*, and *Nothing here approves a budget change*. Two checks are still open." |
| 1:15–1:30 | In a terminal: `advance.ts refused`. Reload Decision Lab | "Now the source sends a newer Oct 20 revision, and intake refuses it. The ledger keeps the $120.91 it had, and never counts the refused $400. The decision is held again until a newer revision is accepted." |

## What not to say

- That the cleared hold approved anything. It means a person may review the decision.
- That the correction added money. It moved $2,123.52 between channels and changed no amount.
- That the product disputes leads or tracks a dispute deadline. It does neither. Google describes
  a 30-day lead-quality assessment for these campaigns and no manual disputes.
- That the spend caused customers. Effectiveness stays "unknown" without an experiment.

## References

- Google Ads Help, "Local Services Ads transition to Performance Max campaigns with pay-per-lead
  goals": https://support.google.com/google-ads/answer/17213585
- Google Ads Help, "How leads work in Performance Max campaigns with pay-per-lead goals":
  https://support.google.com/google-ads/answer/18550592
