# Cold review of the Preview (WP-J step 7), 2026-11-18

A fresh agent with no coaching drove the project owner's Chrome on the Preview deployment of
`bd6acef` (release database `release-2026-11-18`, as loaded), with three questions and no other
help. It took about 19 minutes and cleaned up its own upload.

## Its answers

1. **What counted on upload** (about 6 minutes). It uploaded a synthetic export, answered the two
   questions the file could not, and read: "8 of 8 rows passed every check… 2 match the ledger and
   0 differ"; six rows "Would count after staff approval (local demo only)"; and "On the public
   demo a file is compared, never counted." It checked the file itself and agreed. **Answered.**
2. **Why a decision was held** (about 6 minutes). B44 Willow, held by incident #970: a campaign
   that spent $4,539 maps to no branch. It traced paid CAC on `/branches/B44/trace` to
   "$9,443.43 … ÷ 40 new paid customers = $236.09", with every campaign and customer named by its
   raw record. **Answered.**
3. **What a correction proved** (about 7 minutes). **Not answerable:** the hosted copy held no
   executed correction. `/audit` showed no execution, `/changes` none, and `/demo` described B09's
   fix as still open; a guest cannot run one.

## What was done with each point

| # | Point | Done |
|---|---|---|
| Q3 | No approved correction on the hosted copy | **Fixed** (`8ae6776`): `npm run db:correct-hosted` runs B20's fix through the Action Center on the loaded copy, as the demo roles would; the release branch now holds incident #1063 corrected and approved, with October's receipt ($490.11 → $271.31 on the same spend and 109 customers) and its audit trail. In the deploy guide's load step |
| 6 | The trace page showed "B44 Willow (joshuas)": brand ids are slugs of real companies | **Fixed** (`df7c0c3`): the trace scope and the change pages name the fictional brand. The ids stay in URLs and the database: a rename is a follow-up |
| 6 | Internal labels on the trace page: "business-fit fixture", "held-out IV-26", "audit D-3" | **Fixed** (`df7c0c3`): the paid CAC definition's history in plain words |
| 8 | Guests told "Propose one above" (`/changes`) and "Enter a figure or an answer above" (`/assurance`) with no form | **Fixed** (`df7c0c3`): read-only roles read that nothing has been proposed or run in their scope |
| 9 | `/audit` and `/integrations` showed `http://localhost:3000/api/mock/fieldroutes` on a deployment | **Fixed** (`df7c0c3`): named as this app's FieldRoutes mock (local demo) |
| 10 | `/demo` cited `tests/fixtures/b09-golden.json` | **Fixed** (`df7c0c3`) |
| 11 | `/exceptions?state=closed`: the State filter read "Active" beside the chip "State: all closed" | **Fixed** (`df7c0c3`): the uncontrolled select remounts with its value after a link changes the URL |
| 1 | `/`: "1,361 are serviced customers" beside "÷ 1,724 new customers" with no word on why they differ (the bridge follows the period's paid prospects; the CAC counts customers serviced in the period whose first evidenced touch was paid) | Recorded: a follow-up sentence on the Overview |
| 2 | The Overview's "incident #970" appears as "#131 · company" on `/exceptions`; case #141 opens `/exceptions/1333` | Recorded: incidents and cases are numbered apart; one visible number per incident is a follow-up |
| 3 | B44's paid channel rows add to 42 customers, the branch figure divides by 40, and Local Services' $183.36 still divides by 12 including the 2 the branch leaves out | Recorded: the channel rows count customers the branch figure excludes (unmapped campaign); stating that on the row is a follow-up |
| 4 | B44's "Open exceptions" leaves out #970, which holds its budget | Recorded: #970 is company-level (no branch owns the campaign); the branch page should name it beside its own |
| 5 | Decision Lab B44: "Budget signal, among verified channels… 1.7×" while every channel is "Not ready"; "Pass: No open coverage gap…" beside the unmapped-spend warning | Recorded: wording follow-up |
| 7 | `/exceptions/1063`: "MISSING_FIELD call.customer_phone_number" while every stored record has the number under `caller.number` | Recorded: that is the incident (the feed renamed the field); the evidence should say so in a sentence |
| 12 | `/onboarding/[id]`: an unmapped column ("Talk Seconds") is not said to be ignored | Recorded: follow-up |

Also found by the release smoke, recorded: the deterministic answer to "Why did B20's CAC jump in
October?" withholds its summary (its own finding about paid customers 57 → 31 fails the figure
check, which reads the metric as all new customers); production's build `1814616` does the same on
this data. And Back from a ledger link on the upload result restores the scroll position, not focus.
