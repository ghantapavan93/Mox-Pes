# Release checks: `99518da`

Start here and the visitor tour (sharing review, 2026-11-19). On the hosted site, where nobody
switches roles, the sidebar's Guided demo stopped at its fourth step: "Use this role" posted to
`/api/role`, which answers 404 there, so the button did nothing (`captures/before-step4-1440.jpg`;
the same request from a visitor's browser got 404). And a shared link opened the Overview, an
analytics screen a non-specialist cannot read alone.

| Commit | What |
|---|---|
| `1cb38c4` | `/start`; the seven-step visitor tour of B20's finished repair; `/demo` offers the tour, and the B09 presenter path only in demo mode; the B09 bar's role button only where roles switch |
| `48c6d77` | 1440 px pixel baselines: only the sidebar's link list moved (x 0–164, y 117–690) |
| `b47e298` | Two defects the checks found: B20's held payloads were regions sharing one name (axe landmark-unique); the new sweep entries used the guest role, which the hydration gate does not take |
| `99518da` | The tour opens its step's section on a full page load too (found on production, below) |

| Check | Result |
|---|---|
| Clean checkout of `48c6d77`: npm ci, build, typecheck, lint | pass (`../release-48c6d77/`) |
| Vitest on `48c6d77` | 100 files, 1,099 passed + 1 expected failure: 9 more than `553282c` (the tour's unit tests; its incident before and after the repair) |
| AI eval, deterministic, on `48c6d77` | 15/15, tool precision 99.0%, recall 100% (unchanged) |
| Acceptance on `48c6d77`: B09, BYOF | pass |
| Browser suite on `48c6d77` | 142 passed, 5 failed, 1 skipped: axe at four widths and the hydration gate, both on the new sweep entries; fixed in `b47e298` |
| Clean checkout of `b47e298`: build, typecheck, lint, browser suite | pass; 147 passed, 1 skipped, 0 failed (`../release-b47e298/`) |
| Hosted journeys `@core` on production `b47e298` | 7 passed, 1 failed (J5's phone step), 2 did not run (`hosted-core-b47e298.txt`) |
| Clean checkout of `99518da`: build, typecheck, lint, browser suite | pass; 147 passed, 1 skipped, 0 failed (`e2e.txt`) |
| Hosted journeys `@core` on production `99518da` | 10/10: J1 ×5, J4, J5 ×3, J2 (`hosted-core.txt`) |
| The tour's first step on a phone, production, 10 full loads | the receipt's figure above the tour bar: 1 of 10 on `b47e298`, 10 of 10 on `99518da` (`phone-step1-*.txt`) |

Vitest, the AI eval and the two acceptance runs ran on `48c6d77`. `b47e298` and `99518da` change one
region's name on the incident page, two sweep entries and the tour bar's scrolling; none of those
runs renders a page, so they were not run again. Every browser check was.

**The landmark defect predates the tour.** The tour's evidence step put B20's incident page in the
axe sweep for the first time: its held-records table named every payload sample's scroll region
"Payload sample", and regions sharing a name are one landmark repeated. Each is now named for its
raw event. No earlier sweep opened a quarantine incident with held records.

**The phone step, before and after.** The tour starts with a redirect, so its first step is a full
page load. Its URL names `#fix-result`, and the browser tries that jump once, while the receipt may
still be streaming in hidden; then the page stays at the top, and on a phone the receipt's figure
sits under the tour bar. The mirror's server answered fast enough that the browser suite never
missed; production missed 9 loads in 10. `useOpenSection` (`components/GuideBar.tsx`) keeps the
step's section at the top of the window for five seconds once it is shown, and stops on the
visitor's own scroll, key or touch. Steps reached with Next were always right: Next scrolls to a
`#section` itself on client-side navigations.

**Pixel baselines** (`48c6d77`): deleted and written again. The old ones still passed (0.33% and
0.19% of pixels, under the 1% tolerance), so they were replaced on purpose rather than left to pass.
The 390 px baselines match unchanged: there the links sit behind the closed Menu.

**Captures** (`captures/`): before, production at `7aaa85b` (`before-*.jpg`, by
`../../harness/guided-demo-before.cjs`); after, production at `99518da` as the public-demo guest
(by `../../harness/tour-captures.cjs`: every step at 1440 px, the answer at step 6, the Start page
and two steps at 390 px). The tour's question was deleted after each capture and each J5 run;
J4's stays in its visitor's private workspace for 24 hours, as on every hosted run.

Production served `b47e298` 70 s after its push and `99518da` 50 s after its push. Same Neon
release branch, no data or variable change.
