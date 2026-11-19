# Release checks: `e10042f` and `82c270c`

A reviewer's own file now moves the reviewer's own dashboard, the hosted copy's empty pages have
worked examples, and the Start page plays the walkthrough recorded for the VPs (sharing review,
2026-11-19: "the dashboard has to change along with the data that is uploaded").

| Commit | What |
|---|---|
| `e10042f` | `previewUpload`: a visitor's dry-run rows counted in a transaction that is always rolled back, the dashboard read before and after (`lib/metrics/dashboard-snapshot.ts`), only the figures kept on the visitor's dry run; `/onboarding/:id/dashboard`; the missed-calls sample; worked examples for the hosted copy (`npm run db:examples-hosted`); Integrations says where an idle connector's records came from; the Start page says how it is built |
| `82c270c` | The Start page plays the two-minute walkthrough (`../../recording/revenue-signal-os-walkthrough.md`) |

| Check | Result |
|---|---|
| Clean checkout of `e10042f`: npm ci, build, typecheck, lint | pass (`../release-e10042f/`) |
| Vitest on `e10042f` | 101 files, 1,105 passed + 1 expected failure: 6 more than `48c6d77` (`workspace-preview.test.ts`) |
| AI eval, deterministic, on `e10042f` | 15/15 (unchanged) |
| Browser suite on `e10042f` | 148 passed, 1 skipped, 0 failed: one more than before, J6 |
| Acceptance on `e10042f`: B09, BYOF | pass |
| Hosted journeys `@core`, production at `e10042f` | 11/11: J1 ×5, J4, J5 ×3, J6, J2 (`hosted-core-e10042f.txt`) |
| Worked examples on the live database | two answer checks (SUPPORTED, NOT_SUPPORTED), ChangeGuard change #1 ready for review, proposal #2 on incident #2455 dry-run and awaiting approval; hosted `@core` 11/11 again afterwards, every pinned figure unchanged (`hosted-core-after-examples.txt`) |
| Clean checkout of `82c270c`: build, typecheck, lint, browser suite | pass; 148 passed, 1 skipped, 0 failed (`e2e.txt`) |
| Hosted journeys `@core`, production at `82c270c` | 11/11, the Start page journey checking the new video, poster and 17 captions (`hosted-core.txt`) |

`82c270c` changes the Start page's video, poster and transcript and one journey's expectations; the
vitest, eval and acceptance runs on `e10042f` do not render that page and were not run again.

**The private copy, measured.** On the hosted-like rehearsal copy, counting the missed-calls sample
and opening the dashboard took 2.3 s. On production J6 counts it, reads B01 $392.50 → $322.73 on the
visitor's dashboard, reads the shared Overview at the "before" company figure, and refuses the
dashboard to a second visitor.

**The live database step.** The hosted copy's URL went from Neon's copy button to the clipboard to
`npm run db:examples-hosted -- --from-clipboard`, and the clipboard was cleared. A read-only check
first confirmed the target: the first string copied was Neon's default `production` branch
(incident #1063 open, migrations to 0034), so nothing was written until the serving branch's
string (#1063 resolved, migrations to 0038) was on the clipboard.

**Audit before the work** (`../../harness/visitor-audit.cjs`, every page a visitor opens at 1440
and 390 px on production `99518da`): every page loaded in 1–2.2 s with no console error and no
sideways scroll. Answer check and ChangeGuard were empty for a visitor, every incident was detected
or resolved with nothing in between, the CRM connector read "No sync has run yet", and an upload's
result ended at "Count · Never on the public demo". Each is addressed above.
