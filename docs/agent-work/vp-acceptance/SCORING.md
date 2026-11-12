# Scoring

Written before the scenarios and before the runner; not changed after first contact.

## Units

Every expectation is one **check**:

| Kind | Passes when |
|---|---|
| metric | The system's figure for that scope, period and metric equals the expected value (cents exact, counts exact, percent within 0.1 point; `null` means the system reports no value) |
| heldCurrency, openExceptions | The listed values equal the system's, as sets |
| step outcome | The action was accepted or refused as expected; `class` and `status` when given |
| ask | The outcome matches; every `mustState` figure appears at its value in a statement marked SUPPORTED; no SUPPORTED statement matches a `forbidden` pattern; no `mustNotMention` string appears anywhere |
| workspace | `premiseHolds` matches; each listed hypothesis status matches |
| readiness | The state (or refusal) matches |
| read | Accepted or refused as expected |

## Severity

A failed check takes the scenario's `severityIfWrong`, except:

- **Critical, always:** a wrong financial figure in a `check`; a figure that does not exist marked
  SUPPORTED by the investigator (`forbidden` or a wrong `mustState` value); an action accepted that
  should be refused (approval, release, currency authorization); a refused `read` that was
  accepted (a scope leak); a `mustNotMention` string that appears.
- **Medium at most:** a refusal of something that should be accepted, an ABSTAIN where an ANSWER was
  expected, a missing `mustState` figure (the system was too cautious, not wrong).

## Reporting

- Per scenario and overall: checks passed / total, failures listed one by one with severity.
- Critical failures are reported separately and first. No overall percentage hides them.
- A runner error (the runner could not express a step) is reported as such, not as a product
  failure, and is fixed in the runner only.
- **First contact** runs once, on the code as it is at freeze, and is committed unchanged. Any later
  run after a code change is labelled **after changes (regression)**, never held out.
