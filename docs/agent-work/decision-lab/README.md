# Decision Lab load time (R-34): evidence

The method, results and conclusions are in `../PERFORMANCE.md` §6. This folder holds what they rest on. Everything here
was produced on 2026-11-13 by `scripts/measure-decision-lab.ts` against a production build and the synthetic database
`revenue_signal_lab`.

| Path | What it is |
|---|---|
| `timing/before.jsonl`, `timing/after.jsonl` | One JSON line per sample, tagged with layer (`db`, `server`, `direct`, `nav`), phase (`fresh`/`warm`), seed and width. 32 samples each, 8 seeds each |
| `timing/final.jsonl` | The same protocol on the final build, the one committed |
| `timing/journey-before.jsonl`, `timing/journey-after.jsonl` | The Decision Lab → incident #2455 → back journey at desktop (1280 × 800) and phone (390 × 844, touch, 2×) size |
| `decision/before-<scenario>-decision.json`, `decision/after-…` | The library's decision objects for each scenario: verdicts, verified readiness with every rule, the live A/A analysis, saved scenarios, experiments |
| `decision/before-<scenario>-snapshot.json`, `decision/after-…` | The rendered page once every card has loaded: scope, branch choices, the hold, verdicts, verified readiness, scenarios and experiments as text, with every `<details>` open, and every link |
| `screens/{before,after}_{desktop,phone}_{step}.png` | The journey's four steps: 1 the hold usable, 2 the verified verdict, 3 the incident's evidence, 4 back on the Decision Lab |

The scenarios:
- `b09`: marketing (all 44 branches), B09, October. The hold: not ready on every paid channel because of
  incident #2455.
- `b40`: the brand lead (Joshua's Pest Control, 5 branches), B40. A trusted budget signal, and one channel with too
  few customers.
- `b20`: the branch partner (B20 only). Not ready because of incident #1063.

`before` and `after` are identical for every scenario, in the library and on the page.
