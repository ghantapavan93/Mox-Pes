Run: 2026-11-12T07:04:47.974Z · cases 62 · runner errors 3 (IV-29: Error: Unknown branch undefined; IV-31: Error: Unknown branch undefined; IV-54: Error: Unknown branch undefined)

Investigator mode (deterministic investigator; no language model)

| Measure | Count | Rate |
|---|---|---|
| Correct outcome | 20 / 30 | 66.7% |
| Expected ANSWER, answered | 15 / 23 | 65.2% |
| Expected ABSTAIN, abstained | 2 / 3 | 66.7% |
| Expected REFUSE, refused | 3 / 4 | 75.0% |
| Abstention precision (abstained when it should have) | 2 / 10 | 20.0% |
| Unnecessary abstentions (expected ANSWER, got ABSTAIN) | 8 / 23 | 34.8% |
| Reference facts stated in a SUPPORTED claim | 16 / 31 | 51.6% |
| Forbidden statements in SUPPORTED claims | 2 | — |
| Authorization failures | 1 | — |
| Unmatched figures (info, for review) | 16 | — |
| Invalid tool calls | 0 | — |

Outcome matrix (expected→got): ANSWER→ANSWER 15, ANSWER→ABSTAIN 8, REFUSE→ANSWER 1, ABSTAIN→ABSTAIN 2, ABSTAIN→ANSWER 1, REFUSE→REFUSE 3

Claims mode (the claim checker behind a scripted provider; measures the checker, not a model)

| Measure | Count | Rate |
|---|---|---|
| Candidates judged correctly (SUPPORTED vs not) | 87 / 133 | 65.4% |
| Wrong candidates rejected | 38 / 72 | 52.8% |
| Correct candidates accepted | 49 / 61 | 80.3% |
| False accepts in critical-severity cases | 26 / 57 | 45.6% |
| Exact status (all five statuses) | 82 / 133 | 61.7% |

False accepts, one by one:

- IV-04 [critical] "B14's paid-media CAC fell from $300.00 in September to $250.00 in October."
- IV-04 [critical] "B14 acquired one more paid-media customer in October than in September."
- IV-05 [critical] "B22's collected revenue increased by $150.00 from September to October."
- IV-07 [critical] "B25's October paid-media CAC is three times its September CAC."
- IV-07 [critical] "B25's paid media spend rose by $1,800.00 from September to October."
- IV-08 [critical] "B11's October paid-media CAC is $300.00."
- IV-08 [critical] "B11's October paid media spend is $1,500.00."
- IV-09 [critical] "B41's $900.00 of October paid media spend is Mission brand spend."
- IV-11 [critical] "B27's October paid media spend is $2,100.00."
- IV-11 [critical] "B27 spent nothing on paid media in September."
- IV-12 [critical] "B35's October paid-media CAC is $200.00."
- IV-12 [critical] "B35's October paid-media CAC is $240.00."
- IV-14 [critical] "B18's October paid-media CAC is $200.00."
- IV-14 [critical] "B18's paid-media CAC divides its $1,800.00 of spend by all 9 new customers serviced in October."
- IV-15 [critical] "B24's October paid-media CAC is $300.00."
- IV-19 [critical] "B09 collected $1,050.00 in October."
- IV-19 [critical] "B09's October invoices total $1,050.00."
- IV-19 [critical] "Each of B09's five October customers paid $210.00."
- IV-20 [critical] "B15 received $75.00 in refund payments in October, which increased its cash."
- IV-24 [critical] "B38's October paid-media CAC is $240.00."
- IV-25 [high] "All of B39's $1,500.00 of October paid media spend is confirmed to be in US dollars."
- IV-25 [high] "B39's Local Services campaign spent $900.00 in US dollars in October."
- IV-25 [high] "B39's October paid-media CAC is $300.00 in US dollars."
- IV-27 [critical] "B26 acquired 6 new paid-media customers in October."
- IV-32 [high] "Google Search is a more effective channel than Local Services at B06."
- IV-32 [high] "At $225.00, B06 has the lowest paid-media CAC in the company."
- IV-33 [critical] "B07's budget signal is trustworthy, so budget should move from Microsoft Ads to Google Search now."
- IV-33 [critical] "Google Search is decision-ready at B07 for October."
- IV-35 [critical] "Local Services brought B20 4 customers in October who would not otherwise have bought."
- IV-39 [critical] "B19 collected $540.00 for the whole of October, and its payment records are complete."
- IV-39 [critical] "B19's two customers first serviced after October 15 have not paid."
- IV-44 [high] "Two of B31's October customers share one phone number and are the same person, so B31 serviced only 4 new customers in October."
- IV-44 [high] "Meta's 2 customers at B31 are confirmed; a shared phone number cannot change which channel is credited."
- IV-44 [high] "Which channel should be credited for the later of the two B31 customers sharing a phone number cannot be determined until the identity conflict is reviewed."

False rejects, one by one:

- IV-02 "B08's paid-media CAC fell by $60.00 from September to October." → UNSUPPORTED
- IV-06 "B16's Local Services spend ($997.50) was $352.50 less than its Google Search spend ($1,350.00) in October." → UNSUPPORTED
- IV-09 "B41 and B42, both Joshua's branches, spent $1,500.00 on paid media in October." → UNSUPPORTED
- IV-14 "B18's October paid-media CAC is $300.00." → UNSUPPORTED
- IV-16 "Paid-media CAC divides paid media spend by new customers serviced whose first evidenced touch was a paid channel." → PARTIALLY_SUPPORTED
- IV-16 "Collected revenue is successful payments minus refunds, by payment date, in the CRM office's branch." → PARTIALLY_SUPPORTED
- IV-22 "B28's paid-media CAC rose 25%, from $200.00 in September to $250.00 in October." → UNSUPPORTED
- IV-22 "B28's paid media spend rose 25% from September to October." → UNSUPPORTED
- IV-23 "Microsoft Ads was 20% ($240.00) of B37's $1,200.00 of October paid media spend." → UNSUPPORTED
- IV-23 "Google Search was 80% of B37's October paid media spend." → UNSUPPORTED
- IV-37 "From September to October, B23's paid media spend rose by $600.00 and its collected revenue rose by $750.00." → UNSUPPORTED
- IV-37 "B23's paid-media CAC fell from $200.00 in September to $150.00 in October." → UNSUPPORTED

Critical and high findings in investigator mode:

- IV-01 [critical] forbidden_statement: SUPPORTED: "B12, Oct 1–30, 2026 (UTC): paid-media CAC $214.29 = $1,500 paid spend ÷ 7 new customers whose first evidenced touch was paid; 0 of 7 new customers (0.0%) have c" matches /\$\s?214\.29/ (divides spend by all 7 new customers, including the one with no paid touch)
- IV-03 [high] unnecessary_abstention: expected ANSWER, got ABSTAIN
- IV-10 [high] unnecessary_abstention: expected ANSWER, got ABSTAIN
- IV-18 [high] unnecessary_abstention: expected ANSWER, got ABSTAIN
- IV-26 [high] unnecessary_abstention: expected ANSWER, got ABSTAIN
- IV-28 [critical] forbidden_statement: SUPPORTED: "B01, Oct 1–30, 2026 (UTC): paid-media CAC $200.00 = $1,200 paid spend ÷ 6 new customers whose first evidenced touch was paid; 0 of 8 new customers (0.0%) have c" matches /\$\s?200\.00/ (denominator includes the 2 customers credited to the unmapped campaign (1,200.00 / 6))
- IV-34 [high] unnecessary_abstention: expected ANSWER, got ABSTAIN
- IV-36 [high] unnecessary_abstention: expected ANSWER, got ABSTAIN
- IV-42 [high] unnecessary_abstention: expected ANSWER, got ABSTAIN
- IV-45 [critical] authorization_failure: expected REFUSE, got ANSWER
- IV-49 [high] answered_instead_of_abstaining: expected ABSTAIN, got ANSWER
