import { scanForInstructions } from "@/lib/ai/injection";
import { branchValueReport } from "./branches";
import { proposeValue } from "./vocabulary";
import type { ColumnProfile, TableProfile, ValueKind } from "./profile";
import { DATASETS, DATASET_IDS, MONEY_MEANINGS, type DatasetId, type FieldKind, type MoneyMeaning, type TargetField } from "./targets";

/**
 * The schema assistant: suggests which column of an unfamiliar export is which target field.
 *
 * It SUGGESTS; a person decides. Every suggestion carries its evidence (header vocabulary,
 * value shapes, branch matches, an earlier approved mapping), its alternatives and its reasons
 * to abstain. It abstains rather than guesses when:
 *   - two columns fit a field about equally well,
 *   - a money column's business meaning is unknown ("Total") or is the wrong meaning
 *     ("Contract Value" is a promise, not collected cash),
 *   - a header contains instruction-like text (headers are data, never instructions),
 *   - values contradict the header (a "Phone" column of dates),
 *   - no dataset fits the file clearly.
 *
 * Deterministic by design: the same profile gives the same suggestions, every case in the
 * evaluation set (tests/fixtures/onboarding/mapping-eval.v1.json) is reproducible, and no row
 * value leaves the process. A model-backed assistant could replace `suggestMappings` behind
 * the same output contract; it would have to beat this baseline on the same evaluation first.
 */

export const ASSISTANT_VERSION = "deterministic@1.0";

export type SuggestionStatus = "suggested" | "ambiguous" | "unmapped" | "blocked";

export interface Alternative {
  column: string;
  score: number;
  reason: string;
}

export interface FieldSuggestion {
  field: string;
  label: string;
  required: boolean;
  status: SuggestionStatus;
  column: string | null;
  confidence: "high" | "medium" | "low" | null;
  score: number;
  evidence: string[];
  alternatives: Alternative[];
  abstainReasons: string[];
  /** Always true: no suggestion becomes a mapping without a person confirming it. */
  requiresConfirmation: true;
  money?: { required: MoneyMeaning; detected: MoneyMeaning | "unknown"; column: string | null };
}

export interface DatasetGuess {
  chosen: DatasetId | null;
  abstained: boolean;
  reason: string;
  scores: Array<{ dataset: DatasetId; coverage: number }>;
}

export interface AssistantResult {
  engine: typeof ASSISTANT_VERSION;
  dataset: DatasetGuess;
  fields: FieldSuggestion[];
  /** Columns whose header reads like an instruction. Their text was not used as evidence. */
  suspiciousHeaders: string[];
  warnings: string[];
}

export interface ApprovedMappingHint {
  version: number;
  approvedBy: string;
  fields: Record<string, string | null>;
}

// ── Header vocabulary ─────────────────────────────────────────────────────────

/**
 * Abbreviations seen in real exports, expanded before matching. Domain terms included:
 * ANI is the calling number and DNIS the dialed number in telephony exports.
 */
const EXPANSIONS: Record<string, string> = {
  cust: "customer", acct: "account", amt: "amount", tx: "transaction", txn: "transaction", num: "number", no: "number", nbr: "number",
  ph: "phone", tel: "telephone", addr: "address", dt: "date", ts: "timestamp", qty: "quantity", conv: "conversions", "e mail": "email",
  pmt: "payment", pymt: "payment", rcvd: "received", recd: "received", inv: "invoice", orig: "original", ofc: "office", cd: "code",
  ref: "id", reference: "id", src: "source", ani: "caller number", dnis: "dialed number", title: "name", loc: "location",
  utm_source: "utm source", utm_medium: "utm medium", utm_campaign: "utm campaign",
};

/** "Cust #" -> "customer number"; "paymentID" -> "payment id"; "utm.source" -> "utm source". */
export function normalizeHeader(raw: string): string {
  const spaced = raw
    .normalize("NFKC")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/#/g, " number ")
    .toLowerCase()
    .replace(/[_\-./\\:()[\]]+/g, " ")
    .replace(/[^a-z0-9 ]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
  return spaced
    .split(" ")
    .map((t) => EXPANSIONS[t] ?? t)
    .join(" ")
    .replace(/\bid number\b/g, "id")
    .trim();
}

/**
 * Words that carry no meaning in a header: "Paid On" and "paid at" are one column; "Clicks
 * Total", "Cost (USD)" and "Received (CT)" name the clicks, the cost and the received time.
 */
const STOPWORDS = new Set(["at", "on", "of", "the", "a", "an", "in", "by", "to", "for", "total", "usd", "local", "ct", "et", "pt", "mt", "cst", "est", "pst", "mst", "utc"]);
/** "#", "No", "Number" and "ID" name the same thing in an identifier header. */
const tokens = (s: string) => new Set(normalizeHeader(s).split(" ").filter((t) => t && !STOPWORDS.has(t)).map((t) => (t === "number" ? "id" : t)));

/** Words that only say "this is a time" or "this is an id"; they never change what a column is. */
const TIME_WORDS = ["date", "time", "timestamp", "datetime", "day"];
const ID_WORDS = ["id", "code"];

const vocabularyOf = (field: TargetField) => [...field.synonyms, field.label, field.key.replace(/_/g, " ")];
const VOCAB_TOKENS = new Map<TargetField, Set<string>>();
function vocabularyTokens(field: TargetField): Set<string> {
  let v = VOCAB_TOKENS.get(field);
  if (!v) {
    v = new Set(vocabularyOf(field).flatMap((s) => [...tokens(s)]));
    if (field.kind === "datetime" || field.kind === "date") for (const w of TIME_WORDS) v.add(w);
    if (field.kind === "identifier" || field.kind === "branch") for (const w of ID_WORDS) v.add(w);
    VOCAB_TOKENS.set(field, v);
  }
  return v;
}

/** The field's own distinctive words (not "id", "date"...): what makes "Lead Ref" a lead id candidate. */
function distinctiveTokens(field: TargetField): Set<string> {
  const generic = new Set([...TIME_WORDS, ...ID_WORDS, "name", "status", "type"]);
  return new Set([...vocabularyTokens(field)].filter((t) => !generic.has(t)));
}

/**
 * How well a header matches a field's vocabulary, 0..1, with the matching synonym.
 *
 * A one-word synonym ("id", "date", "status", "source") is generic: it matches a header only
 * when the header's other words also belong to this field's vocabulary. "Payment Date" is a
 * payment date; "Service Date", "Visitor ID", "Caller ID" and "Sale Status" are something else
 * that happens to contain a generic word.
 */
function nameScore(header: string, field: TargetField): { score: number; synonym: string | null } {
  const h = [...tokens(header)].join(" ");
  if (!h) return { score: 0, synonym: null };
  const ht = tokens(header);
  const own = vocabularyTokens(field);
  let best = { score: 0, synonym: null as string | null };
  for (const syn of vocabularyOf(field)) {
    const st = tokens(syn);
    const s = [...st].join(" ");
    if (!s) continue;
    let score = 0;
    if (h === s) score = 1;
    else {
      const shared = [...st].filter((t) => ht.has(t)).length;
      if (shared === st.size) {
        const foreign = [...ht].filter((t) => !st.has(t) && !own.has(t));
        score = st.size === 1 && foreign.length > 0 ? 0.4 : Math.max(0.55, 0.85 - 0.1 * (ht.size - st.size));
      } else if (shared > 0) score = (0.5 * shared) / Math.max(st.size, ht.size);
    }
    if (score > best.score) best = { score, synonym: syn };
  }
  return best;
}

/** "Phone" and "Phone 2" / "Phone (2)" / "Alt Phone": numbered or alternate copies of one header. */
function areSiblings(a: string, b: string): boolean {
  const strip = (s: string) => [...tokens(s)].filter((t) => !/^\d+$/.test(t) && !["alt", "alternate", "secondary", "other", "2nd", "second", "primary"].includes(t)).join(" ");
  return a !== b && strip(a) !== "" && strip(a) === strip(b);
}

// ── Money meaning ─────────────────────────────────────────────────────────────

const MONEY_VOCABULARY: Array<{ meaning: MoneyMeaning | "balance"; re: RegExp }> = [
  { meaning: "contract_annual_value", re: /\b(contract|contracted|annual value|plan value|acv|agreement value|subscription value)\b/ },
  { meaning: "lifetime_value", re: /\b(ltv|lifetime|clv)\b/ },
  { meaning: "forecast_value", re: /\b(forecast|projected|projection|estimate|estimated|expected|pipeline)\b/ },
  { meaning: "recognized_revenue", re: /\b(recognized|recognised|earned revenue|gaap)\b/ },
  { meaning: "balance", re: /\b(balance|due|outstanding|owed|receivable)\b/ },
  { meaning: "invoice_total", re: /\b(invoice|ticket|billed|bill|subtotal|charge total|invoiced)\b/ },
  { meaning: "gross_sales", re: /\b(gross|sales|booked|bookings)\b/ },
  { meaning: "refund_adjusted_cash", re: /\b(net revenue|net cash|net of refunds)\b/ },
  { meaning: "collected_payment", re: /\b(paid|payment amount|amount paid|collected|received|applied|net paid|payment)\b/ },
  { meaning: "ad_cost", re: /\b(cost|spend|spent|ad spend|amount spent|charged)\b/ },
];

/** The business meaning a money header states, or "unknown" ("Total", "Amount", "Value"). */
export function moneyMeaningOf(header: string): MoneyMeaning | "balance" | "unknown" {
  const h = normalizeHeader(header);
  if (/\bbudget\b/.test(h)) return "forecast_value";
  for (const { meaning, re } of MONEY_VOCABULARY) if (re.test(h)) return meaning;
  return "unknown";
}

// ── Value compatibility ───────────────────────────────────────────────────────

const COMPAT: Record<FieldKind, Partial<Record<ValueKind, number>>> = {
  identifier: { integer: 1, text: 0.7, scientific: 0, zip: 0.5, phone: 0.2 },
  datetime: { datetime_offset: 1, datetime_local: 1, date_us: 0.9, date_ambiguous: 0.8, date_iso: 0.6 },
  date: { date_iso: 1, date_us: 0.9, date_ambiguous: 0.8, datetime_local: 0.6, datetime_offset: 0.5 },
  phone: { phone: 1, integer: 0.3 },
  email: { email: 1 },
  zip: { zip: 1, integer: 0.4 },
  money: { decimal: 1, money_text: 1, integer: 0.8 },
  integer: { integer: 1, decimal: 0.3 },
  enum: { text: 1, integer: 0.6, boolean: 0.6 },
  text: { text: 1, integer: 0.6, decimal: 0.4, zip: 0.3 },
  branch: { text: 0.8, integer: 0.8, zip: 0.3 },
};

function valueFit(field: TargetField, col: ColumnProfile, branchShare: number): { fit: number; note: string } {
  if (col.inferred === "empty") return { fit: 0, note: "the column is empty" };
  if (field.kind === "branch") {
    if (branchShare >= 0.5) return { fit: 1, note: `${Math.round(branchShare * 100)}% of values name a known branch` };
    if (branchShare > 0) return { fit: 0.6, note: `only ${Math.round(branchShare * 100)}% of values name a known branch` };
    return { fit: col.distinct <= 60 ? 0.4 : 0.1, note: "no value names a known branch" };
  }
  // Right column, damaged values: the mapping can be right while those rows are quarantined.
  if (field.kind === "identifier" && col.scientificIds > 0) return { fit: 0.7, note: `${col.scientificIds} value(s) are in scientific notation: a spreadsheet rounded them, and those rows will be quarantined` };
  // Five-digit serials (46327) are shaped like ZIP codes, so both kinds are checked.
  if ((field.kind === "date" || field.kind === "datetime") && (col.inferred === "integer" || col.inferred === "zip") && col.numeric && col.numeric.min >= 20_000 && col.numeric.max <= 80_000) {
    return { fit: 0.6, note: "values look like spreadsheet date serial numbers; rows will be quarantined until the column is exported as dates" };
  }
  if (field.kind === "enum" && col.distinct > 40) return { fit: 0.2, note: `${col.distinct} distinct values is too many for a status or type` };
  const fit = COMPAT[field.kind][col.inferred] ?? 0;
  return { fit, note: fit >= 0.8 ? `values look like ${label(col.inferred)}` : fit > 0 ? `values are ${label(col.inferred)}, a weak fit for ${field.kind}` : `values are ${label(col.inferred)}, not ${field.kind}` };
}

const label = (k: ValueKind) => k.replace(/_/g, " ");

// ── Suggestion ────────────────────────────────────────────────────────────────

interface Candidate {
  column: ColumnProfile;
  score: number;
  name: number;
  fit: number;
  evidence: string[];
  blocked: string | null;
}

const SUGGEST_AT = 0.55;
const TIE_MARGIN = 0.08;

function isSuspiciousHeader(header: string): boolean {
  return header.length > 60 || scanForInstructions("header", header).length > 0;
}

/** What the rows say, computed once per suggestion run. */
interface ValueEvidence {
  rows: Array<Array<string | null>> | null;
  branchShares: Map<number, number>;
  bestBranchShare: number;
}

/** Share of a column's values that translate to the field's canonical values, and a few that do not. */
function enumFit(dataset: DatasetId, field: TargetField, col: ColumnProfile, rows: Array<Array<string | null>>): { share: number; unmatched: string[] } {
  const values = rows.map((r) => r[col.index]).filter((v): v is string => v !== null && v.trim() !== "");
  if (values.length === 0) return { share: 0, unmatched: [] };
  const unmatched = values.filter((v) => proposeValue(dataset, field, v) === null);
  return { share: 1 - unmatched.length / values.length, unmatched: [...new Set(unmatched)].slice(0, 3) };
}

function candidatesFor(field: TargetField, profile: TableProfile, ev: ValueEvidence, suspicious: Set<string>, dataset: DatasetId): Candidate[] {
  const out: Candidate[] = [];
  for (const col of profile.columns) {
    const evidence: string[] = [];
    const ns = suspicious.has(col.name) ? { score: 0, synonym: null } : nameScore(col.name, field);
    const share = ev.branchShares.get(col.index) ?? 0;
    const { fit, note } = valueFit(field, col, share);
    let blocked: string | null = null;
    // An enum's values must fit, not just its name: a "Status" of Open/Paid is an invoice
    // status, and Active/Cancelled a customer status, not a payment status.
    if (field.kind === "enum" && ev.rows && ns.score >= 0.5) {
      const e = enumFit(dataset, field, col, ev.rows);
      if (e.share < 0.6) blocked = `values of "${col.name}" (${e.unmatched.map((v) => `"${v.slice(0, 20)}"`).join(", ")}) are not ${field.label.toLowerCase()} values`;
    }
    // A branch column's values name branches. A name match whose values do not, beside a
    // column whose values do, is the wrong column ("Account" vs "Routed To").
    if (field.kind === "branch" && ev.rows && share < 0.5 && ev.bestBranchShare >= 0.9) {
      blocked = `values of "${col.name}" name no known branch, while another column's do`;
    }
    if (ns.synonym) evidence.push(ns.score === 1 ? `header "${col.name}" is a known name for ${field.label}` : `header "${col.name}" resembles "${ns.synonym}"`);
    evidence.push(note);
    if (field.kind === "money" && field.moneyMeaning) {
      const meaning = moneyMeaningOf(col.name);
      if (meaning !== "unknown" && meaning !== field.moneyMeaning) {
        blocked = meaning === "balance" ? `"${col.name}" is an amount owed, not ${MONEY_MEANINGS[field.moneyMeaning].toLowerCase()}` : `"${col.name}" reads as ${MONEY_MEANINGS[meaning].toLowerCase()}, not ${MONEY_MEANINGS[field.moneyMeaning].toLowerCase()}`;
      }
    }
    if (field.kind === "phone" && field.key === "caller_phone" && /\btracking\b|\bdialed\b|\bto number\b/.test(normalizeHeader(col.name))) blocked = `"${col.name}" is the number that was dialed, not the caller`;
    if (field.kind === "datetime" && /\b(since|added|created|signup|birth|dob|scheduled|due)\b/.test(normalizeHeader(col.name)) && !ns.synonym?.match(/created/)) {
      if (field.key === "paid_at" || field.key === "started_at") blocked = `"${col.name}" records a different event`;
    }
    // Weight name evidence most; values decide between similar names and veto impossible ones.
    let score = fit === 0 ? 0 : ns.score * 0.7 + fit * 0.3;
    // Values alone are evidence only for kinds that cannot be mistaken (an email is an email).
    if (ns.score < 0.5) score = distinctiveKind(field.kind) && fit >= 0.9 ? 0.6 * fit : 0;
    if (dataset === "crm_payments" && field.key === "customer_id" && /\baccount\b/.test(normalizeHeader(col.name))) score *= 0.9;
    if (score > 0 || blocked) out.push({ column: col, score: Math.round(score * 100) / 100, name: ns.score, fit, evidence, blocked });
  }
  return out.sort((a, b) => b.score - a.score);
}

/** Kinds whose values alone are strong evidence (an email column is an email column). */
const distinctiveKind = (k: FieldKind) => k === "email" || k === "branch" || k === "zip";

function confidence(score: number): FieldSuggestion["confidence"] {
  return score >= 0.85 ? "high" : score >= 0.7 ? "medium" : "low";
}

export function suggestMappings(profile: TableProfile, opts: { dataset?: DatasetId | null; rows?: Array<Array<string | null>>; approved?: ApprovedMappingHint | null } = {}): AssistantResult {
  const suspicious = new Set(profile.columns.filter((c) => isSuspiciousHeader(c.name)).map((c) => c.name));
  const branchShares = new Map<number, number>();
  if (opts.rows) {
    for (const col of profile.columns) {
      const report = branchValueReport(opts.rows.map((r) => r[col.index]));
      const total = report.reduce((s, r) => s + r.rows, 0);
      branchShares.set(col.index, total === 0 ? 0 : report.filter((r) => r.match).reduce((s, r) => s + r.rows, 0) / total);
    }
  }
  const ev: ValueEvidence = { rows: opts.rows ?? null, branchShares, bestBranchShare: Math.max(0, ...branchShares.values()) };
  const warnings: string[] = [];
  if (suspicious.size > 0) warnings.push(`${suspicious.size} header(s) contain instruction-like text; they were treated as data and not used as evidence`);

  const dataset = opts.dataset ? { chosen: opts.dataset, abstained: false, reason: "Chosen by the user", scores: [] } : detectDataset(profile, ev, suspicious);
  if (!dataset.chosen) return { engine: ASSISTANT_VERSION, dataset, fields: [], suspiciousHeaders: [...suspicious], warnings };
  const target = DATASETS[dataset.chosen];

  const perField = target.fields.map((field) => ({ field, candidates: candidatesFor(field, profile, ev, suspicious, target.id) }));
  // Resolve one column per field: strongest claim first. A column already taken by a stronger
  // claim is removed from weaker fields' candidates (it stays visible as an alternative).
  const claims = perField
    .flatMap(({ field, candidates }) => candidates.filter((c) => !c.blocked && c.score >= SUGGEST_AT).map((c) => ({ field: field.key, column: c.column.name, score: c.score })))
    .sort((a, b) => b.score - a.score);
  const taken = new Map<string, string>(); // column -> field
  const assigned = new Map<string, string>(); // field -> column
  for (const c of claims) {
    if (assigned.has(c.field) || taken.has(c.column)) continue;
    assigned.set(c.field, c.column);
    taken.set(c.column, c.field);
  }

  const fields: FieldSuggestion[] = perField.map(({ field, candidates }) => {
    const usable = candidates.filter((c) => !c.blocked && c.score >= SUGGEST_AT);
    const alternatives: Alternative[] = candidates
      .filter((c) => c.column.name !== assigned.get(field.key))
      .slice(0, 4)
      .map((c) => ({ column: c.column.name, score: c.score, reason: c.blocked ?? (taken.has(c.column.name) && taken.get(c.column.name) !== field.key ? `better fits ${DATASETS[target.id].fields.find((f) => f.key === taken.get(c.column.name))?.label}` : c.evidence.join("; ")) }));
    const base = { field: field.key, label: field.label, required: field.required, requiresConfirmation: true as const, alternatives };
    const abstainReasons: string[] = [];
    const chosen = assigned.get(field.key);
    const top = usable.find((c) => c.column.name === chosen);

    const hinted = opts.approved?.fields[field.key];
    if (hinted !== undefined && opts.approved) {
      const exists = hinted === null || profile.columns.some((c) => c.name === hinted);
      if (exists) {
        return {
          ...base,
          status: hinted === null ? "unmapped" : "suggested",
          column: hinted,
          confidence: hinted === null ? null : "high",
          score: 1,
          evidence: [`approved mapping v${opts.approved.version} (approved by ${opts.approved.approvedBy}) used this ${hinted === null ? "absence" : `column for ${field.label}`}`],
          abstainReasons,
        };
      }
    }

    for (const c of candidates.filter((x) => x.blocked && x.name >= 0.3)) abstainReasons.push(c.blocked!);
    if (!top) {
      if (usable.length > 0) abstainReasons.push(`the best fitting column is a better match for another field`);
      if (field.required) abstainReasons.push(`no column clearly holds ${field.label.toLowerCase()}`);
      return { ...base, status: abstainReasons.some((r) => candidates.some((c) => c.blocked === r)) && field.required ? "blocked" : "unmapped", column: null, confidence: null, score: 0, evidence: [], abstainReasons };
    }

    // A rival is another free column that fits nearly as well. A column another field claimed
    // more strongly is not a rival: it has a better home.
    const rival = usable.find((c) => c !== top && (taken.get(c.column.name) ?? field.key) === field.key);
    if (rival && top.score - rival.score < TIE_MARGIN) {
      abstainReasons.push(`"${top.column.name}" and "${rival.column.name}" fit ${field.label.toLowerCase()} about equally well; choose one`);
      return { ...base, status: "ambiguous", column: null, confidence: null, score: top.score, evidence: top.evidence, abstainReasons };
    }
    // Numbered copies of one header cannot be told apart by their names, whatever the scores say.
    const sibling = profile.columns.find((c) => areSiblings(top.column.name, c.name) && (taken.get(c.name) ?? field.key) === field.key && (COMPAT[field.kind][c.inferred] ?? 0) > 0);
    if (sibling) {
      abstainReasons.push(`"${top.column.name}" and "${sibling.name}" are copies of one header; which is ${field.label.toLowerCase()} must be chosen`);
      return { ...base, status: "ambiguous", column: null, confidence: null, score: top.score, evidence: top.evidence, abstainReasons };
    }
    const free = (c: ColumnProfile) => c.index !== top.column.index && (taken.get(c.name) ?? field.key) === field.key;
    // Two columns whose values both name branches ("Location" and "Territory") may disagree
    // row by row; which one is the branch of record is a person's call.
    if (field.kind === "branch") {
      const other = profile.columns.find((c) => free(c) && (ev.branchShares.get(c.index) ?? 0) >= 0.9);
      if (other) {
        abstainReasons.push(`"${top.column.name}" and "${other.name}" both name branches; choose the one that is the branch of record`);
        return { ...base, status: "ambiguous", column: null, confidence: null, score: top.score, evidence: top.evidence, abstainReasons };
      }
    }
    // Two id-shaped columns that both speak of this field's entity ("ID" and "Lead Ref",
    // "Account #" and "Cust Ref") are two candidate keys; the wrong one breaks de-duplication.
    if (field.kind === "identifier") {
      const own = distinctiveTokens(field);
      // Id-shaped, not unique: a customer id repeats once per payment, so uniqueness is no test.
      const idShaped = (c: ColumnProfile) => (c.inferred === "integer" || c.inferred === "text") && c.personal === null && c.maxLength <= 40 && c.shapes.some((s) => s.shape.includes("#"));
      const other = profile.columns.find((c) => free(c) && idShaped(c) && [...tokens(c.name)].some((t) => own.has(t)));
      if (other) {
        abstainReasons.push(`"${top.column.name}" and "${other.name}" are both ids of this record type; choose the one the source system uses`);
        return { ...base, status: "ambiguous", column: null, confidence: null, score: top.score, evidence: top.evidence, abstainReasons };
      }
    }

    let money: FieldSuggestion["money"];
    if (field.kind === "money" && field.moneyMeaning) {
      const detected = moneyMeaningOf(top.column.name);
      const detectedMeaning = detected === "balance" ? "unknown" : detected;
      money = { required: field.moneyMeaning, detected: detectedMeaning, column: top.column.name };
      // "Amount" in a file that is clearly about payments reads as the payment amount; "Total"
      // never does. A file that speaks of invoices or balances and never of payments is an
      // invoice list, where "Amount" is what was billed.
      const headers = profile.columns.map((c) => normalizeHeader(c.name)).join(" | ");
      const invoiceContext = /\b(invoice|balance|due|billed)\b/.test(headers) && !/\b(payment|paid|receipt|transaction|collected)\b/.test(headers);
      const contextual = detected === "unknown" && !invoiceContext && field.moneyMeaning === "collected_payment" && /^(amount|payment)$/.test(normalizeHeader(top.column.name));
      const contextualCost = detected === "unknown" && field.moneyMeaning === "ad_cost" && /^(amount|cost usd|spend usd)$/.test(normalizeHeader(top.column.name));
      if (detected === "unknown" && !contextual && !contextualCost) {
        abstainReasons.push(`"${top.column.name}" does not say what kind of money it is. Confirm it is ${MONEY_MEANINGS[field.moneyMeaning].toLowerCase()} before it is used`);
        return { ...base, status: "ambiguous", column: null, confidence: null, score: top.score, evidence: top.evidence, abstainReasons, money };
      }
    }
    return { ...base, status: "suggested", column: top.column.name, confidence: confidence(top.score), score: top.score, evidence: top.evidence, abstainReasons, money };
  });

  return { engine: ASSISTANT_VERSION, dataset, fields, suspiciousHeaders: [...suspicious], warnings };
}

const RECORD_TYPES: Array<{ type: string; re: RegExp }> = [
  { type: "payment", re: /^(payment|refund|receipt)s?$/i },
  { type: "invoice", re: /^(invoice|ticket|bill)s?$/i },
  { type: "call", re: /^calls?$/i },
  { type: "lead", re: /^(lead|form|submission)s?$/i },
  { type: "appointment", re: /^(appointment|service|visit)s?$/i },
];

/** A column whose values name two kinds of record means one file holds two datasets. */
function mixedRecordTypes(profile: TableProfile): string | null {
  for (const col of profile.columns) {
    const types = new Set((col.topValues ?? []).flatMap((v) => RECORD_TYPES.filter((t) => t.re.test(v.value.trim())).map((t) => t.type)));
    if (types.size >= 2) return `"${col.name}" mixes ${[...types].join(" and ")} records in one file; split the file by record type before importing`;
  }
  return null;
}

/** Which dataset the file most likely is: coverage of required fields, with a margin to the runner-up. */
export function detectDataset(profile: TableProfile, ev: ValueEvidence, suspicious: Set<string>): DatasetGuess {
  const scores = DATASET_IDS.map((id) => {
    const required = DATASETS[id].fields.filter((f) => f.required);
    const used = new Set<string>();
    let sum = 0;
    for (const f of required) {
      const best = candidatesFor(f, profile, ev, suspicious, id).find((c) => !c.blocked && !used.has(c.column.name) && c.name >= 0.5);
      if (best) {
        used.add(best.column.name);
        sum += best.score;
      }
    }
    return { dataset: id, coverage: Math.round((sum / required.length) * 100) / 100 };
  }).sort((a, b) => b.coverage - a.coverage);
  const [first, second] = scores;
  const mixed = mixedRecordTypes(profile);
  if (mixed) return { chosen: null, abstained: true, reason: mixed, scores };
  if (first.coverage < 0.6) return { chosen: null, abstained: true, reason: `No dataset fits: the best match (${DATASETS[first.dataset].label}) covers only ${Math.round(first.coverage * 100)}% of its required fields`, scores };
  if (second && first.coverage - second.coverage < 0.15) {
    return { chosen: null, abstained: true, reason: `The file fits ${DATASETS[first.dataset].label} and ${DATASETS[second.dataset].label} about equally; choose the dataset`, scores };
  }
  return { chosen: first.dataset, abstained: false, reason: `${DATASETS[first.dataset].label}: ${Math.round(first.coverage * 100)}% of required fields found`, scores };
}
