# Security review against OWASP ASVS 5.0 (Stage 3)

ASVS is used as a **review framework**, not claimed as a certification. Passing tests is not
compliance. Status: **Met** (implemented and tested here), **Partial**, **Not met**, **N/A**.
Everything runs on synthetic data; the demo's role picker is not authentication.

## How a role is established (audited in code)

| Question | Finding |
|---|---|
| Where does the server get the viewer? | `lib/server.ts getViewer()`: the `rs_role` cookie, **only in demo mode** (`lib/demo-mode.ts`: development, tests, or a production build started with `DEMO_MODE=1`). A production build without the flag makes everyone a read-only guest. |
| Can a query string set a role? | No. No code reads a role from the URL. Tested by the hostile-input gate. |
| Can a header set a role? | No. No code reads a role from a request header. |
| Can the cookie be forged? | In demo mode, yes, by design: anyone may pick any role (`POST /api/role`). It is validated against the role list (unknown values → 400; `__proto__` → guest). In production mode the cookie is ignored and `/api/role` is a 404 (`tests/unit/security.test.ts`). |
| Can one person approve their own work? | **Before this pass, yes, if they held two roles.** Separation of duties compared roles. Now every viewer has a `subject` (the identity provider's user id; in demo one per role), stored on proposals, approvals, mapping decisions and publications. The application refuses the same subject, and so does the database (CHECK on `onboarding_mappings`; trigger on `action_approvals`). `tests/integration/security.test.ts`. |
| Cross-site writes? | Cookie `SameSite=Lax`, `HttpOnly`, `Secure` over TLS. `proxy.ts` additionally refuses state-changing `/api` requests whose `Origin` or `Sec-Fetch-Site` says they came from another site (key-authenticated ingest and the mock are exempt). |

## Chapters

| ASVS 5.0 chapter | Status | Evidence / gap |
|---|---|---|
| V1 Encoding and sanitization | Met | Parameterised SQL everywhere; React escaping; no `dangerouslySetInnerHTML` in new code; no export sink for formula cells (flagged in profiles) |
| V2 Validation and business logic | Met | zod on every body; record ids via `parseRecordId`; money/date/identity validation in mappers; business-logic limits (one disposition per row, add-never-change, compare-only datasets); concurrency tested deterministically (`concurrency.test.ts`) |
| V3 Web frontend security | Partial | `SameSite`, `HttpOnly`, cross-site write refusal. **No Content-Security-Policy or security headers configured** |
| V4 API and web service | Met for this scope | Uniform JSON errors without internals (`errorResponse`); body limits on every route; methods restricted per route |
| V5 File handling | Met | Extension and content agreement, size/row/cell/decoded-text limits, macro/ActiveX/external-link/encryption refusal, zip-bomb and amplification defences, sanitised display-only names, storage by id, retention. **No malware scanning** |
| V6 Authentication | **Not met (by design of the demo)** | No authentication. Production must derive the viewer from SSO (the integration contract: `subject`, roles, brand scope from IdP claims) |
| V7 Session management | Partial | Cookie flags as above. No session expiry or revocation: there is no session beyond the demo role cookie |
| V8 Authorization | Met for the model; Partial for revocation | Server-side permission and branch scope on every route; person-level separation of duties; database-enforced. **Stale or revoked permissions**: with SSO, permissions would be re-read per request; the demo cannot test revocation |
| V9 / V10 Tokens, OAuth/OIDC | N/A here | No tokens issued or consumed. An OIDC integration would need ID-token validation per V9/V10 |
| V11 Cryptography | Partial | SHA-256 for PII hashing and fingerprints; `timingSafeEqual` for the ingest key. **Unkeyed hashes are re-identifiable** (REMAINING-RISKS R-5) |
| V12 Secure communication | Not assessed | Local HTTP only; TLS is the deployment's responsibility |
| V13 Configuration | Partial | Fails closed in production without `INGEST_API_KEY`; demo features off without `DEMO_MODE`. No secrets in the repository (scanned at commit). No dependency vulnerability scanning in CI |
| V14 Data protection | Partial | PII hashed before storage; staged cells deleted within 24 h and with their quoted copies; audit holds no cell values. No encryption at rest; no data-classification policy |
| V15 Secure coding and architecture | Met for this scope | Bounded resources, linear parsers, two independent reviews (REVIEW-FINDINGS) |
| V16 Security logging and error handling | Partial → improved | Audit trail is now **append-only, enforced by the database** (`audit_log` trigger). No tamper-evident hashing chain, no external log shipping |

## Not tested, and why

- Revoked permissions mid-session and multiple real sessions per person: need a real identity
  provider. The subject model is the boundary that makes them testable once one exists.
- File download authorization: the product has no download endpoint (samples are public,
  synthetic files).
