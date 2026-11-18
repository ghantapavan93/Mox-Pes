# EGM Stage 7: critic report

- **Target:** `docs/agent-work/release/RELEASE-DESIGN.md` version 3, FeatureRange lines 1–808
- **Reviewers:** `egm:egm-design` and `egm:egm-structural` (standard: `feature-spec-standard.md`),
  `egm:egm-style`; each with fresh context
- **Date:** 2026-11-18
- Resolutions: [`resolution_log.md`](resolution_log.md)

## Structural review

No Blockers: the five required areas are present (problem §1, goals and non-goals §1 and §4, design
§5, alternatives §7, risks §8), in a sensible order, headings nest without skipping, and every
table's rows match its columns. 6 Major, 9 Nit.

**Major**

- **S1. Terms, line 16.** "Company items are visible to the staff roles allowed to see it"
  contradicts §5.2, where company investigations are shown read-only to guests. Fix: split uploads
  and mappings (staff only) from investigations (also shown read-only to guests).
- **S2. Terms line 13; §7 lines 686, 696.** "The brief" is "summarised in §1", but §1 holds neither
  requirement §7 rejects alternatives on (reopening a result, root causes); the quarantine-lane
  rejection only restates the decision. Fix: a "The brief requires" list in §1; give the quarantine
  lane a concrete trade-off (it would hide the B09 CLS failure, so §2's CI claim would rest on a
  hidden failure).
- **S3. §8 and the §5.2 threat model.** Risks split across two tables with no pointer; two rows
  duplicated; Neon's idle suspension (§10) makes a cold reviewer's first request slow, which is the
  success case, yet has no risk row and §4 sets only a warm target for the Preview deployment.
  Fix: point §8 at the threat model and merge duplicates; add an idle-compute row; give §4 a target
  or an explicit non-target for "first request after idle".
- **S4. J1–J4.** Never defined in the FeatureRange; the plan defines J1 twice (WP-B, WP-C); §8 says
  J1–J4 test Back, but only J1 and J2 do. Fix: a J1–J4 table in §6 (routes, assertions, owner),
  mapped to the five success criteria; correct the §8 row.
- **S5. `PUBLIC_WORKSPACE` on Production.** When and how it is set, and what rollback does with it,
  are not said; it cannot be removed because `env rm` is never used; setting it before promotion
  makes "nothing in Production changed" untrue. Fix: add it to the promotion definition and §5.11;
  in §9 state it stays after a rollback (`1814616` does not read it).
- **S6. §9 "Verified once".** Does the exercised rollback include pointing the shared
  `DATABASE_URL` back to `main`? If yes, the re-alias leaves the record on `main`; if no, the
  verified rollback covers half the procedure. Fix: name the steps exercised and restore the
  variable after the re-alias if it is one of them.

**Nit**

- **S7. Terms coverage:** one name per concept (workspace guest; hosted demo / hosted copy /
  public demo; build mirror / release worktree / Docker mirror; visitor key / owner key /
  `subject`; company scope; B20, B09, B03; brand marketing lead / brand lead; "preview" for a chart
  point); "Preview deployment" defined as an environment; "Promotion" names Production's variable
  though the shared record is updated.
- **S8. Hold hardening:** "verified" in Terms but "WP-0 verifies it" in §3; "22 tests" used for the
  hardening and for one file.
- **S9. §5.8 does two jobs:** the five states, and B03 (a fix already made) and B09 (a claim limit).
- **S10. §5.2 Limits table:** lacks the 10-mapping cap and the byte limit with its 413; §5.3
  generates the page's limits from files that exclude `lib/workspace.ts`.
- **S11. Measurement definitions:** "Preview warm verdict" undefined; the Upload row's first run
  sits under "Cold"; edges recorded are tops but judged by ends; "first screen" undefined at
  1440 px; "200% zoom" does not say CSS or device pixels.
- **S12. §4 baseline build:** list exactly what it contained, including whether B09's CLS 0.003
  includes the layout-shift fix.
- **S13. Alternatives outside §7:** two inline rejections; no §7 entries for §5.4 and the secret
  handling.
- **S14. Cross-references:** "WP-G step 1" (WP-G has no numbered steps); "the WP-A audit"
  ambiguous; "the brand's branch list" matches no route; "with a model if a key is set" not true
  for Ollama.
- **S15. Formatting:** mixed run-in label punctuation; two extra verdicts in §2 beyond the
  three-verdict rubric; "same" as a ditto value in §11; one test with two names.

## Style review

12 Major, 13 Nit. Terminology checked against the Terms table (no style standard supplied).

**Major**

- **T1. The owner has four names and two missing rules:** visitor key, owner key, subject, token;
  "re-set" does not say the token is kept; which subject a cookieless first item gets (if
  `demo:guest`, cookieless visitors would share items); "`Secure` in production" is ambiguous.
  Fix: one term; the handler creates the token before storing the first item, `demo:guest` is
  never stored; later starts re-send the same token; `Secure` on every HTTPS deployment.
- **T2. Company visibility stated five ways;** whether a workspace upload gets the approved hint is
  unsaid. Fix: one rule in §5.1: a workspace guest reads company investigations read-only and no
  company upload, mapping or approved hint.
- **T3. Times in copy:** "every business date as today" misreads; "tomorrow" and a bare "3:41 PM
  UTC" go stale; "deleted at" overpromises with eviction. Fix: absolute UTC dates, "deleted by".
- **T4. Undefined demos in copy** ("staff demo", "local demo"); "Would count after approval" on a
  workspace row promises an approval that is refused. Fix: define the local demo, link its setup;
  "Would count after staff approval (local demo only)".
- **T5. The 10-mapping message leads nowhere:** re-uploading reopens the same upload. Fix: "Delete
  it, then upload the file again."
- **T6. The 409 rule contradicts itself** (every 409 refreshes; a real conflict stays an error).
- **T7. The primary-action count conflicts with views that have no action;** `/onboarding` lists
  two next actions. Fix: at most one primary, none when the viewer cannot act; Try the sample
  primary, Choose a file secondary.
- **T8. The 200% zoom setting in §6 does not test zoom** (1440 CSS px at 2× is still 1440 CSS px).
- **T9. "Release worktree" undefined;** loading from the build mirror risks drift. Fix: a clean
  worktree at the release SHA, used only by the loader.
- **T10. The rollback check is ambiguous and can break Production later:** after a real rollback,
  git `main` still holds the release SHA, so the next merge builds release code against 0034; bare
  `main` names two branches.
- **T11. Targets lack tolerance; "warm" undefined for the five Preview runs.**
- **T12. The publication's reconciliation event has no correlation key;** "Waiting for the worker"
  is jargon to a marketing user.

**Nit**

- "point Production's `DATABASE_URL`" vs the shared record; synonyms (hosted copy / public demo,
  staff uploads, Neon release branch, brand lead, "the marketing role"); §11 reverses "repeat" and
  "duplicate"; state the unseen file's row total; `->>` returns text, so cast before comparing; the
  3 px ring is listed as copied but the global ring is kept; "the one place a control sends a
  request" vs the list of exceptions; "no … fallbacks" vs "Fallback is a catch-all"; reword the
  fallback copy; "off" vs "unset"; an unparseable sentence in §5.10 step 1; record both edges;
  §1 should state the brief's requirements §7 cites; narrow "nothing else changes for staff roles"
  and "hosted default".

## Design review

8 Major, 7 Nit. The structure meets the standard; three alternatives were missing from §7.

**Major**

- **D1. Sync attempts as runs change readiness and give arbitrary results** (resolution of ZO-4
  flawed): a job covers one office but would write the company-wide stream; readiness fails when
  any stream's latest run failed (`lib/decision/verdicts.ts:394-397, 637-648`), and the header counts
  a running run as failing (`lib/health/feeds.ts:16`); `os-modules` arms a rate-limit fault, so
  its failed first attempt could flip readiness for later specs; attempts share the frozen business
  time and the readers order by `started_at desc` with no tiebreak; cancelled and claim-lost
  attempts would stay `running`. Fix: one run per final outcome in the outcome's transaction;
  `, id desc` in the four readers; say whether one office's failure blocks every branch; test a
  rate-limited attempt then a retry.
- **D2. A rollback by redeploy shows every visitor's investigations to everyone:** every older build
  lists `investigations` to any guest (`app/investigator/page.tsx`, `lib/ai/queries.ts:78-89`,
  `app/api/investigations/route.ts:21-27`); other branches' Preview deployments read the release
  database after promotion. An owner column on shared tables fails open. Fix: separate tables or
  deletion first; seed workspace items before rehearsal step 3; a guard test on table names.
- **D3. The limits cap live rows and items per minute, not cost or availability** (resolution of
  ZO-6/IC-2 flawed): counters must live in the database and count refusals; refusals still write
  `audit_log` (`service.ts:154`); churn unbounded; free-plan quotas can run out; one script can lock
  everyone out and evict a reviewer's item; the budget check and insert race. Fix: a quota table by
  minute and day, rows as well as items, daily caps, no audit for refusals, an advisory lock, a
  30-minute residency, a flood test.
- **D4. Hosting limits ignored:** Vercel refuses bodies over 4.5 MB before the route runs, while the
  limit is 5 MiB and the form reads a non-JSON body as `{}`; no `maxDuration` measured or set;
  Preview deployments may be behind Vercel Authentication. Fix: a 4 MB workspace limit checked in
  the browser and on the server; measure and set `maxDuration`; record how Preview is reached.
- **D5. "Deleted at …" is not guaranteed:** deletion runs only on the next request and the hosted
  demo has no worker; Neon's restore history keeps rows longer; the business-clock purge has no
  owner filter. Fix: a daily Vercel Cron cleanup; reword; name the restore window; exclude workspace
  uploads from `purgeExpired`.
- **D6. The Overview's 1,000 ms warm target is not shown reachable:** about 600 ms of the scorecard
  is unexplained; the other heavy queries were not analysed; the cache cannot help local runs;
  nothing says what happens on a miss; a `distinct on` rewrite can pick different rows on ties.
  Missing alternative: precompute the acquisition set at load time. Fix: trace what gates the
  verdict; total orderings; tie fixtures; state what happens on a miss.
- **D7. The investigator can leak the API key, and the catch-all hides defects:** the SDK reads
  `ANTHROPIC_API_KEY` from the environment and would send it to `OLLAMA_BASE_URL`; precedence
  unstated; classifying a `TypeError` hides code defects; no "Stored as" row for a fallback. Fix: an
  explicit `apiKey: "ollama"`, loopback only, precedence, a fallback row, "other" logged and failing
  tests.
- **D8. Nothing links a publication to the run that covered it** (resolution of IC-8 incomplete):
  the intake event carries no publication id and the publication stores no transaction id; a time
  match on the frozen clock would falsely say "ran". Fix: `onboarding_publications.txid` and the
  outbox's `pg_visible_in_snapshot` predicate.

**Nit**

- A 409 carries only a message; add a `code`. Say whether workspace uploads get the approved hint.
  Read the chart selection from `useSearchParams` so Back from the client cache is right. Use the
  direct connection string for `pg_restore`; `Get-Clipboard` can append a newline; the loader's
  verified URL is discarded; the first push builds a Preview against Neon `main`; consider
  `--skip-domain` then `promote`. Count the release branch's full copy in the storage figures. Key
  the cache on a database version. Pass the row limit into the parser.

**Checked and sound:** viewer resolution; investigation writes (no proposals without `propose`);
deletion order; cross-site writes (`proxy.ts`); the counted-import expression; promotion and
rollback order; the loader; the prerender diagnosis; a `Secure` cookie in the e2e suite.
