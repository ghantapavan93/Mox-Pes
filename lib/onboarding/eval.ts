import { ASSISTANT_VERSION, normalizeHeader, suggestMappings, type AssistantResult } from "./assistant";
import type { ParsedTable } from "./parse";
import { profileTable } from "./profile";
import { DATASETS, type DatasetId } from "./targets";

/**
 * Evaluation of the schema assistant against an INDEPENDENTLY labeled set
 * (tests/fixtures/onboarding/mapping-eval.v1.json, written from the field definitions alone,
 * without access to the assistant's code).
 *
 * Scoring, per labeled field:
 *   label = a header   correct if that column is suggested; WRONG if another column is
 *                      suggested; ABSTAINED if nothing is suggested (a cost, not an error)
 *   label = null       correct if nothing is suggested; WRONG if any column is suggested
 *   label = ambiguous  correct if nothing is suggested (the person must be asked); WRONG otherwise
 * and per detection case: the chosen dataset, or an abstention when the label is "abstain".
 *
 * The safety metric is the WRONG-SUGGESTION RATE: of the columns the assistant put forward,
 * how many were not what the labeler says. Abstaining is always allowed to be safe; being
 * confidently wrong is the failure that matters. Every number is reported with its
 * denominator, per category, beside a naive baseline (header vocabulary only, never abstains).
 */

export interface EvalCase {
  id: string;
  category: string;
  dataset: DatasetId | null;
  headers: string[];
  rows: string[][];
  expect: { dataset?: DatasetId | "abstain"; fields: Record<string, string | null | "ambiguous"> };
  rationale: string;
}

export interface EvalDataset {
  version: string;
  cases: EvalCase[];
}

type Verdict = "correct" | "wrong" | "abstained";

export interface FieldResult {
  caseId: string;
  category: string;
  field: string;
  label: string | null;
  suggested: string | null;
  status: string;
  verdict: Verdict;
}

export interface Tally {
  labels: number;
  correct: number;
  wrong: number;
  abstained: number;
  /** Suggestions made (columns put forward). */
  suggestions: number;
}

export interface EngineReport {
  engine: string;
  overall: Tally & { accuracy: number; wrongSuggestionRate: number; abstentionRecall: number; overAbstention: number };
  byCategory: Record<string, Tally>;
  detection: { cases: number; correct: number; failures: string[] };
  failures: FieldResult[];
  latencyMs: { p50: number; p95: number; max: number };
}

/**
 * What a wrong suggestion would do if a person accepted it. Money in the wrong meaning moves
 * cash; a wrong identity or branch merges or misplaces customers; a wrong dataset puts a file
 * under the wrong source authority. These are the errors that matter, so they are counted apart.
 */
export type Severity = "critical" | "high" | "medium" | "low";

export interface RiskMetrics {
  /** Correct suggestions / suggestions made: how often a suggestion can be trusted. */
  precision: number;
  /** Mappable labels that received any suggestion / mappable labels. */
  coverage: number;
  /** Abstentions that were right (nothing should map, or a person must decide) / all abstentions. */
  abstentionPrecision: number;
  abstentionRecall: number;
  /** Wrong suggestions by consequence, with each one listed. */
  wrongBySeverity: Record<Severity, number>;
  wrongDetail: Array<{ caseId: string; field: string; severity: Severity; why: string; suggested: string | null; label: string | null }>;
  /**
   * Critical wrong FIELD suggestions (money meaning) / field suggestions made. Wrong datasets
   * are counted per case in `wrongDatasets`, not here: their fields are never scored, so mixing
   * them in would let an engine that misfiles every file report a rate of zero.
   */
  criticalUnsafeRate: number;
  /** Cases filed under the wrong dataset / cases where a dataset had to be detected. */
  wrongDatasets: { count: number; cases: number; rate: number };
  /** Accuracy within each stated confidence (empty for engines that state none). */
  calibration: Record<string, { suggestions: number; correct: number; accuracy: number }>;
  /** Field decisions a person must make or undo: wrong suggestions + mappable fields left empty. */
  correctionBurden: { total: number; perCase: number };
}

function severityOf(dataset: DatasetId, fieldKey: string): { severity: Severity; why: string } {
  const field = DATASETS[dataset].fields.find((f) => f.key === fieldKey);
  switch (field?.kind) {
    case "money":
      return { severity: "critical", why: "money in the wrong meaning" };
    case "identifier":
    case "phone":
    case "email":
      return { severity: "high", why: "wrong identity" };
    case "branch":
      return { severity: "high", why: "wrong branch" };
    case "datetime":
    case "date":
      return { severity: "medium", why: "wrong event time" };
    case "enum":
      return { severity: "medium", why: "wrong classification" };
    default:
      return { severity: "low", why: "wrong descriptive field" };
  }
}

export function riskMetrics(data: EvalDataset, engine: Engine): RiskMetrics {
  let suggestions = 0, correctSuggestions = 0, mappable = 0, mappableSuggested = 0, abstentions = 0, rightAbstentions = 0, shouldAbstain = 0, burden = 0;
  const wrongBySeverity: Record<Severity, number> = { critical: 0, high: 0, medium: 0, low: 0 };
  const wrongDetail: RiskMetrics["wrongDetail"] = [];
  const calibration: RiskMetrics["calibration"] = {};
  let fieldCritical = 0, detectionCases = 0, wrongDatasets = 0;
  for (const c of data.cases) {
    const result = engine(c);
    const labeled = c.dataset ?? (c.expect.dataset !== "abstain" ? c.expect.dataset : undefined);
    if (c.dataset === null && c.expect.dataset) detectionCases++;
    if (c.dataset === null && c.expect.dataset && result.dataset.chosen !== null && result.dataset.chosen !== c.expect.dataset) {
      // A file put under the wrong dataset is under the wrong source authority.
      wrongDatasets++;
      wrongBySeverity.critical++;
      wrongDetail.push({ caseId: c.id, field: "(dataset)", severity: "critical", why: "wrong dataset (source authority)", suggested: result.dataset.chosen, label: c.expect.dataset });
      burden++; // a person must notice the wrong dataset and choose again
    } else if (c.dataset === null && c.expect.dataset && c.expect.dataset !== "abstain" && result.dataset.chosen === null) {
      burden++; // a person must choose the dataset
    }
    if (labeled === undefined || result.dataset.chosen !== labeled) continue;
    for (const [field, label] of Object.entries(c.expect.fields)) {
      const s = result.fields.find((x) => x.field === field);
      const suggested = s && s.status === "suggested" ? s.column : null;
      const isMappable = label !== null && label !== "ambiguous";
      if (isMappable) mappable++;
      else shouldAbstain++;
      if (suggested === null) {
        abstentions++;
        if (!isMappable) rightAbstentions++;
        else burden++; // a person must choose the column
        continue;
      }
      suggestions++;
      if (isMappable) mappableSuggested++;
      const right = isMappable && suggested === label;
      const bucket = (calibration[s?.confidence ?? "none"] ??= { suggestions: 0, correct: 0, accuracy: 0 });
      bucket.suggestions++;
      if (right) {
        correctSuggestions++;
        bucket.correct++;
      } else {
        burden++; // a person must notice and undo it
        const { severity, why } = severityOf(labeled, field);
        wrongBySeverity[severity]++;
        if (severity === "critical") fieldCritical++;
        wrongDetail.push({ caseId: c.id, field, severity, why, suggested, label });
      }
    }
  }
  for (const b of Object.values(calibration)) b.accuracy = b.suggestions ? b.correct / b.suggestions : 0;
  return {
    precision: suggestions ? correctSuggestions / suggestions : 0,
    coverage: mappable ? mappableSuggested / mappable : 0,
    abstentionPrecision: abstentions ? rightAbstentions / abstentions : 0,
    abstentionRecall: shouldAbstain ? rightAbstentions / shouldAbstain : 0,
    wrongBySeverity,
    wrongDetail,
    criticalUnsafeRate: suggestions ? fieldCritical / suggestions : 0,
    wrongDatasets: { count: wrongDatasets, cases: detectionCases, rate: detectionCases ? wrongDatasets / detectionCases : 0 },
    calibration,
    correctionBurden: { total: burden, perCase: data.cases.length ? burden / data.cases.length : 0 },
  };
}

export interface EvalReport {
  datasetVersion: string;
  cases: number;
  assistant: EngineReport;
  baseline: EngineReport;
  risk: { assistant: RiskMetrics; baseline: RiskMetrics };
  /** The assistant is deterministic and local: no tokens, no provider, no per-case cost. */
  cost: { tokens: 0; dollars: 0; provider: "none" };
}

export function tableOf(c: Pick<EvalCase, "headers" | "rows">): ParsedTable {
  return {
    format: "csv",
    filename: "eval.csv",
    columns: c.headers,
    sourceHeaders: c.headers,
    rows: c.rows.map((r) => c.headers.map((_, i) => (r[i] === undefined || r[i] === "" ? null : r[i]))),
    rowRefs: c.rows.map((_, i) => i + 2),
    raggedRows: [],
    sheet: null,
    encoding: "utf-8",
    delimiter: ",",
    warnings: [],
  };
}

type Engine = (c: EvalCase) => Pick<AssistantResult, "dataset" | "fields">;

export const assistantEngine: Engine = (c) => {
  const table = tableOf(c);
  return suggestMappings(profileTable(table), { dataset: c.dataset, rows: table.rows });
};

/**
 * The naive baseline a quick script would be: map each field to the header that best matches
 * its vocabulary, no value checks, no money semantics, no abstention. Dataset = most fields matched.
 */
export const naiveEngine: Engine = (c) => {
  const pick = (dataset: DatasetId) =>
    DATASETS[dataset].fields.map((field) => {
      const vocab = [...field.synonyms, field.label].map(normalizeHeader);
      const column = c.headers.find((h) => vocab.includes(normalizeHeader(h))) ?? c.headers.find((h) => vocab.some((v) => v && normalizeHeader(h).includes(v))) ?? null;
      return { field: field.key, status: column ? "suggested" : "unmapped", column };
    });
  const dataset =
    c.dataset ??
    (Object.keys(DATASETS) as DatasetId[])
      .map((id) => ({ id, n: pick(id).filter((x) => x.column).length / DATASETS[id].fields.length }))
      .sort((a, b) => b.n - a.n)[0].id;
  return {
    dataset: { chosen: dataset, abstained: false, reason: "naive", scores: [] },
    fields: pick(dataset) as unknown as AssistantResult["fields"],
  };
};

const empty = (): Tally => ({ labels: 0, correct: 0, wrong: 0, abstained: 0, suggestions: 0 });

function percentile(sorted: number[], p: number): number {
  return sorted.length === 0 ? 0 : sorted[Math.min(sorted.length - 1, Math.floor(p * sorted.length))];
}

export function evaluate(data: EvalDataset, engine: Engine, name: string): EngineReport {
  const overall = empty();
  const byCategory: Record<string, Tally> = {};
  const failures: FieldResult[] = [];
  const detection = { cases: 0, correct: 0, failures: [] as string[] };
  const latencies: number[] = [];
  let ambiguousOrNull = 0;
  let ambiguousOrNullAbstained = 0;
  let mappable = 0;
  let mappableAbstained = 0;

  for (const c of data.cases) {
    const t0 = performance.now();
    const result = engine(c);
    latencies.push(performance.now() - t0);
    const cat = (byCategory[c.category] ??= empty());

    if (c.dataset === null && c.expect.dataset) {
      detection.cases++;
      const ok = c.expect.dataset === "abstain" ? result.dataset.chosen === null : result.dataset.chosen === c.expect.dataset;
      if (ok) detection.correct++;
      else detection.failures.push(`${c.id}: expected ${c.expect.dataset}, got ${result.dataset.chosen ?? "abstain"}`);
    }
    // Field labels are only meaningful against the dataset they were written for.
    const labeledDataset = c.dataset ?? (c.expect.dataset !== "abstain" ? c.expect.dataset : undefined);
    const fieldsComparable = labeledDataset !== undefined && result.dataset.chosen === labeledDataset;

    for (const [field, label] of Object.entries(c.expect.fields)) {
      const s = fieldsComparable ? result.fields.find((x) => x.field === field) : undefined;
      const suggested = s && s.status === "suggested" ? s.column : null;
      let verdict: Verdict;
      if (label === null || label === "ambiguous") verdict = suggested === null ? "correct" : "wrong";
      else verdict = suggested === label ? "correct" : suggested === null ? "abstained" : "wrong";
      for (const t of [overall, cat]) {
        t.labels++;
        t[verdict]++;
        if (suggested !== null) t.suggestions++;
      }
      if (label === null || label === "ambiguous") {
        ambiguousOrNull++;
        if (suggested === null) ambiguousOrNullAbstained++;
      } else {
        mappable++;
        if (suggested === null) mappableAbstained++;
      }
      if (verdict !== "correct") failures.push({ caseId: c.id, category: c.category, field, label, suggested, status: s?.status ?? (fieldsComparable ? "missing" : "dataset not chosen"), verdict });
    }
  }
  const sorted = [...latencies].sort((a, b) => a - b);
  const round = (n: number) => Math.round(n * 1000) / 1000;
  return {
    engine: name,
    overall: {
      ...overall,
      accuracy: overall.labels ? overall.correct / overall.labels : 0,
      wrongSuggestionRate: overall.suggestions ? overall.wrong / overall.suggestions : 0,
      abstentionRecall: ambiguousOrNull ? ambiguousOrNullAbstained / ambiguousOrNull : 0,
      overAbstention: mappable ? mappableAbstained / mappable : 0,
    },
    byCategory,
    detection,
    failures,
    latencyMs: { p50: round(percentile(sorted, 0.5)), p95: round(percentile(sorted, 0.95)), max: round(sorted[sorted.length - 1] ?? 0) },
  };
}

export function runMappingEval(data: EvalDataset): EvalReport {
  return {
    datasetVersion: data.version,
    cases: data.cases.length,
    assistant: evaluate(data, assistantEngine, ASSISTANT_VERSION),
    baseline: evaluate(data, naiveEngine, "naive-header-match"),
    risk: { assistant: riskMetrics(data, assistantEngine), baseline: riskMetrics(data, naiveEngine) },
    cost: { tokens: 0, dollars: 0, provider: "none" },
  };
}
