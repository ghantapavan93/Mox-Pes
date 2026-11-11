# Decisions (this session)

Each: problem → alternatives → choice → trade-off → evidence.

1. **Attack before building.** The brief's first instruction was to prove what breaks. 36
   adversarial cases ran against the existing intake before any new feature: 8 real defects,
   fixed with red-proven tests (ADVERSARIAL-MATRIX §1).
2. **One validation path for files.** Compile uploaded rows into the live feeds' payload shapes and
   run the deployed mapper (`prepare()`), instead of a second generic file validator. Trade-off:
   only datasets with a mapper can be onboarded. Evidence: the dry run quarantines with the same
   codes as live intake (integration tests).
3. **Authority decides what a file may do.** Calls and web leads may be published (a backfill of
   missed pushes); CRM payments and ad spend are compare-only. Rejected: letting an approver
   publish payments, because a stale export would overwrite newer API data.
4. **A file may add, never change.** Differences are reported fact by fact; changing a recorded
   fact is an Action Center correction. Enforced again at publication time, under a lock.
5. **Deterministic schema assistant, measured.** No LLM: free, private, reproducible, and its
   error rate is known. A model could implement the same contract only after beating it on the
   same held-out sets. Evidence: AI-EVALUATION.
6. **Three independently written evaluation sets, with the dev/held-out distinction kept.** v1 and
   v2 were each held out at first contact, then used for fixes; v3 was written after the rules
   froze and is the only generalisation claim. One failing case was deliberately left unfixed
   rather than overfitted.
7. **Small bounded XLSX reader instead of a dependency.** The job is refusing (macros, bombs,
   encryption, escaping paths, amplification) as much as reading. Trade-off: rich formatting is
   ignored. Reviewed and hardened after the security review (S1, S2).
8. **Separation of duties in a CHECK constraint**, not only in the service.
9. **Money meaning is a required, typed statement.** Nine meanings; only `collected_payment` may be
   cash. The assistant may suggest, but the dry run is blocked until a person states it.
10. **Compare at a compatible grain.** A date-only export is compared by office-local day, not at
    an invented time.
11. **Retention: cells and their quotations go; dispositions stay.** Purge committed before every
    operation (the first version purged inside a transaction that then rolled back).
12. **Formatter cache in shared primitives** after measurement (2,100 → 8,900 rows/s), not before.
13. **Demo exports derived from the seeded ledger** with documented deliberate differences, so the
    reconciliation demo finds real records. The held-out files stay test-only.
14. **No new UI library; one workspace page with an evidence-to-decision rail.** Alternatives
    considered: a client-side wizard (state lost on refresh, not shareable) and a multi-page flow
    (more routes, the same data). The single server-rendered page keeps every step addressable
    (`#mapping`, `#dry-run`, `?rows=invalid`) and testable.
