# Workspace flood (WP-D)

Run 2026-11-18T19:45:06.327Z against localhost:3991, database `revenue_signal_rehearse`: 35 uploads a minute for 3 minutes, each a different 10,000-row file (0.6 MB each), each from a new visitor. 178 s in all.

| Answer | Uploads |
|---|---|
| 201 | 5 |
| 429 AT_CAPACITY | 95 |
| 503 FULL | 5 |

Response time: median 29 ms, p95 201 ms, slowest 377 ms.

Workspace uploads held afterwards: 5, 50,000 rows (budget 50,000 rows, counted twice).

| Table | Before | After |
|---|---|---|
| onboarding_uploads | 0.1 MB | 0.3 MB |
| onboarding_rows | 0.0 MB | 8.0 MB |
| onboarding_mappings | 0.1 MB | 0.1 MB |
| onboarding_dry_runs | 0.0 MB | 0.0 MB |
| onboarding_row_results | 0.0 MB | 0.0 MB |
| workspace_quota | 0.0 MB | 0.1 MB |

WAL written during the flood: 15.0 MB.
