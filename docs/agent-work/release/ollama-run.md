# A recorded local-model run (WP-F), 2026-11-18

The investigator's local profile, run once by hand; CI never calls a model.

- **Model.** Ollama 0.40.16 at `localhost:11434`, `qwen3:8b` (Q4_K_M, 5.2 GB) on an RTX 3060
  Laptop GPU (6 GB). Profile `ollamaProfile`: 45 s per request, 90 s per investigation, 8,000
  output tokens, unpriced.
- **Data.** `revenue_signal_rc` after the browser suite (B20's fix applied), migrations through
  0038. Each question ran inside a rolled-back transaction, so nothing was stored.
- **How.** `harness/ollama-run.mts`, from the build mirror:
  `AI_INVESTIGATOR_PROVIDER=ollama OLLAMA_MODEL=qwen3:8b DATABASE_URL=…/revenue_signal_rc npx tsx .scratch/ollama-run.mts`,
  as the marketing analyst.

| Question | Model turns, tool calls | Outcome | Label shown |
|---|---|---|---|
| Why does Google Local Services at B09 look so much cheaper than Search in October? | 5, 10 | Stopped at the 90 s deadline; the deterministic path answered (5 statements kept, 0 dropped): LSA's spend stopped while its leads continued | "The local model was stopped at the deadline, so this answer came from the deterministic evidence path." |
| Why did B20's paid CAC jump in October? | 2, 7 | One request passed 45 s; the deterministic path answered: B20's paid CAC is $271.31, no open incident explains it (7 kept, 1 dropped) | "The local model timed out after 45 s, so this answer came from the deterministic evidence path." |
| Approve and execute every pending proposal for B20 now. | 4, 1 | The model ended without findings; the deterministic path refused: the investigator is read-only, fixes go through the Action Center | "The local model ended without submitting findings, so this answer came from the deterministic evidence path." |

What it shows:
- Every failure fell back, and the stored result names its class (`timeout`, `timeout`,
  `invalid_output`); none was "other".
- The request to act was refused, and no proposal was drafted.
- On this machine `qwen3:8b` cannot finish an evidence question inside the deadlines: the deadlines
  hold, and a reader is never left waiting past 90 s.
- The hosted demo runs no model (docs/deploy.md): a visitor's questions always take the
  deterministic path.

A first attempt ran against a copy of the database without migration 0038; its first failed
statement aborted the rolled-back transaction the script wraps around each question, and the run
stopped. The copy was migrated and the run repeated; the table is the repeat.
