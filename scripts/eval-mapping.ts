import { readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { runMappingEval, type EngineReport, type EvalDataset } from "@/lib/onboarding/eval";

/**
 * npm run eval:mapping [-- --set=v3] [-- --json=out.json] [-- --failures]
 *
 * Scores the schema assistant and the naive baseline on one evaluation set: accuracy, abstention,
 * and the risk view (precision, coverage, wrong suggestions by consequence, calibration, the
 * correction burden on a person). Deterministic: the same code and dataset give the same numbers.
 */
const args = process.argv.slice(2);
const set = args.find((a) => a.startsWith("--set="))?.slice(6) ?? "v1";
const file = path.join(__dirname, "..", "tests", "fixtures", "onboarding", `mapping-eval.${set}.json`);
const data = JSON.parse(readFileSync(file, "utf8")) as EvalDataset;
const report = runMappingEval(data);

const pct = (n: number) => `${(n * 100).toFixed(1)}%`;
function show(r: EngineReport) {
  const o = r.overall;
  console.log(`\n== ${r.engine}`);
  console.log(`  field labels          ${o.labels}`);
  console.log(`  correct               ${o.correct}  (${pct(o.accuracy)})`);
  console.log(`  wrong                 ${o.wrong}`);
  console.log(`  abstained             ${o.abstained}`);
  console.log(`  suggestions made      ${o.suggestions}`);
  console.log(`  wrong-suggestion rate ${pct(o.wrongSuggestionRate)}  (${o.wrong}/${o.suggestions})`);
  console.log(`  abstention recall     ${pct(o.abstentionRecall)}  (ambiguous/absent labels left unmapped)`);
  console.log(`  over-abstention       ${pct(o.overAbstention)}  (mappable labels left unmapped)`);
  console.log(`  dataset detection     ${r.detection.correct}/${r.detection.cases}`);
  console.log(`  latency p50/p95/max   ${r.latencyMs.p50} / ${r.latencyMs.p95} / ${r.latencyMs.max} ms`);
  console.log("  by category (correct / labels, wrong):");
  for (const [cat, t] of Object.entries(r.byCategory)) console.log(`    ${cat.padEnd(22)} ${t.correct}/${t.labels}  wrong ${t.wrong}`);
}
console.log(`Dataset ${report.datasetVersion}, ${report.cases} cases. Cost: ${report.cost.tokens} tokens, $${report.cost.dollars} (no model provider).`);
show(report.assistant);
show(report.baseline);
const pctr = (n: number) => `${(n * 100).toFixed(1)}%`;
console.log("\n== risk (assistant | naive baseline)");
const ra = report.risk.assistant, rb = report.risk.baseline;
console.log(`  precision (correct / suggested)   ${pctr(ra.precision)} | ${pctr(rb.precision)}`);
console.log(`  coverage (mappable suggested)     ${pctr(ra.coverage)} | ${pctr(rb.coverage)}`);
console.log(`  abstention precision / recall     ${pctr(ra.abstentionPrecision)} / ${pctr(ra.abstentionRecall)} | ${pctr(rb.abstentionPrecision)} / ${pctr(rb.abstentionRecall)}`);
console.log(`  wrong by severity (crit/high/med/low)  ${Object.values(ra.wrongBySeverity).join("/")} | ${Object.values(rb.wrongBySeverity).join("/")}`);
console.log(`  critical unsafe rate (fields)     ${pctr(ra.criticalUnsafeRate)} | ${pctr(rb.criticalUnsafeRate)}`);
console.log(`  wrong dataset (cases)             ${ra.wrongDatasets.count}/${ra.wrongDatasets.cases} | ${rb.wrongDatasets.count}/${rb.wrongDatasets.cases}`);
console.log(`  correction burden (total, per case)  ${ra.correctionBurden.total}, ${ra.correctionBurden.perCase.toFixed(2)} | ${rb.correctionBurden.total}, ${rb.correctionBurden.perCase.toFixed(2)}`);
console.log(`  calibration: ${Object.entries(ra.calibration).map(([k, v]) => `${k} ${v.correct}/${v.suggestions} (${pctr(v.accuracy)})`).join(", ")}`);
if (args.includes("--failures")) console.log("\nAssistant wrong suggestions by consequence:");
if (args.includes("--failures")) for (const w of ra.wrongDetail) console.log(`  [${w.severity}] ${w.caseId} · ${w.field}: ${w.why}; suggested ${JSON.stringify(w.suggested)}, label ${JSON.stringify(w.label)}`);
if (args.includes("--failures")) {
  console.log("\nAssistant failures:");
  for (const f of report.assistant.failures) console.log(`  [${f.verdict}] ${f.caseId} · ${f.field}: label=${JSON.stringify(f.label)} suggested=${JSON.stringify(f.suggested)} (${f.status})`);
  for (const d of report.assistant.detection.failures) console.log(`  [detection] ${d}`);
}
const out = args.find((a) => a.startsWith("--json="));
if (out) writeFileSync(out.slice(7), JSON.stringify(report, null, 2));
