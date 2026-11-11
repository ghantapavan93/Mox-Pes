# Threat model: data onboarding and intake

Scope: the upload workflow (`/onboarding`, `/api/onboarding/**`, `lib/onboarding/*`) and the
push intake (`/api/ingest/:source`). Everything is synthetic; authentication is a demo cookie
(documented; production would use SSO claims). **Enforcement given a viewer is real and is on
the server.**

| Asset | Threat | Control | Tested by |
|---|---|---|---|
| Ledger integrity | A file overwrites authoritative records | Publication only adds records the ledger lacks; CRM payments and ad spend are compare-only; re-checked at publish time | `onboarding.test.ts` ("a row the ledger gained after the dry run is skipped") |
| Separation of duties | Proposer approves or publishes | Service check **and** DB check (`decided_role <> proposed_role`); publish requires `approve` and a different role | `onboarding.test.ts` (service + raw SQL attempt) |
| Separation of duties | Approve one spec, publish another | Publish requires the latest dry run's spec hash to equal the approved mapping's | `service.ts` publishUpload; unit/integration path |
| Cross-tenant read | Branch partner or brand lead reads another branch's export or profile | Onboarding is limited to company-wide roles; branch-scoped viewers get 403; dry-run rows outside a scoped viewer's branches are refused (`OUT_OF_SCOPE`) | `onboarding.test.ts`, `z-onboarding.spec.ts`, hostile-input gate |
| Availability | Oversized body, decompression bomb, quadratic regex, huge sheet | 5 MB upload / 2 MB push / 64–256 KB JSON caps read with a hard limit; zip ratio and declared-size bounds; inflation capped; 50,000-row, 200-column and 10,000-char cell limits; redaction made linear | `onboarding-parse.test.ts`, ADV-42/43/46 |
| Active content | Macros, ActiveX, external links, encrypted workbooks, formulas | Refused before reading; formulas never evaluated (cached value used and flagged) | `onboarding-parse.test.ts` |
| Spreadsheet formula injection downstream | `=HYPERLINK(...)` cell later exported to a spreadsheet | Flagged in the profile (`formulaLike`). **No CSV export path exists** for onboarding data; if one is added it must prefix such cells | Profile test; REMAINING-RISKS R-6 |
| Path traversal | `../../etc/passwd.csv`, relationship targets escaping the archive | File names sanitised and display-only (storage by id); `..` targets refused | `onboarding-parse.test.ts` |
| Prompt injection | Instructions in cells or headers | No language model reads upload content. Headers matching instruction patterns are excluded from evidence and listed; notes are stored as untrusted text (the existing investigator delimits tool output and was evaluated on injected notes) | eval sets (prompt_injection: 0 wrong on all three); `onboarding.test.ts` (injected note stored, nothing changed) |
| Personal data at rest | Raw cells retained | Cells live only in `onboarding_rows`, deleted on publication, rejection, deletion or after 24 h (lazy purge on every read). Published records go through the same hashing as live intake | `onboarding.test.ts` (retention) |
| Personal data in views and logs | Phones, emails, notes shown or logged | Profiles show masked shapes for personal columns; audit rows hold counts, codes and hashes, never cells (asserted by test) | `onboarding.test.ts` audit assertion |
| SQL injection | Values reaching SQL | All SQL is parameterised; bulk writes use `jsonb_to_recordset` with typed columns | Code review; hostile-input gate |
| XSS | Cell values rendered | React escapes text; no `dangerouslySetInnerHTML` in onboarding | Code review |

## Known weaknesses

- **Hashing is not anonymisation.** A phone hash can be re-identified by hashing candidate numbers
  (a small keyspace). Production needs a keyed hash (HMAC with a managed secret), encryption at
  rest, and a retention policy agreed with the business. Not done here.
- **The role cookie is demo-only.** Anyone can pick any role in demo mode; production disables it.
- **No virus or malware scanning** of uploads (they are parsed in-process, never executed).
- **No rate limiting** on uploads per user.
