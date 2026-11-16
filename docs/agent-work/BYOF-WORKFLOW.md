# Bring your own file: one cold-start workflow (2026-11-15)

**Verdict: Works unaided with an unseen synthetic export.**

The walk began on an empty workspace, in a scripted browser. There, the valid file, a
Canadian-dollar problem and the repeat upload each gave the frozen result: 54 of 54 checks, and
nothing was added to the ledger. Two scripted agent reviews explained the result and traced it to the
file. No person has tried it, so human usability is not claimed.

In the full regression every step exited 0 except the browser suite. Each of its two runs failed a
different timing-sensitive check, in code this workflow does not touch, and each test passed in one
of the two runs (§7).

**Since 2026-11-16:** both checks were reproduced and fixed (`SUITE-STABILIZATION.md`). The drift
review's focus was an app bug; the replay clicks' fixed window was a test bug. The candidate with
the fixes, `d431e9b`, passed the full regression in one run. It is now the accepted local synthetic
demo checkpoint (`RELEASE-CANDIDATE.md` §8).

The accepted local synthetic demo stays `28e498b`. This workflow adds, on top:

| Commit | What |
|---|---|
| `b76b931`, `c33953b` | The unseen export and its expected totals, frozen before the first upload |
| `e8a6492` | The fix: the currency column is read, and the result comes first |
| `284c46e` | The runner |
| `e1a2ae4` | Corrections after the two scripted reviews |
| `60cb483` | Lint ignores the committed evidence harnesses |

Nothing else was reopened: B09, Decision Lab and the Overview are untouched.

**The repeatable command**, from a fresh clone or worktree with Postgres as the README sets it up:

```bash
npm ci
```

```bash
npx playwright install chromium
```

```bash
npm run acceptance:byof
```

It starts from an empty workspace (`revenue_signal_acceptance_byof`: migrations only, no seed).
It builds the checkout and serves it on its own port, 3991, refusing the demo database and a busy
port. Then it walks the journey below through the real UI. The record goes to
`test-results/acceptance-byof/results.json`, with screens at 1280 and 390 px.

## 1. Five questions, answered before editing

These answers come from the code and a browser walk. The walk ran the accepted build (`28e498b`)
on an empty, migrated-only database: no branches, channels, ledger records, clock or currency
rules.

**1. Can an analyst find the upload flow unaided? Which files and vendor shapes work?**
- **Finding it.** Yes, with one demo-mode step:
  - the Overview's sidebar lists **Data onboarding** under Systems (`/onboarding`);
  - the default demo visitor is a guest, and the page answers "403 — not in your scope: Data
    onboarding is limited to company-wide analyst, engineer and approver roles"
    (`app/onboarding/page.tsx:38`);
  - choosing **Marketing analyst** in the header's "Viewing as" picker
    (`components/RoleSwitcher.tsx`) shows the upload form (`components/onboarding/UploadForm.tsx`);
  - a real deployment would sign the analyst in instead (R-2).
- **File types** (`lib/onboarding/parse.ts`, `lib/onboarding/limits.ts`):
  - CSV, TSV or TXT; XLSX (macro-enabled files are refused); JSON;
  - up to 5 MB, 50,000 rows and 200 columns;
  - UTF-8, or Windows-1252 with a warning; comma, semicolon or tab delimiters;
  - title lines above the header are skipped, and total rows are excluded.
- **What a file can be** (`lib/onboarding/targets.ts`):
  - tracked calls and web leads, publishable after an independent approval;
  - CRM payments and ad spend, **compare only**;
  - ad platforms: Google Ads, Google Local Services, Microsoft Ads, Meta.
- **Shapes shown to work** (all synthetic):
  - `public/samples` (Google Ads daily, Meta spend with semicolons, call tracking, CRM payments);
  - the held-out fixtures in `tests/fixtures/onboarding/holdout`;
  - now this Microsoft Advertising-style daily report.
  No real vendor export has been tried (R-1).

**2. What does the file settle, and what must the user confirm?** For an ad report:

| | Settled by the file | The user confirms |
|---|---|---|
| Source and platform | The dataset is suggested (Ad spend by day) | The platform: the report has no platform column, so it is one fixed value for every row |
| Account or branch | The account, from a column ("Account number") | Nothing more. An ad report has no branch: a branch comes from campaign mappings, which an empty workspace lacks, so the file attributes no spend to a branch (`lib/onboarding/ledger.ts`, `branchOfProjection` returns null for spend) |
| Date range | The days, from the rows | Whether 10/12/2026 is month-first (`DATE_ORDER_REQUIRED`), and when the report was exported (`EXPORT_TIME_REQUIRED`: platforms restate recent days) |
| Currency | Since `e8a6492`, the "Currency code" column, mapped by the assistant | Nothing. A file without one is read as US dollars, and the result says so |
| Required columns | Campaign ID and name, day, cost, clicks, conversions are suggested from headers and values | What the cost column means: ad cost, not cash or revenue (`MONEY_MEANING_UNCONFIRMED`). For this file also the day column: on first contact the assistant did not match "Gregorian date" |

**Silent assumptions found:**
1. **Currency.** A "Currency code" column was never read; only a currency written inside the cost
   cell was refused (`lib/onboarding/values.ts`, `parseMoneyText`). So a Canadian-dollar account
   was summed as US dollars. This is fixed (§4). Still assumed: a file with no currency column is
   read as US dollars. The conclusion now says so. When no other rows are held back, the limitation
   adds that the live feed would hold those days until someone confirms the account's currency.
2. **An empty ledger read as agreement.** The step rail said "0 differ from the ledger" when the
   ledger held none of the rows. This is fixed (§4).
3. **The export time and the account are what the user types.** They are trusted as stated.
4. **"Conversions" are the platform's claims, not verified customers.** The field label says so.

**3. Where do the rows go? What does the first screen prove, and what not?**
- **Staged rows:** the cells sit in `onboarding_rows` for up to 24 hours, then are deleted, as
  they are on publication or rejection (`lib/onboarding/service.ts`, `purgeExpired`).
- **Dispositions:** the dry run gives every row exactly one, in `onboarding_row_results`:
  - eligible (validated);
  - needs correction (including a report's total line and text lines);
  - quarantined (refused by the live mapper, for example `CURRENCY_UNSUPPORTED`);
  - duplicate in file (counted once); conflict in file;
  - matches or differs from the ledger.
- **Accepted records:** none, for ad spend. A spend file is compared, never published:
  `publishUpload` refuses compare-only datasets. After all three uploads, `raw_events`,
  `ad_spend_daily`, `ad_campaigns`, `leads` and `crm_payments` hold no rows.
- **What the first screen proves, since `e8a6492`:**
  > 42 campaign-days of Microsoft Ads spend, Oct 12–Oct 25, 2026: $3,548.80 in US dollars. 3
  > campaigns in account B0123456. Every row passed the checks the live feed applies. The ledger
  > holds none of them, so nothing was compared. Nothing was added to the ledger.
- **What the same file does not let us claim:**
  - that the spend is right or complete, since nothing independent was compared;
  - which branches it belongs to;
  - leads, customers, cost per customer, ROI, or any budget decision.

**4. Can the analyst open the evidence and come back? What needs a seed, a script or a narrator?**
- **Evidence and return:** the result's one next action opens the rows behind it
  (`?rows=eligible#rows`), with every row's disposition and reason. Back returns to the result.
  The runner checks this for each upload.
- **The limit:** the rows table shows dispositions and reasons, not each day's cost. An analyst
  cannot re-add $3,548.80 on screen; the engineering trace (§6) did it from the database.
- **Seed:** none.
- **Script:** none. The samples are optional; this proof used the file input.
- **Narration:** none, except knowing to take the analyst role in the demo, which the 403 page
  names.

**5. Can an R-54 defect reach this path?**
- **(1) A successor that starts before the stop:** not on this path. There is no coverage gap or
  verification here.
- **(2) A newer revision the mapper refuses, leaving the older amount accepted:** on this path a
  refused row is shown as not counted and left out of the total, and nothing is accepted, so no
  stale amount can stay. The Canadian-dollar rows exercise exactly this refusal.
- **(3) A re-sent version with a reformatted fetch time, stored as new:** nothing is stored on this
  path. The duplicate upload gives the same result and adds nothing.
- **R-54's code-inspected future-date case:** the dry run refuses future-dated rows
  (`FUTURE_TIMESTAMP`).

So the path previews safely and certifies no decision. The product says so on the first screen:
"compare only", "Nothing was added to the ledger", and the limitation that spend alone does not
tell leads, customers or cost per customer.

## 2. The unseen export, frozen before testing

`tests/fixtures/byof/generate.py` writes the export with plain Python and Decimal, and no product
code. The file is a synthetic Microsoft Advertising-style daily campaign report:
- eight report-title lines above the header;
- US month-first dates;
- a "Currency code" column;
- a "Total" row and a copyright line.

**What was frozen.** `expected.json` was committed in `b76b931` before the first upload, and kept
byte-exact by `c33953b`:

| File | Rows | Scope | Exact total |
|---|---|---|---|
| `microsoft-ads-daily.csv` | 42 data rows, plus a Total row and a copyright line | 3 campaigns, account B0123456, USD, Oct 12–Oct 25 2026 (14 days); no branch | **$3,548.80**; 1,089 clicks; 106 conversions |
| `microsoft-ads-daily-two-accounts.csv` | The same, but one campaign belongs to a second account in Canadian dollars | 28 US-dollar rows; 14 CAD rows | **$2,674.02** in US dollars; the 874.78 CAD must never be summed as dollars |
| The valid file again | — | — | The same result; the ledger unchanged; nothing counted twice |

**How "unseen" it is.** The importer had never received this file. Its header vocabulary ("Gregorian
date", "Spend", "Currency code") does appear in the mapping-evaluation sets
(`tests/fixtures/onboarding/mapping-eval.v2/v3.json`), so the assistant has met similar headers.

## 3. The journey before the fix: 33 of 47

**The run:** `docs/agent-work/byof/before-c33953b/`, the runner against the product as accepted.

**What already worked:**
- the cold start;
- discovery and the role step;
- the upload through the file input;
- the review questions;
- the stored dry run of the valid file (42 rows, $3,548.80);
- nothing reaching the ledger;
- the duplicate's identical result.

**What failed:**
- **The Result step.** After "Save mapping version and dry-run", the reader was left on the
  mapping form, with the dry run's counts below it (`2-result-valid-desktop-1280.jpg`). Nowhere
  did the page state the conclusion. It showed "0 differ from the ledger" for an empty ledger, and
  "Needs correction 2" for the report's Total row and copyright line. Back from the rows did not
  return to a result.
- **The Canadian-dollar file.** All 42 rows were counted, and the total was **$3,548.80**: 874.78
  CAD summed as US dollars.

## 4. The first blocker, and what changed (`e8a6492`)

**The first blocker: no correct result could be stated.** The currency column was not read, so a
report with a non-US-dollar account produced a wrong total that nothing flagged. And no result was
shown at all: the reader was left on the form.

**The fix:**
- **The currency column goes to the live rule.** It is an optional field, mapped by the assistant
  (`lib/onboarding/targets.ts`). Its code goes to the deployed mapper, which already refuses any
  currency but USD with `CURRENCY_UNSUPPORTED` and converts nothing (`lib/onboarding/compile.ts`):
  one validation path, as for a live delivery.
- **The result comes first.** The upload page leads with a Result card once a dry run exists, and
  lands the reader on it after the run (`app/onboarding/[id]/page.tsx`,
  `components/onboarding/MappingEditor.tsx`). It holds:
  - one verified conclusion, from the dry run's own figures and its new spend scope
    (`lib/onboarding/service.ts`);
  - one limitation;
  - one next action.
  The profile, mapping, counts and every row stay below it.
- **The empty comparison is named.** The step rail now says "Nothing to compare: the ledger holds
  none of these rows".
- **Text lines are not errors.** A line with one filled cell at most (a title, a note, a copyright
  line) is left out as a text line, not put to the user as a row to correct.

**Tests:**
- `tests/integration/onboarding.test.ts` has two tests that failed before
  (`byof/currency-before-fix.txt`) and pass after (`byof/currency-after-fix.txt`).
- The existing onboarding tests and the mapping-evaluation gates pass unchanged.

**Corrected after the scripted reviews (`e1a2ae4`, §6):**
- **A false statement.** On the two-account result, "Every row passed the checks the live feed
  applies" stood beside "14 rows were not counted". It now reads "The 28 counted rows passed …".
- **An empty comparison shown as done.** The step rail showed "Reconcile with ledger · Done" with
  a green dot when the ledger held none of the rows. It now reads "Nothing compared", with a
  neutral dot.
- **A risk the text-line rule created.** A one-cell line inside the data may be a record whose
  delimiter broke. Only one-cell lines after the last record-shaped line are text lines now; a new
  test pins both cases.
- **The currency assumption, stated in the conclusion.** When no currency column was mapped, the
  conclusion itself says "read as US dollars (no currency column was mapped)". The limitation slot
  can hold something else, so the assumption cannot hide behind it.

**Lint (`60cb483`).** The full regression on `284c46e` stopped at lint (`byof/verify-284c46e-stopped.txt`).
`npm run lint` had failed since `76c5820`, because the B09 proof's evidence harness, a CommonJS
`.js` sentinel, sits under `docs/agent-work/`. Harness folders are now ignored as records. The
accepted `28e498b` predates them.

## 5. The journey after the fix, from a fresh worktree: 54 of 54

**The final run.** `docs/agent-work/byof/60cb483/` (record, report, screens, log):
- **Setup:** `git worktree add --detach C:/Temp/rso-byof2 60cb483`, then `npm ci` (exit 0) and
  `npx playwright install chromium` (exit 0).
- **The command:** `npm run acceptance:byof`, exit 0 in 61 s.
- **Result:** 54 of 54 checks, no console or page errors.
- **Isolation:** the demo database was unchanged before and after (`proof.log`).

**The earlier run,** at `284c46e` before the review corrections, passed 50 of 50
(`byof/284c46e/`), and is kept as recorded.

| Upload | First screen (1280 and 390 px) | Accepted | Refused or not counted | Ledger |
|---|---|---|---|---|
| Valid file | "42 campaign-days of Microsoft Ads spend, Oct 12–Oct 25, 2026: $3,548.80 in US dollars." Limitation: compare only; spend alone does not tell leads, customers or cost per customer. Next: "See the 42 rows behind this result" | 42 rows, as validated, compared, never added | The Total row and the copyright line, as lines that are not records | 0 rows |
| Two accounts | "28 campaign-days … $2,674.02 in US dollars." "The 28 counted rows passed the checks the live feed applies." Limitation: "14 rows were not counted: they are stated in CAD, and only US dollars are summed. Nothing is converted." Next: "Review the 14 rows not counted" | 28 US-dollar rows | 14 CAD rows, quarantined `CURRENCY_UNSUPPORTED` | 0 rows |
| Duplicate | The same as the valid file: 42 rows, $3,548.80 | The same 42 | The same 2 lines | 0 rows; no total adds the two uploads |

**What every upload checked:**
- no figure for leads, customers, CAC, ROI or a budget recommendation;
- exactly one next action on the first screen;
- a stated limitation;
- no "0 differ from the ledger", and no "Reconcile with ledger · Done", when nothing was compared;
- for the two-account file, no "Every row passed" beside rows not counted;
- the rows behind the result open, and Back returns to it;
- the assistant mapped the "Currency code" column without the user touching it;
- at 390 px, the total is on the first screen with no sideways scroll.

**What the user answered.** They set the platform (Microsoft Ads, as a fixed value), what "Spend"
means (ad cost), the date order (month first) and the export time. On first contact they also set
the day column. The assistant set the rest.

## 6. Cold reviews (scripted: independent agents, not people)

Two read-only agents ran on the `284c46e` run. Neither was given the expected totals or anyone's
conclusions. They are scripted reviews; no person has tried the workflow.

### Marketing: images only, no narration

The agent was asked to explain each result as an analyst would, from the seven screenshots alone.

**It stated every result correctly:**
- **Upload 1:** "42 campaign-days of Microsoft Ads spend, Oct 12–Oct 25, 2026: $3,548.80 in US
  dollars". It added that nothing was compared and nothing was added, and that "spend alone does not
  tell leads, customers or cost per customer".
- **Upload 2:** "$2,674.02 in US dollars", with "14 rows were not counted: they are stated in CAD".
- **Upload 3:** the same as upload 1; no total changed.

**It used no figure for a budget decision:** "unreconciled, unapproved and has no outcome data".

**What it found misleading:**

| Finding | Status |
|---|---|
| "Every row passed the checks" stood beside "14 rows were not counted" | Corrected in `e1a2ae4` |
| "Reconcile with ledger · Done" reads as reconciled, though nothing was compared | Corrected in `e1a2ae4` |
| Upload 2's $2,674.02 may be quoted as the whole file's total | §8 |
| The repeat upload is not flagged | §8 |
| "42 new" for rows a file can never add | §8 |
| No Canadian-dollar amount is shown, and the second account is not named | §8 |
| The profile's "Account name: Distinct 3" counts the Total and copyright lines | §8 |
| "Exact duplicate rows 0" can be read as "not a repeat upload" | §8 |

**Recheck on the corrected screens (`60cb483`).** The same agent was sent the six new result
screenshots, so this pass was not cold. It again stated all three results correctly.
- **No longer misleads:** step 6 reads "Reconcile with ledger · Nothing compared", with a grey dot.
- **Less misleading:** upload 2 says "The 28 counted rows passed the checks". Its headline still
  gives $2,674.02 without saying "US-dollar rows only", and no Canadian-dollar amount is shown.
- **Still misleads:** upload 3 is not named as a repeat.
- **New confusion,** recorded in §8:
  - a grey dot can read as "not yet", beside step 5's "Waiting";
  - the step-6 note is cut off at 1280 px;
  - the 28-rows line does not say whether the 14 CAD rows passed the other checks;
  - on uploads 1 and 3, "Every row passed" sits beside the profile's "Row 55 has 1 cells", which
    does not say that row 55 is the footer.

### Engineering: files, code and a SELECT-only database

The agent was not given the expected totals.

**What it verified:**
- **Totals.** It recomputed each total from the file bytes, in integer cents and again with Python
  Decimal. Each equals the stored dry run: **354,880¢, 267,402¢ and 354,880¢**.
- **Upload 1, line by line:**
  - 42 eligible rows (CSV lines 11–52);
  - the Total row on line 53 (`SUMMARY_ROW`), whose figures equal the column sums;
  - the copyright line on line 55 (`TEXT_LINE`).
- **Upload 2:** exactly lines 39–52 were quarantined with `CURRENCY_UNSUPPORTED`: account
  B0123457, 874.78 CAD. The 28 eligible rows sum to 267,402¢. The file's own Total line still says
  3548.80, which adds CAD to USD.
- **Upload 3:** byte-identical to upload 1, with the same 44 dispositions, the same mapping and the
  same rules hash. Nothing adds the two uploads together.
- **Ledger:** `raw_events`, `ad_spend_daily`, `ad_campaigns`, `leads` and `crm_payments` hold no
  rows. `pg_stat_user_tables` shows no insert into them, ever.

**Confirmed findings, none a data error.** All are recorded in §8, and none was changed:
1. `file_sha256` is the SHA-256 of the file's base64 text, not of the file. It still identifies
   identical bytes.
2. The "accounted" check compares the counts with the rows they were counted from, so it cannot
   fail. Title, header and blank lines get no disposition and are outside it.
3. "Held back" differs: the rail counts 16, while the card shows 14 not counted plus 2 text lines.
   The "Needs correction" tile counts the Total and copyright lines.
4. The details' "File total" is the total of the counted rows.
5. A spend record's identity ignores its account and currency.
6. The mapping was never approved. A compare-only result does not need approval, and the results
   come from the proposed version.
7. The dry run does not record the mapper version.
8. The export time is kept on the mapping, not on the upload.

**Suspected:**
- A one-cell line inside the data could vanish as a text line. This was a risk my fix created;
  corrected in `e1a2ae4`.
- A campaign named "Total" would be dropped.
- The sum is never checked against the file's own Total line or its "Rows: 42".
- A quarantined row's identity can block a later valid row for the same campaign-day.
- After 24 hours the Canadian-dollar reason degrades to "another currency".

**Its judgement:**
> Yes, for these three numbers.

Each was recomputed from the file and traced line by line, and the refusal and replay are exact.
But that trust comes from the trace, not from the app's own checks. Its "accounted" check cannot
fail, and the currency guard works only if someone maps the currency column. Here the assistant
mapped it unasked, and the runner checks that.

## 7. Test results

**The full regression on `60cb483`:**
- **Where:** the fresh worktree `C:/Temp/rso-rc`, detached at `60cb483`, with its databases
  (`revenue_signal_rc`, `_test`, `_eval`) recreated empty first.
- **How:** `bash C:/Temp/rc-verify.sh phase1`, then `phase2`, as in `RELEASE-CANDIDATE.md` §7.
- **Build:** `G9Bf3P9KDbzRlLWzydKQc`.

| Step | Exit | Result |
|---|---|---|
| `npm ci` | 0 | 37 s |
| `npm run db:migrate`, on an empty database | 0 | 2 s |
| `npm run build` | 0 | 17 s |
| `npm run typecheck` | 0 | 7 s |
| `npm run lint` | 0 | 26 s |
| `npx vitest run` | 0 | 845 s. 79 files: 940 passed, 1 expected failure. At `28e498b` it was 937 and 1; the 3 added are this workflow's currency tests in `onboarding.test.ts` |
| `npm run db:seed` | 0 | 57 s |
| `eval-ai --no-store` | 0 | 15 s |
| Investigator held-out pack | 0 | 67 s |
| ChangeGuard held-out pack | 0 | 52 s |
| VP acceptance, run twice | 0 | 46 s |
| Shadow acceptance, run twice | 0 | 35 s |
| Browser suite, `CI=1 VISUAL=1 npx playwright test` | 1, twice | No single run passed; each test passed in one of the two runs (below) |

**The browser suite did not pass in one run.** Two full runs on the same build:

| Run | Passed | Failed | What failed | Did not run |
|---|---|---|---|---|
| 1, inside phase 2 | 122 (+1 skipped) | 1 | The drift review's "stale save": the conflict notice was shown but not focused (`zzzzzz-drift-review.spec.ts:341`). The same failure is recorded at `2755e13` (`B09-RECOVERY.md` §4) | 2: the tests after it in that serial file |
| 2, reseeded | 119 (+1 skipped) | 2 | The replay panel's dry-run result was not shown within 5 s (`golden-path.spec.ts:40` and `:118`), R-41's "5 s preview" | 4: the tests after the first failure in its serial block |

- Each test that failed or did not run in one run passed in the other. The skipped test is the demo
  video, skipped by design, as at `28e498b`.
- The two spec files alone, each time on a fresh seed: 14 of 14, twice (golden-path's 9 and the
  drift review's 5).
- None of these touches onboarding. The product change since `28e498b` is confined to
  `lib/onboarding/`, `components/onboarding/` and `app/onboarding/`. At `28e498b` the suite passed
  in one run: 125 passed, 1 skipped.
- So `60cb483` lacks the single all-green run the accepted checkpoint has. The record is
  `byof/verify-60cb483.txt`.
- Both failures were then reproduced and fixed, and `d431e9b` passed in one run
  (`SUITE-STABILIZATION.md`).

**The frozen packs against the `28e498b` run** (timings, run times and latencies aside):
- the investigator and ChangeGuard packs, and the logs of all four held-out steps: identical;
- the VP and shadow packs: only the recorded commit differs;
- the eval-ai log: only a process id in a warning differs.

**The BYOF runner,** each from a fresh worktree:

| Commit | Checks | Record |
|---|---|---|
| `c33953b`, before the fix | 33 of 47 | `byof/before-c33953b/` |
| `284c46e` | 50 of 50 | `byof/284c46e/` |
| `60cb483` | 54 of 54, exit 0 in 61 s | `byof/60cb483/` |

**A stopped run.** The first full regression, on `284c46e`, failed at lint (exit 1) and was stopped
by hand (`byof/verify-284c46e-stopped.txt`). The failure was real: since `76c5820`, lint had read the
CommonJS harness scripts kept as evidence under `docs/agent-work/b09-acceptance/`. `60cb483` leaves
those folders out of lint. The runs above are on the final commit.

## 8. Seen and not changed (not blockers)

**From the reviews:**
- `file_sha256` is the hash of the base64 text.
- The "accounted" check cannot fail.
- Record identity ignores account and currency.
- The export time is kept on the mapping.
- The dry run does not record the mapper version.
- A campaign named "Total" would be dropped.
- The app never compares its sum with the file's own Total line.
- A quarantined row's identity can block a later row.
- No Canadian-dollar amount is shown, and the second account is not named.
- The profile's distinct counts include the Total and copyright lines.
- Step 6's grey "Nothing compared" dot can read as "not yet", and its note is cut off at 1280 px.
- The two-account result does not say which checks the 14 CAD rows passed.
- The profile's "Row 55 has 1 cells" is not linked to the footer the result left out.

**On this page:**
- The step rail still counts compare-only rows as "28 new · 16 held back". "New" is the old word,
  and the 16 includes the two text lines.
- Before a mapping exists, the rail's last step reads "Publish", even for a file suggested as ad
  spend.
- The profile marks "Account name" as personal.
- A second upload of the same bytes is not named as such. Its result is identical, and nothing is
  counted twice.
- Approving the mapping for future exports of this layout is not offered as the next action. It
  needs another role, and it changes nothing in a compare-only result.

**Outside the upload path:**
- On an empty workspace, the Overview's tiles show $0.00 beside "That is no record, not $0".
- The header shows a green dot with the tooltip "All feeds succeeded within 36 hours", though no
  feed has run (`components/ShellStatus.tsx`).
- Two timing-sensitive browser checks (§7, R-41). Both were fixed on 2026-11-16, and the guess
  recorded here was wrong (`SUITE-STABILIZATION.md`):
  - the drift review's notice was never focused, because its frame callback could run before React
    put the notice on the page; no later render took the focus;
  - the replay panel's dry-run result was expected within 5 s.

## 9. Limits, and what this does not establish

- **Synthetic data only.** No real vendor export, account or data was used.
- **Demo roles.** A cookie picks the role (R-2), and the one role step relies on it.
- **No person has tried this.** The walk and both reviews are scripted. Human usability is not
  claimed.
- **One file layout.** One vendor shape, Microsoft Advertising-style daily, on one platform.
  Fractional conversions and other refusals are covered by the existing held-out tests, not by this
  proof.
- **Compare only.** The workflow certifies what the file says, row by row. It does not certify
  that the platform's numbers are right, attribute spend to branches, or support a budget decision.
