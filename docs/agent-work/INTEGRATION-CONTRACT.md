# Integration contract

Two modes. **A mock connector is not proof of a live integration**: nothing here has been run
against a real FieldRoutes, Google, Meta, Microsoft, CallRail or Fabric account.

## Mode A: standalone demonstration (what runs today)

Synthetic world (`lib/sim`), a FieldRoutes-shaped mock (`/api/mock/fieldroutes`), push intake,
and the onboarding lab. Reproducible from a clean checkout (`npm run db:seed`).

## Mode B: embedded in an existing data platform (designed, bounded, not deployed)

| Interface | Direction | Contract | Status |
|---|---|---|---|
| `POST /api/ingest/:source` (`web`, `calls`, `d2d`) | in | `{ records: [{ entity, payload }] }`, 1–500 records, ≤ 2 MB, `x-ingest-key` (constant-time compare; fails closed in production without a key). Idempotent per (source, external id); bad records quarantined, never dropped | Implemented, tested |
| FieldRoutes connector (`lib/connectors`) | in | Windowed pulls with checkpoints, fencing tokens, 429/503 back-off, expired-key handling, replay | Implemented against the **published API shape** and a mock only |
| `POST /api/onboarding/uploads` + mapping / dry-run / decision / publish | in | Raw bytes ≤ 5 MB with `x-filename`; versioned mapping spec (`MappingSpecSchema`); publication only through intake | Implemented, tested |
| Versioned reporting views `reporting.*_v1` | out (BI) | Stable column names and grains for Power BI / Fabric (`docs/reporting-contract.md`) | Implemented; no BI tool connected |
| Read-only evidence endpoints (`/api/investigations/:id/evidence`, `/api/customers/:id/raw-events/:rawEventId`) | out | Branch-scoped; returns stored source records behind a finding | Implemented |
| Domain events (`domain_events` outbox: `intake.records_stored`, `action_center.proposal_executed`, …) | out | Written in the same transaction as the change; consumers are idempotent (at-least-once delivery plus idempotent effects, not "exactly once") | Implemented |
| Audit log (`audit_log`) | out | Who, what, when, subject; counts and codes, never personal values | Implemented |
| Identity | in | Demo cookie today. Production: SSO claims → `Viewer` (roles → permissions → branch scope) | **Not implemented** |
| Alerting / observability | out | Health endpoint and freshness on Audit & Health; no pager integration | Partial |

## Compatibility rules

- **Mapper versions are additive**: old versions stay so stored records stay explainable; a
  replay re-maps stored payloads with a newer version (`lib/adapters/registry.ts`).
- **Reporting views are versioned** (`_v1`); a breaking change adds `_v2` beside it.
- **Onboarding mappings are versioned per (dataset, export layout fingerprint)** with spec hashes;
  a re-export with the same layout reuses the approved version.
- **Freshness and quality travel with the data**: every published row keeps its raw event, mapper
  version and (for onboarding) upload, mapping version and dry run.

## Contract tests against vendor specifications

The FieldRoutes mapper's schemas follow the public API field names (`customerID`, `dateUpdated`,
`paymentID` with no version clock, `"0000-00-00 00:00:00"` as null). Contract tests run against
recorded **synthetic** payloads in that shape. Running them against a sandbox account would
require credentials and authorisation, neither of which this project has.
