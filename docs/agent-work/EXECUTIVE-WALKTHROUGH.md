# Five-minute executive walkthrough

**The question:** *Can we trust the numbers we're using to decide where our next marketing dollar
should go?*

Everything shown is synthetic and labelled as such. Prepare:

```
npm run db:seed
npm run demo:exports
npm run dev
```

Use the role switcher (top right).

**Verified:** every step below is covered by the test named in its row: a Playwright test
(browser) or, where marked, an integration test. The full suite runs as
`CI=1 VISUAL=1 npx playwright test` against a production build (results in `VERIFICATION.md`).

## The storyline: 14 steps

| # | Time | Role | Screen and action | What to say | Verified by |
|---|---|---|---|---|---|
| 1 | 0:00 | Marketing | **Overview** → B09's budget signal is **on hold** | "Nothing crashed. The meaning of the data changed, so the number is held instead of shown wrong." | `os-golden-path` a |
| 2 | 0:20 | Marketing | **Decision Lab** says *not ready* and links the blocking incident | "Readiness comes before any budget move." | `os-golden-path` b |
| 3 | 0:35 | Marketing | **Incident** → campaign, spend, leads and CRM outcomes as evidence | "Google moved Local Services into Performance Max; the old mapper filed it as Search." | `os-golden-path` c |
| 4 | 0:55 | Marketing | **Investigate** → the AI investigator cites the evidence and proposes a re-map | "It cites stored records. It does not decide." | `os-golden-path` d |
| 5 | 1:15 | Engineer | **Dry run** on the server: before and after, rolled back | "We see the effect before anything changes." | `os-golden-path` e |
| 6 | 1:30 | Approver | A **different person** approves; the proposer cannot | "The database refuses self-approval, not only the screen." | `os-golden-path` f; `security.test.ts` |
| 7 | 1:45 | — | Executed: metrics recompute, the ledger is verified unchanged | "The raw ledger never changed. Only the interpretation did." | `os-golden-path` g·h |
| 8 | 2:00 | Marketing | **Audit & Health** → proposer, dry run, approver, executed records | "Every step has a person and a time." | `os-golden-path` i; `z-redesign-navigation` |
| 9 | 2:15 | Marketing | **Data onboarding** → *CRM payments export*: profiled; the phone column shows only shapes and counts | "An export the system was never designed for." | `z-onboarding` 2 (UI); `onboarding.test.ts` (profiles carry no personal values) |
| 10 | 2:40 | Marketing | Suggestions: *Net Paid* = cash collected; *Contract Value* refused as cash, with the reason; stating the wrong meaning is refused by the rules | "A contract is not money received." | `onboarding.test.ts` (FieldRoutes payments export: `Net Paid`, `WRONG_MONEY_MEANING`); not asserted in the browser |
| 11 | 3:05 | Approver | Dry run: the file differs from the ledger in amount and status, shown to the cent; the decision panel says compare-only and there is no publish button | "Payments belong to the CRM. A file can show where to look, never overwrite them." | `z-onboarding` 2 |
| 12 | 3:30 | Marketing | **Revenue opportunities**: missed follow-up. Facts, inference, hypothesis, recommendation, and "Measured outcome: none" | "The data does not support the missed-follow-up story here, and the page says so." | `z-opportunities` 1 |
| 13 | 4:00 | Approver | Readiness **blocked** by open incidents: no override offered. One branch, one month: an override is offered for a small sample | "A judgment call cannot fix broken data. It can accept a small sample, with a name and a reason." | `z-opportunities` 2 |
| 14 | 4:25 | Engineer | **Integrations** → arm a 429, run a sync, watch the retry succeed | "Failures back off, recover, or fail loudly." | `os-modules` (rate_limit) |

## The failed input (about 20 seconds, anywhere after step 9)

**Data onboarding:** upload `mixed-garbage.csv`, an employee shift schedule whose columns look
like a phone, a date and a branch. The step rail says **"No dataset fits"**. It does not guess.

Verified by `z-onboarding` 4 ("a file that fits no dataset is not guessed at"). The hostile-input
quality gate (`z-quality-gates`) and 36 adversarial intake cases (`adversarial-intake.test.ts`)
cover the rest.

## Close (15 seconds)

"This does not replace the CRM or Power BI. It checks what flows between them, says exactly where
the numbers disagree, and lets a person fix it with an audit trail. What I don't know yet is
whether you already have this lineage in your warehouse. That's my first question."

## What not to say

Do not claim any of these:
- a live integration (everything is mocked or synthetic; `VENDOR-CONTRACTS.md`);
- revenue uplift (no intervention has been measured);
- that the AI is accurate in general (2.2% wrong suggestions on held-out data, one critical;
  `AI-EVALUATION.md`);
- production capacity (one laptop: `PERFORMANCE.md`).
