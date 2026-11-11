# Repository map (what owns what)

Reconstructed from the code, not from older documents.

| Subsystem | Problem it solves | Owning files | Invariants it protects | Tested by |
|---|---|---|---|---|
| Intake | Every delivery lands once, PII hashed, bad records kept and quarantined | `lib/ingest/ingest.ts`, `lib/adapters/*`, `app/api/ingest/[source]` | One raw event per (source, external id); versions never overwritten by older ones; one bad record never blocks a batch; nothing dropped | `adversarial-intake`, `invariants`, `review-regressions` |
| Connectors | Pull FieldRoutes-shaped data safely | `lib/connectors/*`, `lib/jobs/*` | Checkpoints only advance on commit; fencing; back-off; replay | `connectors` |
| Identity | Join leads to CRM customers | `lib/identity/*` | Ambiguous matches go to people; decisions survive re-runs | `identity` |
| Reconciliation | Typed exceptions where systems disagree | `lib/reconcile/reconcile.ts` | Serialised (advisory lock); idempotent | `invariants`, `scenario` |
| Metrics and reporting | Verified CAC, revenue, scorecards; versioned views for BI | `lib/metrics/*`, `database/migrations/0010_reporting_contract.sql` | One definition per metric (`/definitions`) | `domain-model`, `scenario` |
| Action Center | Corrections by proposal, dry run, approval by another role, execution once | `lib/workflow/*`, `lib/actions.ts` | Separation of duties; idempotent execution; audit | `action-center`, `changeguard` |
| AI Investigator | Evidence-grounded answers over permitted data | `lib/ai/*` | Cited evidence; tools scoped by viewer; no writes; injection delimited | `ai-*` tests, `npm run eval:ai` |
| Decision Lab | Readiness verdicts, scenarios, A/A self-check | `lib/decision/*` | Attribution ≠ causation; no uplift claims | `decision-lab` |
| **Data onboarding (new)** | Unfamiliar exports profiled, mapped, dry-run, compared, published only with approval | `lib/onboarding/*`, `app/api/onboarding/**`, `app/onboarding/**`, `components/onboarding/*`, migration `0013` | One disposition per row; ambiguous meaning never accepted silently; a file adds and never changes; reconcile-only for CRM and spend; separation of duties in the schema; retention | `onboarding`, `onboarding-parse`, `onboarding-review`, `onboarding-eval`, `z-onboarding` (browser) |
| Shell and design system | Navigation, roles, tokens, accessibility | `app/layout.tsx`, `components/*`, `app/globals.css` | Server-side scope; WCAG AA; no sideways scroll | `z-quality-gates`, `z-layout`, `design-tokens` |
