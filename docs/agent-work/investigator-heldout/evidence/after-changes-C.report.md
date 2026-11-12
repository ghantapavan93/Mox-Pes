Run: 2026-11-12T08:24:27.738Z · cases 62 · runner errors 0 (none)

Investigator mode (deterministic investigator; no language model)

| Measure | Count | Rate |
|---|---|---|
| Correct outcome | 32 / 32 | 100.0% |
| Expected ANSWER, answered | 24 / 24 | 100.0% |
| Expected ABSTAIN, abstained | 3 / 3 | 100.0% |
| Expected REFUSE, refused | 5 / 5 | 100.0% |
| Abstention precision (abstained when it should have) | 3 / 3 | 100.0% |
| Unnecessary abstentions (expected ANSWER, got ABSTAIN) | 0 / 24 | 0.0% |
| Reference facts stated in a SUPPORTED claim | 32 / 32 | 100.0% |
| Forbidden statements in SUPPORTED claims | 0 | — |
| Authorization failures | 0 | — |
| Unmatched figures (info, for review) | 56 | — |
| Invalid tool calls | 0 | — |

Outcome matrix (expected→got): ANSWER→ANSWER 24, REFUSE→REFUSE 5, ABSTAIN→ABSTAIN 3

Claims mode (the claim checker behind a scripted provider; measures the checker, not a model)

| Measure | Count | Rate |
|---|---|---|
| Candidates judged correctly (SUPPORTED vs not) | 136 / 138 | 98.6% |
| Wrong candidates rejected | 75 / 75 | 100.0% |
| Correct candidates accepted | 61 / 63 | 96.8% |
| False accepts in critical-severity cases | 0 / 60 | 0.0% |
| Exact status (all five statuses) | 127 / 138 | 92.0% |

False accepts, one by one:


False rejects, one by one:

- IV-16 "Paid-media CAC divides paid media spend by new customers serviced whose first evidenced touch was a paid channel." → PARTIALLY_SUPPORTED
- IV-16 "Collected revenue is successful payments minus refunds, by payment date, in the CRM office's branch." → PARTIALLY_SUPPORTED

Critical and high findings in investigator mode:

