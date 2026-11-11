# Buy, configure, integrate, or build

Written as the VP of Technology would read it: *"What does this do that our existing stack
cannot already do well?"* Labels: **VERIFIED** (public evidence checked), **REPORTED** (a vendor
or third party says so), **INFERRED**, **UNKNOWN**. Market research was done from public sources
in November 2026; no vendor was contacted. Moxie's internal stack is **UNKNOWN** except what
public website tags show.

## What is publicly visible

| Fact | Label |
|---|---|
| CallRail call and form tracking on the website | VERIFIED (site tags) |
| Google Ads (many conversion tags), GA4, Meta, Microsoft, Reddit and other ad tags | VERIFIED (site tags) |
| FieldRoutes as the CRM | INFERRED (customer portal points to it) |
| A warehouse or BI layer (Fabric, Power BI, Snowflake) in use | UNKNOWN (the job post lists them as desirable) |
| Whether the ad spend → booked job → collected revenue loop is closed today | UNKNOWN; the job post's wording suggests it is not (a hypothesis to ask about, not a finding) |

## The market, in one paragraph

Closed-loop "ad → call → booked job → revenue" products exist for **ServiceTitan** (Marketing Pro
Ads, REPORTED) and for **PestPac** (agency-bundled ROI reporting, REPORTED). No equivalent was found
for **FieldRoutes + CallRail** (a defensible search, not proof of absence). No managed ELT connector
for FieldRoutes was found in Fivetran or Airbyte (REPORTED). Generic data-quality tools (dbt tests,
Soda, Monte Carlo, Great Expectations) check tables, not the cross-system chain "this call should
have become this customer, this payment". Reverse-ETL tools (Hightouch, Census) can send
conversions to Google once a model says which conversions and what value. That model is the hard
part. Google is moving offline conversion uploads to the Data Manager API (VERIFIED), so any new
upload path must target it.

## Decision matrix

| Capability | Existing alternative | Class | Complexity | Run cost | Vendor dependency | Value | Recommendation |
|---|---|---|---|---|---|---|---|
| Executive revenue dashboards | Power BI / Fabric, the CRM's own dashboards | 1. Existing platform sufficient | Low | Existing licences | Microsoft | Low as a new build | **Do not build.** Feed Power BI the verified views (`reporting.*_v1`) instead |
| Call tracking, DNI, call summaries | CallRail (incl. conversation intelligence) | 1. Sufficient | — | Existing | CallRail | — | **Do not build** |
| Lead follow-up nudges | Hatch, Podium, CallRail, FieldRoutes tasks | 2. Configure | Low | Per seat | Vendor | Medium | **Configure** what is owned; measure with a pilot (see Decision Lab) |
| Moving CRM data into a warehouse | Fivetran/Airbyte (no FieldRoutes connector found), custom pipeline, Tray.ai | 3. Integrate | Medium | Infra + upkeep | Low if custom | High, prerequisite | **Integrate**: the connector here (checkpoints, fencing, replay) is a template; host it in the existing ELT (Python/Dagster or Fabric pipelines) |
| Table-level data tests | dbt tests, Soda, Great Expectations | 2. Configure | Low | Free/OSS | Low | Medium | **Use them** for table checks; do not rebuild |
| **Cross-system revenue lineage**: call → customer → appointment → payment, with typed exceptions | None found for FieldRoutes + CallRail | 4. Custom justified *if* absent | Medium–high | Low (Postgres + jobs) | None | **High**: it decides which ad dollars are real | **Build**, the narrowest defensible custom capability, **after confirming** Moxie lacks it |
| **Bring-your-own-export lab** (profile, semantic mapping, dry run, ledger comparison) | Spreadsheets; Fabric dataflows; ad-hoc SQL; generic AI chat over a CSV | 4. Custom justified for the *comparison against the ledger* | Medium | Low | None | Medium–high: turns "the export disagrees" into a listed, cent-exact answer in minutes | **Build** the comparison and refusal rules; reuse the warehouse for storage at scale |
| Conversion feedback to Google with real revenue | Hightouch/Census + a model; CallRail native (no CRM revenue) | 3. Integrate | Medium | Per-row pricing | Reverse-ETL vendor | High | **Integrate**: build the model (which conversion, which value, restatements), send it with whatever Moxie already owns, against the Data Manager API |
| AI investigator over the evidence | ChatGPT/Claude on exports; Copilot in Power BI | 5. Discovery | Medium | Tokens | Model provider | Unproven | **Discover first.** Only valuable with grounding (cited evidence), permissions and an evaluation; the deterministic path already answers the tested cases |
| Causal "what if we move budget" | Platform experiments (Google conversion lift), geo tests | 2. Configure | — | Media cost | Platforms | High | **Use platform experiments**; the Decision Lab plans and checks them, it does not replace them |

## The honest bottom line

Most of what a revenue-intelligence demo shows is **already sold**. The part that is not, for this
stack, is the **lineage and its exceptions**: proving which spend became which collected dollar,
and saying precisely where the chain breaks. The onboarding lab extends that to exports nobody
designed for. Neither should become a second source of financial truth: the CRM and the ad
platforms stay authoritative, and verified outputs should land in the warehouse and BI Moxie
already runs.

**What would change this recommendation:** if Moxie already has lineage in its warehouse (dbt
models joining CallRail to FieldRoutes), the right work is to harden that, not to build this.
That is the first question to ask.
