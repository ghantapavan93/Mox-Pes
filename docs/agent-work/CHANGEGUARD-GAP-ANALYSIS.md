# Marketing ChangeGuard: role reverse-engineering and gap analysis (2026-11-11)

## 1. What the role asks for

Source: the Software Engineer – Marketing posting text (kept privately in `research/raw/`;
quotes here are 15 words or fewer).

| Theme | Stated in the posting | Inferred |
|---|---|---|
| Full-stack TypeScript/React, internal tools, APIs | Yes: "full-stack web applications, internal tools, backend services, and APIs" | — |
| Attribution and funnel reporting, spend → revenue | Yes | — |
| Integrations with marketing platforms, CRMs, REST APIs, "designing for failures" | Yes | — |
| Multi-branch, multi-brand configurable workflows | Yes: "multiple branches, brands, and departments" | — |
| Reliability: "failed jobs, inaccurate data, and broken integrations" | Yes | — |
| Safe production migrations; CI/CD, testing and release processes | Yes | — |
| Ownership after release: "what happens after your code ships" | Yes | — |
| Thoughtful AI, careful review, ownership of the result | Yes | — |
| A mature environment already exists (lake, routing automation, an internal portal, call AI) | — | **Inferred** from public company material: the team describes automation and a consolidated data lake. This work therefore **extends and verifies** that environment; it does not replace it. |

## 2. Role → capability matrix (what Revenue Signal OS already shows)

| Role responsibility | Capability in the product | Evidence | Gap |
|---|---|---|---|
| Why marketing data doesn't match sales | Reconciliation detectors, exceptions, ledger vs claimed | `/exceptions`, Overview | — |
| Attribution and funnel reporting | Scorecards, attribution views, definitions | `/`, `/definitions` | CLV is modelled |
| Integrations designed for failure | Versioned mappers, quarantine, connector with back-off, vendor contracts | `/integrations`, `VENDOR-CONTRACTS.md` | Mock only |
| Resolve inaccurate data and broken integrations | Action Center: proposal → dry run → different-person approval → verify | B09/B20 golden paths | **Reactive only:** a fix starts from an exception, after the damage |
| Multi-branch, multi-brand | Branch and brand scope on the server | `lib/viewer.ts` | — |
| Safe migrations and releases | Numbered migrations, staged mapper versions, replay with dry run | `database/migrations`, `lib/ingest/replay.ts` | **No preflight for configuration changes** |
| Ownership after release | Audit & Health, freshness | `/audit` | **No post-release verification of a change** |
| Thoughtful AI | Grounded investigator, deterministic fallback, evaluated assistant | `/investigator`, `AI-EVALUATION.md` | Causal revenue claims not explicitly refused |

## 3. What already exists, and must be reused

| Need | Existing | Reuse decision |
|---|---|---|
| Campaign → branch mapping | `campaign_branch_map` + `mapCampaignToBranchInTransaction` (insert only, no history, no remap) | Same table and write path; add version history beside it. **No second registry.** |
| Dry run without mutation | `withRollback`, Action Center dry runs | Preflight runs the real write path in a rolled-back transaction |
| Reporting impact | `branchRows`, `reconcile()` | The preflight measures them before and after the change, inside the rollback |
| Approval by a different person | Subjects, DB-enforced separation (0014) | Same rule, plus a DB constraint on changes |
| Unsupported AI claims | `groundDraft` drops ungrounded claims | Extended to refuse causal revenue claims without experiment evidence |
| Source schema changes | Versioned mappers, quarantine codes | A preflight runs sample payloads through the deployed mapper |

## 4. The gap, and the slice built

The Action Center answers **"when something breaks, how do we recover?"** It does not answer:
- **before** a change: what could break;
- **during** a change: is it safe to release;
- **after** a change: did it work.

B09 and B20 were both discovered after the fact.

**The slice:** versioned configuration changes for campaign → branch mappings (the change the
application can actually execute), with:
- a deterministic preflight that runs the production write path in a rolled-back transaction;
- approval bound to the exact configuration hash, preflight hash and base version;
- a release state machine with post-release verification.

Plus a preflight-only kind for source contract changes: sample payloads run through the
deployed mapper. Releasing a mapper is a code deploy here, so that kind is declared not
releasable.

**Not built, by choice:**
- lead-routing contracts (the product has no routing model; inventing one would be speculative);
- effective-dated mappings: a mapping applies to the campaign's whole history, as today. The
  preflight states that retroactive effect explicitly instead.
