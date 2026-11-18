# EGM Stage 8: intermediate zoom-out report

- **Target:** `docs/agent-work/release/RELEASE-DESIGN.md` version 3 after Stages 6–7 (1,503 lines)
- **Reviewer:** `egm:egm-zoom-out`, fresh context, Zoom-Out Standard, with the Stage 5–7 reports
- **Date:** 2026-11-18
- **Verdict:** no Blocker, 5 Major, 6 Nit. The core workspace is proportionate; the excess was in
  four add-ons. Resolutions: [`resolution_log.md`](resolution_log.md).

## Major

1. **Visitor investigations could be deferred:** no success criterion needs them; the strand is
   expensive (two tables, a table switch, a second cookie handler, a quota kind, a per-visitor cap,
   deletion, a merged list, a guard test); the "read-only examples" do not exist, since the seed
   creates no investigations. Simpler: seed a few deterministic investigations, or add the
   requirement to §1 if the brief needs visitors to ask.
2. **The quota grid is over-built and misses the expensive path:** daily caps can lock everyone out
   for a day (the sample included); dry runs are not counted, so "at most 500,000 row writes a day"
   is false; caps do not limit compute-hours; per-visitor caps are "not a security control";
   `WORKSPACE` omits limits the page is generated from. Simpler: file limits, the row budget with
   eviction, one per-minute upload cap, one counter of rows written by staging and dry runs per
   minute and day, the sample exempt; drop per-visitor caps.
3. **A run per successful sync job overstates freshness:** a job covers one office but would write
   the company-wide stream, so one office's sync could clear staleness for all 44 branches; it
   shows nothing on the hosted demo. Simpler: leave the sync path and the four readers alone;
   `dataTimes()` reads `sync_jobs` beside the runs.
4. **Cut the hosted cache and `data_loads`:** the cache's trigger exists only after the release SHA
   is fixed; an in-memory cache is usually empty for a cold reviewer; `data_loads` serves only it.
5. **The actor table contradicted the separate investigation tables** (it listed `investigations`
   and `investigation_steps` as workspace writes).

## Nit

6. **Publication coverage can be cut:** only staff publish, and the publish route already starts
   reconciliation right after responding; replace the overclaim with a true sentence and drop
   `txid`.
7. **Deletion wording contradicts itself** ("deleted by", "available until … within a day",
   "deleted after 24 hours"): one sentence, generated from `lib/workspace.ts`.
8. **Package order:** WP-D need wait only for WP-A steps 1–3 and `dataTimes()`.
9. **The release gate ran the Linux suite twice** (the CI mirror and GitHub CI), and a restart
   would recreate an existing Neon branch: make GitHub CI the gate; reload only when migrations or
   the seed changed.
10. **The cold review was not cold:** it inherited the smoke test's visitor and items; delete them
    first.
11. **Two small extras:** `OLLAMA_ALLOW_REMOTE` is speculative; the clipboard helper re-implemented
    the loader's reader.

## Already proportionate (keep)

Workspace uploads reusing the onboarding service with ownership on the parent; per-upload
mappings; repeat detection on the stored hash; the clocks table; `ledger_target`; promoting the
verified release database with Neon `main` as the rollback; the two hosting procedures; Preview
through the owner's Chrome; the deployment-step rollback check; Ollama behind `ModelClient` with an
explicit key; "other" failing the evals; performance steps 1–3 with the equality test; CI fixed at
its causes; `Drawer`, `useAction`, `StateBadge`, and the one-primary-action gate on the ★ routes.
