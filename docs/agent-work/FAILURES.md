# Failures and what they taught

Things that went wrong during this session's own work, kept so they are not repeated.

| What happened | Caught by | Lesson |
|---|---|---|
| Two adversarial expectations were wrong (ADV-16 named the wrong quarantine code; ADV-21 assumed NUL would quarantine, but redaction strips it by design) | Running the tests | Read the code's documented intent before writing the expected outcome |
| Shell heredocs collapsed backslashes in regex edits twice (a `\b` became a backspace byte) | A control-character scan | Write regex-bearing code only with file-editing tools |
| A Python edit read non-ASCII test text through the wrong code page and silently matched nothing | Its own assertion | Never edit Unicode test data through a shell pipe |
| The benchmark's generator wrote 24-hour times with AM/PM; half its rows were (correctly) refused | Eligible count = 50% | A benchmark's input is code too: check it produces valid data |
| Future-dated records were accepted (business clock Oct 31, export dated Nov 3) | The browser walk | Exercise the product as a user would; tests had a later `now` |
| The rail linked to anchors that did not exist | Reading the accessibility tree in the browser | Check every link a page renders |
| 21 defects in a pipeline that had passed 65 of its own tests | Two independent reviewers | The builder's tests share the builder's blind spots: resource bounds, transactions, file-format semantics |
| My first header-detection fix (D3) broke a ragged-file case | The security reviewer's S6 regression test | Fixes need the other reviewer's tests too, not only their own |
| Retention purge ran inside a transaction that then refused, so the rollback undid the purge | A test that checked the side effect, not just the error | Assert side effects of failing operations |
| The first ADV-46 fix made one email pattern linear and missed the second | Security review S3 | When fixing a class of bug, search for every instance of the class |
| The full browser suite was run against the **dev** server while I kept editing files; hot rebuilds mid-run produced three failures (a sidebar click, a hostile-input timeout, a B09 execution result) | Reading the run log ("[Fast Refresh] rebuilding" timestamps) | Final verification runs against a production build (`CI=1` → `next start`), with no edits during the run |
| That same run surfaced a **pre-existing** defect from the committed redesign: `/demo` nested a `<table>` inside `TableWrap`'s `<table>`, which breaks hydration | The browser console in the e2e log | `TableWrap` now documents that it renders the table and takes a `testId`; no other nesting exists |
| The production-mode run then failed differently: the test reseed **deadlocked** (`drop schema … cascade`) with event consumers the app was still running after the previous spec's last action; one spec's ten tests never ran | The Postgres error code `40P01` in the log | `reseedDemo` retries when chosen as the deadlock victim. A pre-existing race the dev-mode timing had hidden |
| `/customers` shifted 0.116 on a cold first load (recorded as a one-off last session). Measured on the production server: tiles are 110 px where the placeholder reserved 90 px, and the review queue is a list where the placeholder reserved one line | A headless measurement of placeholder vs real heights | Content whose height depends on data renders with the page, not behind a guessed-size fallback |
| A golden-path assertion matched two budget cards in production mode: Next 16 keeps the previous route mounted but hidden (React Activity) | Playwright's strict-mode error, naming the hidden copy's `#records` ancestor | Assert on what is visible (`filter({ visible: true })`) when a page can follow another client-side |
