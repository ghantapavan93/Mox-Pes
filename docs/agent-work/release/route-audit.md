# Route audit (release WP-C step 0)

Measured 2026-11-18T15:27:58.093Z against http://localhost:3990. One row per route, role and width: the h1 and where it starts, the first visible primary action and where it starts, how many primary actions are visible, sideways scroll. "Below" means it starts past the first screen (900 px desktop, 844 px phone).

| Route | Role | Width | Status | h1 | h1 top | First primary action | Its top | Primaries | Sideways |
|---|---|---|---|---|---|---|---|---|---|
| `/` | guest | desktop | 200 | Where did the conversions go? | 88 px | — | — | 0 | no |
| `/` | guest | phone | 200 | Where did the conversions go? | 282 px | — | — | 0 | no |
| `/` | marketing | desktop | 200 | Where did the conversions go? | 88 px | — | — | 0 | no |
| `/` | marketing | phone | 200 | Where did the conversions go? | 282 px | — | — | 0 | no |
| `/branches/B09?period=oct` | guest | desktop | 200 | B09 Coral | 116 px | — | — | 0 | no |
| `/branches/B09?period=oct` | guest | phone | 200 | B09 Coral | 310 px | — | — | 0 | no |
| `/branches/B09?period=oct` | marketing | desktop | 200 | B09 Coral | 116 px | Investigate this branch | 97 px | 1 | no |
| `/branches/B09?period=oct` | marketing | phone | 200 | B09 Coral | 310 px | Investigate this branch | 446 px | 1 | no |
| `/branches/B09/trace?period=oct&metric=paid_cac` | guest | desktop | 200 | Where does $241.29 come from? | 116 px | Investigate this number | 212 px | 1 | no |
| `/branches/B09/trace?period=oct&metric=paid_cac` | guest | phone | 200 | Where does $241.29 come from? | 294 px | Investigate this number | 462 px | 1 | no |
| `/branches/B09/trace?period=oct&metric=paid_cac` | marketing | desktop | 200 | Where does $241.29 come from? | 116 px | Investigate this number | 212 px | 1 | no |
| `/branches/B09/trace?period=oct&metric=paid_cac` | marketing | phone | 200 | Where does $241.29 come from? | 294 px | Investigate this number | 462 px | 1 | no |
| `/exceptions` | guest | desktop | 200 | Incidents | 88 px | — | — | 0 | no |
| `/exceptions` | guest | phone | 200 | Incidents | 266 px | — | — | 0 | no |
| `/exceptions` | marketing | desktop | 200 | Incidents | 88 px | — | — | 0 | no |
| `/exceptions` | marketing | phone | 200 | Incidents | 266 px | — | — | 0 | no |
| `/exceptions/970` | guest | desktop | 200 | Unmapped spend | 99 px | — | — | 0 | no |
| `/exceptions/970` | guest | phone | 200 | Unmapped spend | 277 px | — | — | 0 | no |
| `/exceptions/970` | engineer | desktop | 200 | Unmapped spend | 99 px | Investigate with AI | 97 px | 2 | no |
| `/exceptions/970` | engineer | phone | 200 | Unmapped spend | 277 px | Investigate with AI | 449 px | 2 | no |
| `/decisions?branch=B20&period=oct` | guest | desktop | 200 | Decision Lab | 88 px | Open incident #1063 | 413 px | 1 | no |
| `/decisions?branch=B20&period=oct` | guest | phone | 200 | Decision Lab | 266 px | Open incident #1063 | 852 px (below) | 1 | no |
| `/decisions?branch=B20&period=oct` | marketing | desktop | 200 | Decision Lab | 88 px | Open incident #1063 | 413 px | 1 | no |
| `/decisions?branch=B20&period=oct` | marketing | phone | 200 | Decision Lab | 266 px | Open incident #1063 | 852 px (below) | 1 | no |
| `/decisions/opportunities` | guest | desktop | 200 | Revenue opportunities | 116 px | — | — | 0 | no |
| `/decisions/opportunities` | guest | phone | 200 | Revenue opportunities | 294 px | — | — | 0 | no |
| `/decisions/opportunities` | marketing | desktop | 200 | Revenue opportunities | 116 px | — | — | 0 | no |
| `/decisions/opportunities` | marketing | phone | 200 | Revenue opportunities | 294 px | — | — | 0 | no |
| `/integrations` | guest | desktop | 200 | Integrations | 88 px | — | — | 0 | no |
| `/integrations` | guest | phone | 200 | Integrations | 266 px | — | — | 0 | no |
| `/integrations` | engineer | desktop | 200 | Integrations | 88 px | — | — | 0 | no |
| `/integrations` | engineer | phone | 200 | Integrations | 266 px | — | — | 0 | no |
| `/onboarding` | guest | desktop | 200 | Data onboarding | 99 px | Upload and profileProfiling… | 524 px | 1 | no |
| `/onboarding` | guest | phone | 200 | Data onboarding | 277 px | Upload and profileProfiling… | 998 px (below) | 1 | no |
| `/onboarding` | marketing | desktop | 200 | Data onboarding | 99 px | Upload and profileProfiling… | 392 px | 1 | no |
| `/onboarding` | marketing | phone | 200 | Data onboarding | 277 px | Upload and profileProfiling… | 766 px | 1 | no |
| `/onboarding/5` | guest | desktop | 200 | This upload is not available | 99 px | Upload a file | 203 px | 1 | no |
| `/onboarding/5` | guest | phone | 200 | This upload is not available | 277 px | Upload a file | 421 px | 1 | no |
| `/onboarding/5` | marketing | desktop | 200 | mixed-garbage.csv | 116 px | — | — | 0 | no |
| `/onboarding/5` | marketing | phone | 200 | mixed-garbage.csv | 294 px | — | — | 0 | no |
| `/investigator` | guest | desktop | 200 | AI Investigator | 88 px | — | — | 0 | no |
| `/investigator` | guest | phone | 200 | AI Investigator | 266 px | — | — | 0 | no |
| `/investigator` | marketing | desktop | 200 | AI Investigator | 88 px | — | — | 0 | no |
| `/investigator` | marketing | phone | 200 | AI Investigator | 266 px | — | — | 0 | no |
| `/changes` | guest | desktop | 200 | ChangeGuard | 99 px | — | — | 0 | no |
| `/changes` | guest | phone | 200 | ChangeGuard | 277 px | — | — | 0 | no |
| `/changes` | engineer | desktop | 200 | ChangeGuard | 99 px | — | — | 0 | no |
| `/changes` | engineer | phone | 200 | ChangeGuard | 277 px | — | — | 0 | no |
| `/assurance` | guest | desktop | 200 | Check another system's figure or answer | 88 px | — | — | 0 | no |
| `/assurance` | guest | phone | 200 | Check another system's figure or answer | 266 px | — | — | 0 | no |
| `/assurance` | marketing | desktop | 200 | Check another system's figure or answer | 88 px | — | — | 0 | no |
| `/assurance` | marketing | phone | 200 | Check another system's figure or answer | 266 px | — | — | 0 | no |
| `/audit` | guest | desktop | 200 | Audit & Health | 88 px | — | — | 0 | no |
| `/audit` | guest | phone | 200 | Audit & Health | 266 px | — | — | 0 | no |
| `/audit` | engineer | desktop | 200 | Audit & Health | 88 px | — | — | 0 | no |
| `/audit` | engineer | phone | 200 | Audit & Health | 266 px | — | — | 0 | no |
| `/customers` | guest | desktop | 200 | Customer Journeys | 88 px | — | — | 0 | no |
| `/customers` | guest | phone | 200 | Customer Journeys | 266 px | — | — | 0 | no |
| `/customers` | marketing | desktop | 200 | Customer Journeys | 88 px | — | — | 0 | no |
| `/customers` | marketing | phone | 200 | Customer Journeys | 266 px | — | — | 0 | no |
| `/customers/417057` | guest | desktop | 200 | Customer 417057 | 89 px | — | — | 0 | no |
| `/customers/417057` | guest | phone | 200 | Customer 417057 | 267 px | — | — | 0 | no |
| `/customers/417057` | marketing | desktop | 200 | Customer 417057 | 89 px | — | — | 0 | no |
| `/customers/417057` | marketing | phone | 200 | Customer 417057 | 267 px | — | — | 0 | no |
| `/definitions` | guest | desktop | 200 | Definitions | 88 px | — | — | 0 | no |
| `/definitions` | guest | phone | 200 | Definitions | 266 px | — | — | 0 | no |
| `/definitions` | marketing | desktop | 200 | Definitions | 88 px | — | — | 0 | no |
| `/definitions` | marketing | phone | 200 | Definitions | 266 px | — | — | 0 | no |
| `/demo` | guest | desktop | 200 | The four-minute path: B09 | 69 px | — | — | 0 | no |
| `/demo` | guest | phone | 200 | The four-minute path: B09 | 247 px | — | — | 0 | no |
| `/demo` | marketing | desktop | 200 | The four-minute path: B09 | 69 px | — | — | 0 | no |
| `/demo` | marketing | phone | 200 | The four-minute path: B09 | 247 px | — | — | 0 | no |
| `/feedback` | guest | desktop | 200 | Google Ads conversion feedback | 88 px | — | — | 0 | no |
| `/feedback` | guest | phone | 200 | Google Ads conversion feedback | 266 px | — | — | 0 | no |
| `/feedback` | marketing | desktop | 200 | Google Ads conversion feedback | 88 px | — | — | 0 | no |
| `/feedback` | marketing | phone | 200 | Google Ads conversion feedback | 266 px | — | — | 0 | no |

## Failures, and where each is fixed

| Route | Failure | Fixed in |
|---|---|---|
| `/onboarding` · guest · phone | The one primary action ("Upload and profile") starts at 998 px, below the first screen: a long intro and the workspace note sit above the upload card | WP-D: a shorter intro, the upload card before the workspace note. Measured again with `harness/guest-first-screen.cjs`: 674 px at 390 × 844, 344 px at 1440 × 900 |
| `/onboarding/[id]` · guest, after a dry run (not in the table: the audit opened a staff upload, which a visitor cannot) | The result's next action came after the long workspace note | WP-D: the next action comes before the note, and a badge names the workspace beside "Result". The action starts at 660 px at 390 × 844 and 378 px at 1440 × 900; the card itself at 426 px and 224 px; one visible primary |
| `/exceptions/970` · engineer, both widths | Two visible primary actions | WP-E (incident page) |
| `/decisions?branch=B20&period=oct` · phone | The primary action starts at 852 px, just below the first screen | WP-E (Decision Lab phone order) |
| `/` · every role | No primary action on the Overview | WP-C steps 1–2 decide the Overview's one next action with the chart's select-then-open |

Every route keeps its h1 inside the first screen and none scrolls sideways. On a phone the demo
shell (brand, search, menu, scope and the role picker) takes about 220 px above every page; the
hosted demo has no role picker, so its shell is one row shorter.
