# Remaining risks and limitations

Honest register. "Not done" means not done, not "designed".

| Id | Risk / limitation | Impact | What it would take |
|---|---|---|---|
| R-1 | **No live vendor integration has been tested.** FieldRoutes, CallRail, Google, Meta, Microsoft and Fabric are mocks or published shapes | The first real export or API page will find shape surprises | A sandbox account and authorisation; contract tests against recorded real (redacted) payloads |
| R-2 | **Demo authentication.** A cookie picks the role | Anyone can act as any role in demo mode | SSO claims → Viewer; remove `/api/role` |
| R-3 | **One CRM account assumed.** `crm_customers` is keyed by `crm_customer_id` alone | Two brands on two FieldRoutes accounts with the same id would collide | Namespace CRM ids by account (schema migration + mapper change) |
| R-4 | **Merged / deleted CRM customers** are not detected (open since the audit, G-7/G-8) | Attribution can point at a customer the CRM merged away | Read FieldRoutes merge/delete signals; reconcile them |
| R-5 | **Hashing is not anonymisation.** Phones and emails are SHA-256 hashed, unkeyed | Re-identification by hashing candidate numbers | HMAC with a managed key; encryption at rest; agreed retention |
| R-6 | **No CSV/XLSX export of onboarding data exists.** If one is added, formula-like cells (`=`, `+`, `-`, `@`) must be neutralised | Formula injection in a downstream spreadsheet | Prefix with `'` on export; the profile already flags such cells |
| R-7 | **The schema assistant was evaluated on synthetic exports written by AI labelers**, not on real exports or by human domain experts | The ~2–2.5% held-out wrong-suggestion rate may not transfer | A small human-labelled set from real (redacted) exports; a v4 set after any rule change |
| R-8 | **Scale beyond 50,000 rows per upload is not measured or supported.** No 1M / 10M test of any path | Large backfills need another path | Streamed bulk load into the warehouse; this pipeline's rules applied in SQL or batch jobs |
| R-9 | **Benchmarks ran on Postgres with `fsync=off`** | Write throughput is an upper bound | Re-run on a durable configuration |
| R-10 | **Model-backed AI is not evaluated.** The investigator's model mode and any LLM mapper remain untested (no key, by rule) | Claims about model quality would be unsupported | An approved key, data-handling approval, the same evaluation sets |
| R-11 | **Scenarios B (missed follow-up revenue) and C (retention risk) from the brief are not built.** The decision-readiness policy (materiality, partial decisions, overrides) is not redesigned | The "opportunity" and "measurement" layers rest on the existing Decision Lab only | Separate milestones (ROADMAP M-5, M-6) |
| R-12 | **Publication takes a table lock on `leads`** for its duration (seconds for 50k rows) | Live intake waits during a publication | Per-id advisory locks taken by both intake and publication, if publication becomes frequent |
| R-13 | **Uploads are parsed in-process**; no malware scanning, no per-user upload rate limit | One user can occupy a worker with large valid files | Background parsing job; rate limits; scanning at the edge |
| R-14 | **Leading-zero CRM ids are refused** where the held-out labeler expected them accepted as text | A real export padding ids will need a person to confirm | A confirmed "strip padding" transform, recorded in the mapping version |
| R-15 | **Retention purge is lazy plus the worker loop**; with neither running, cells persist past 24 h until the next onboarding request | Short-lived over-retention | A scheduled job in production |
