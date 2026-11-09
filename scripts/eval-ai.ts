import { createPool, DEFAULT_DATABASE_URL, getNow, withRollback } from "@/lib/db";
import { EVAL_CASES, DATASET_VERSION, loadFixture, scoreCase, skippedScore, summarize, type CaseScore } from "@/lib/ai/eval";
import { runInvestigation } from "@/lib/ai/investigate";
import { anthropicModelClient } from "@/lib/ai/model";
import { VIEWERS } from "@/lib/viewer";
import { nestedPool } from "@/lib/workflow/nested";

/**
 * npm run eval:ai [-- --mode=deterministic|model] [--case=<id>] [--no-store]
 *
 * Runs the evaluation dataset (lib/ai/eval.ts) against DATABASE_URL (default: the demo
 * database). Each case runs inside a transaction that is ROLLED BACK: its investigation, steps,
 * audit rows, any AI proposal and any injected fixture disappear afterwards, so evaluating never
 * changes the data it evaluates. Only the aggregate is stored, in ai_eval_runs (skip with
 * --no-store).
 *
 * --mode=model needs ANTHROPIC_API_KEY; without it the script refuses rather than silently
 * evaluating the deterministic path under the model's name.
 */

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit?.slice(name.length + 3);
}

const pct = (v: number) => `${(v * 100).toFixed(1)}%`;

async function main() {
  const mode = (arg("mode") ?? "deterministic") as "deterministic" | "model";
  if (mode !== "deterministic" && mode !== "model") throw new Error(`--mode must be deterministic or model, not ${mode}`);
  const client = mode === "model" ? anthropicModelClient() : null;
  if (mode === "model" && !client) {
    console.error("Model mode was NOT evaluated: ANTHROPIC_API_KEY is not set (or AI_INVESTIGATOR_MODE=deterministic).");
    process.exit(2);
  }
  const only = arg("case");
  const store = !process.argv.includes("--no-store");
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const fixture = await loadFixture(pool);
  const cases = EVAL_CASES.filter((c) => !only || c.id === only);
  const scores: CaseScore[] = [];

  for (const c of cases) {
    const question = c.question(fixture);
    if (!question) {
      scores.push(skippedScore(c, "fixture missing from this database"));
      continue;
    }
    const score = await withRollback(pool, async (tx) => {
      if (c.setup) await c.setup(tx, fixture);
      const db = nestedPool(tx);
      const out = await runInvestigation(db, { question, branchId: c.branchId, viewer: VIEWERS[c.role], mode: client ? "auto" : "deterministic", client });
      return scoreCase(c, question, fixture, { steps: out.steps, result: out.result, latencyMs: out.latencyMs, costMicros: out.costMicros });
    });
    scores.push(score);
    console.log(`${score.pass ? "PASS" : "FAIL"}  ${c.id.padEnd(36)} tools ${pct(score.toolRecall)} recall / ${pct(score.toolPrecision)} precision · evidence ${pct(score.evidenceRecall)} · ${score.latencyMs} ms${score.failures.length ? `  — ${score.failures.join("; ")}` : ""}`);
  }

  const summary = summarize(scores);
  console.log("");
  console.log(`Dataset ${DATASET_VERSION} · mode ${mode} · ${summary.passed}/${summary.scored} passed (${summary.skipped} skipped)`);
  console.log(
    [
      `tool precision ${pct(summary.toolPrecision)}`,
      `tool recall ${pct(summary.toolRecall)}`,
      `evidence recall ${pct(summary.evidenceRecall)}`,
      `grounding rate ${pct(summary.groundingRate)}`,
      `unsupported claims ${summary.unsupportedClaims}`,
      `forbidden claims ${summary.forbiddenHits}`,
      `refusal accuracy ${pct(summary.refusalAccuracy)}`,
      `proposal accuracy ${pct(summary.proposalAccuracy)}`,
      `schema validity ${pct(summary.schemaValidity)}`,
      `latency p50 ${summary.latencyMs.p50} ms / p95 ${summary.latencyMs.p95} ms / max ${summary.latencyMs.max} ms`,
      `cost $${(summary.costMicros / 1_000_000).toFixed(4)}`,
    ].join(" · "),
  );

  if (store) {
    const now = await getNow(pool);
    const { rows } = await pool.query<{ id: string }>(
      `insert into ai_eval_runs (ran_at, mode, dataset_version, cases, passed, metrics, results, actor)
       values ($1, $2, $3, $4, $5, $6, $7, 'eval-ai script') returning id`,
      [now, mode, DATASET_VERSION, summary.cases, summary.passed, summary, JSON.stringify(scores)],
    );
    console.log(`Stored as ai_eval_runs #${rows[0].id}.`);
  }
  await pool.end();
  if (summary.passed < summary.scored) process.exitCode = 1;
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
