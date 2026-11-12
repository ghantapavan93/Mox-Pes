/**
 * Record figures a template renders, and their proofs (R-38).
 *
 * The proof engine (lib/ai/proof.ts) proves METRIC propositions: paid CAC, spend, collected cash,
 * readiness. A template sentence also states record figures the metric vocabulary does not hold:
 * "119 calls record(s) at B20 are quarantined", "across 4 campaign(s)", "from 134 stored payment
 * record(s)". Until R-38 such a figure was left unproved and the sentence was still shown as
 * supported: a figure that merely appears in a tool's output proves nothing.
 *
 * A template now declares, for each record figure, the field of the returned record it renders:
 * `{ figure: "119", evidenceId: "exception:1063", path: "evidence.records" }`. The analyst re-reads
 * that field from the tool output recorded in this run (not from the template's variable) and
 * proves the figure equals it. That proves a faithful rendering with explicit provenance (tool,
 * record, field); it does not make the field mean more than its name, so the proof says which
 * field it is.
 *
 * Only the deterministic investigator's templates may declare renders: the declarations live in
 * a side table keyed by the observation object, outside the draft schema the model submits, so
 * model text cannot certify itself this way (it is held to the closed reading instead).
 */
import { claimNumbers } from "./numbers";
import type { Gap, Proof } from "./proof";

export interface Render {
  /** The figure exactly as the template wrote it ("119", "$450.00"). */
  figure: string;
  /** The tool whose recorded output holds the field. */
  tool: string;
  /** A record that tool call returned (the citation the figure rests on). */
  evidenceId: string;
  /**
   * Where the field is in that tool call's output: "records", "exceptions[id=1063].evidence.records",
   * "streams[stream=ads].staleAfterHours", "excluded[code=NOT_SUCCESSFUL].count". A selector may
   * test several dotted keys: "[evidence.leadBranch=B06&evidence.crmBranch=B07]". A leading "#"
   * counts a list: "#leads", "#leads[source=calls]". " + " adds fields ("#campaigns + campaignsOmitted").
   * A field ending in "Cents" holds money in cents.
   */
  path: string;
}

const RENDERS = new WeakMap<object, readonly Render[]>();

/** Declares the record figures an observation renders. Returns the observation itself. */
export function rendered<T extends object>(observation: T, renders: Render[]): T {
  RENDERS.set(observation, renders);
  return observation;
}

export function rendersOf(observation: object): readonly Render[] {
  return RENDERS.get(observation) ?? [];
}

export interface RecordedOutput {
  tool: string | null;
  evidenceIds: readonly string[];
  output: unknown;
}

type Resolved = { ok: true; value: number } | { ok: false; reason: string };

const dig = (node: unknown, dotted: string): unknown =>
  dotted.split(".").reduce<unknown>((n, k) => (n && typeof n === "object" ? (n as Record<string, unknown>)[k] : undefined), node);

/**
 * Splits a path into segments at the dots outside selectors: "a[x.y=1].b" → ["a[x.y=1]", "b"].
 */
function segmentsOf(path: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let current = "";
  for (const ch of path) {
    if (ch === "[") depth += 1;
    if (ch === "]") depth -= 1;
    if (ch === "." && depth === 0) {
      out.push(current);
      current = "";
    } else current += ch;
  }
  out.push(current);
  return out;
}

/** Reads one numeric field (or a list's length) from a tool output. Pure: nothing but the recorded output. */
function readOne(output: unknown, path: string): Resolved {
  const count = path.startsWith("#");
  const segments = segmentsOf(count ? path.slice(1) : path);
  let node: unknown = output;
  for (let i = 0; i < segments.length; i += 1) {
    const m = /^([\w$]+)(?:\[([^\]]+)\])?$/.exec(segments[i]);
    if (!m) return { ok: false, reason: `"${segments[i]}" is not a field` };
    const [, name, selector] = m;
    const next = node && typeof node === "object" ? (node as Record<string, unknown>)[name] : undefined;
    const last = i === segments.length - 1;
    if (selector !== undefined) {
      if (!Array.isArray(next)) return { ok: false, reason: `${name} is not a list` };
      const tests = selector.split("&").map((t) => {
        const at = t.indexOf("=");
        return { key: t.slice(0, at), wanted: t.slice(at + 1) };
      });
      const matches = next.filter((el) => tests.every(({ key, wanted }) => String(dig(el, key)) === wanted));
      if (count && last) return { ok: true, value: matches.length };
      if (matches.length !== 1) return { ok: false, reason: `${matches.length} entries of ${name} match [${selector}]` };
      node = matches[0];
      continue;
    }
    if (count && last) {
      if (!Array.isArray(next)) return { ok: false, reason: `${name} is not a list` };
      return { ok: true, value: next.length };
    }
    node = next;
  }
  if (typeof node === "number" && Number.isFinite(node)) return { ok: true, value: node };
  return { ok: false, reason: node === undefined || node === null ? "the field is absent" : "the field is not a number" };
}

/** Reads `path` from a tool output; " + " adds fields. */
export function readPath(output: unknown, path: string): Resolved {
  let total = 0;
  for (const part of path.split(" + ")) {
    const r = readOne(output, part.trim());
    if (!r.ok) return r;
    total += r.value;
  }
  return { ok: true, value: total };
}

/** A figure as written: money ("$1,234.50", "−$3"), else a plain number ("119", "1,086", "5.3"). */
function parseFigure(figure: string): { money: boolean; value: number; decimals: number } | null {
  const n = claimNumbers(figure)[0];
  if (n?.kind === "money") return { money: true, value: n.value * n.scale, decimals: n.decimals };
  const plain = /^\s*(\d{1,3}(?:,\d{3})+|\d+)(?:\.(\d+))?\s*$/.exec(figure);
  return plain ? { money: false, value: Number(`${plain[1].replace(/,/g, "")}${plain[2] ? `.${plain[2]}` : ""}`), decimals: plain[2]?.length ?? 0 } : null;
}

const ROUNDING_EXACT = "equal at the precision written (half a unit of the last digit)";

/** The proof that a figure renders the field it declares. */
export function renderProof(render: Render, outputs: readonly RecordedOutput[], piece: string): Proof {
  const base: Proof = {
    piece,
    figure: render.figure,
    subject: { metric: null, entity: render.evidenceId, period: null },
    against: null,
    relation: "record",
    formula: `${render.evidenceId} · ${render.path}`,
    inputs: [],
    unit: null,
    computed: null,
    claimed: null,
    qualifier: "exact",
    direction: null,
    claimedDirection: null,
    precision: 0,
    rounding: ROUNDING_EXACT,
    verdict: "UNRESOLVED",
    gap: "fact_missing",
    reason: "",
  };
  const sources = outputs.filter((o) => o.tool === render.tool && o.evidenceIds.includes(render.evidenceId));
  if (sources.length === 0) return { ...base, reason: `${render.evidenceId}, the record it renders, was not returned by ${render.tool} in this run` };
  const written = parseFigure(render.figure);
  if (!written) return { ...base, gap: "metric_unknown", reason: `"${render.figure}" is not a figure` };
  const money = /Cents$/.test(render.path);
  if (money !== written.money) return { ...base, verdict: "CONTRADICTED", gap: null, reason: `a ${written.money ? "money" : "count"} figure rendering ${money ? "an amount in cents" : "a count"}` };
  let lastReason = "";
  for (const source of sources) {
    const read = readPath(source.output, render.path);
    if (!read.ok) {
      lastReason = read.reason;
      continue;
    }
    const actual = money ? read.value / 100 : read.value;
    const precision = written.decimals;
    const ok = Math.abs(actual - written.value) <= 0.5 * 10 ** -precision + 1e-9;
    return {
      ...base,
      formula: `${render.tool} → ${render.evidenceId} · ${render.path}`,
      unit: money ? "usd_cents" : "count",
      computed: actual,
      claimed: written.value,
      precision,
      verdict: ok ? "VERIFIED" : "CONTRADICTED",
      gap: null,
      reason: ok ? `equals ${render.path} of the record ${render.evidenceId}, as ${render.tool} returned it in this run` : `${render.path} of ${render.evidenceId} is ${money ? `$${actual.toFixed(2)}` : actual}`,
    };
  }
  return { ...base, reason: `${render.path} could not be read from what ${render.tool} returned for ${render.evidenceId}: ${lastReason}` };
}

/**
 * Gaps a record rendering may settle: the metric reader found no metric for the figure (or only a
 * measure it does not verify, or no such fact in what the claim cites, or read a replay's "would"
 * as a forecast). A metric reading that VERIFIED or CONTRADICTED the figure stands.
 */
const SETTLED_BY_RECORD: ReadonlySet<Gap> = new Set<Gap>(["metric_unknown", "metric_unsupported", "fact_missing", "hypothetical"]);

/**
 * The proofs of a template sentence with its record figures proved. Each declared figure takes the
 * first proof of the same figure the metric reader left unresolved; a figure the reader did not
 * take as a figure is appended. A rendering that does not match its field is appended even where
 * the metric reading held: the template rendered the wrong field.
 */
export function applyRenders(proofs: readonly Proof[], renders: readonly Render[], outputs: readonly RecordedOutput[], text: string): Proof[] {
  const out = [...proofs];
  const taken = new Set<number>();
  for (const r of renders) {
    const same = (p: Proof, i: number) => !taken.has(i) && p.figure.trim() === r.figure.trim();
    const open = out.findIndex((p, i) => same(p, i) && p.verdict === "UNRESOLVED" && p.gap !== null && SETTLED_BY_RECORD.has(p.gap));
    const at = open !== -1 ? open : out.findIndex(same);
    const proof = renderProof(r, outputs, at === -1 ? text : out[at].piece);
    if (open !== -1) {
      out[open] = proof;
      taken.add(open);
    } else if (at !== -1) {
      taken.add(at);
      if (proof.verdict !== "VERIFIED") out.push(proof);
    } else {
      out.push(proof);
      taken.add(out.length - 1);
    }
  }
  return out;
}
