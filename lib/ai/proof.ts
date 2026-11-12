/**
 * Proof-carrying claims: does a statement FOLLOW from the facts it cites, not merely mention
 * their numbers?
 *
 * A statement is cut into pieces (sentences, ";", and clauses joined by "while", "but"…). In
 * each piece the checker finds, for every figure: the metric it is about (from a fixed
 * vocabulary of the product's own definitions, chosen by the noun next to the figure or the
 * nearest metric word), the entity (a branch, a group of branches or a brand, a channel or a
 * campaign), the period (or both months together), whether the piece states a level or a change
 * (against another period, branch or channel), the direction word, and any qualifier ("about",
 * "more than"). Each figure becomes a proposition with an explicit proof against the typed facts
 * the claim CITES (lib/ai/facts.ts):
 *
 *   level      "B09's October paid CAC is $241.29"            v(paidCac, B09, oct) = $241.29
 *   change     "...decreased by $20,000 from September"       v(oct) − v(sep), size and sign
 *   relative   "...rose 12% from September"                   |v(oct) − v(sep)| ÷ |v(sep)|
 *   from→to    "...from $120,000 to $100,000"                 v(sep), v(oct), and the direction
 *   versus     "...higher than B12's $200"                    v(B09) − v(B12), and B12's level
 *   ratio      "...twice its September CAC"                   v(oct) ÷ v(sep) = 2
 *   sum        "B41 and B42 spent $1,500" · "Joshua's spent…" Σ over the branches (all must be cited)
 *   share      "Microsoft Ads was 20% of B37's spend"          v(channel) ÷ v(branch)
 *   direction  "October revenue increased" (no figure)        sign of v(oct) − v(sep)
 *   arithmetic "$4,825.80 ÷ 20 = $241.29"                     the arithmetic, and where the operands come from
 *   status     "Google Search is decision-ready" · "its payment records are complete"
 *              readiness and feed freshness from the tools (freshness from every tool call of the
 *              run: a stale feed anywhere is counterevidence to a completeness claim)
 *   membership "B41 … is Mission brand spend"                 the branch's brand
 *
 * Verdicts: VERIFIED (the proposition follows), CONTRADICTED (the fact exists and says
 * otherwise: wrong value, sign, arithmetic, unit, brand or status), UNRESOLVED (with a gap: the
 * cited facts do not hold this metric for this entity and period, the currency is not
 * established, the measure is not one the product verifies, the tools disagree, or the
 * statement cannot be read). A number that merely appears somewhere is never a proof.
 *
 * Deterministic, outside the model. It does not understand every sentence: what it cannot read
 * stays UNRESOLVED, and `judge` decides what that means for the claim.
 */
import { PERIODS, type PeriodKey } from "@/lib/period";
import { BRANCHES, BRANCH_BY_ID, BRANDS } from "@/lib/reference";
import { METRIC_NAME, METRIC_UNIT, type MetricFact, type MetricKey, type StatusFacts, type Unit } from "./facts";
import { claimNumbers, maskQuoted, type ClaimNumber } from "./numbers";

export type Verdict = "VERIFIED" | "CONTRADICTED" | "UNRESOLVED";

/** Why a proposition is UNRESOLVED. */
export type Gap =
  /** No metric named for the figure, or a count of something that is not a metric (campaigns, days). */
  | "metric_unknown"
  /** A measure the product does not verify from these facts: invoiced or billed amounts, payment counts. */
  | "metric_unsupported"
  /** The cited evidence holds no value of this metric for this branch, channel or campaign. */
  | "fact_missing"
  /** ...holds it, but not for the stated period. */
  | "period_missing"
  /** No period stated and the cited facts cover more than one. */
  | "period_ambiguous"
  /** A change or comparison whose other side is not in the cited evidence. */
  | "comparison_missing"
  /** Some of the money came from a feed that did not state its currency, with no authorized rule. */
  | "currency_unresolved"
  /** The metric has no value (CAC with no paid customers, a change from zero). */
  | "undefined_value"
  /** An arithmetic operand that is not one of the cited facts. */
  | "operand_missing"
  /** The cited tools give different values for the same metric, entity and period. */
  | "conflicting_facts"
  /** A judgement (more effective, better) that no metric measures. */
  | "evaluative"
  /** An absence ("has not paid") while the feed that would show it is stale. */
  | "evidence_stale"
  /** The statement can be read more than one way (a percent change of a share). */
  | "ambiguous"
  /** Conditional or forward-looking: not a fact the evidence can prove. */
  | "hypothetical"
  /**
   * Model text that says something the checker does not read: a negation, a verb of change or
   * rank it does not know, a period, branch, channel, campaign or customer it cannot place, a
   * figure in a form it does not parse, a second measure no proposition covers, or a qualifier
   * that changes the metric. What was not read was not proved (see `closedReading`).
   */
  | "unread"
  /**
   * Model text that states no figure, measure or direction at all (an event, a mapping change,
   * an explanation): nothing to contradict, nothing proved. Shown as a hypothesis, never as a
   * finding, because the model is never the only verifier.
   */
  | "unproved";

export interface ProofInput {
  metric: MetricKey;
  entity: string;
  period: PeriodKey;
  value: number | null;
  unit: Unit;
  definitionVersion: string | null;
  currencyResolved: boolean;
  /** Why the fact, correct as stored, leaves records out (e.g. spend held at intake), or null: its completeness. */
  incompleteReason: string | null;
  evidenceIds: string[];
  tool: string;
}

/** "almost", "nearly", "just under": close to the figure and not above it. */
export type Qualifier = "exact" | "approximately" | "almost" | "more_than" | "at_least" | "less_than" | "at_most";

/** "record": a template's figure equals the field of a returned record it renders (lib/ai/rendered.ts). */
export type Relation = "level" | "change" | "relative_change" | "points_change" | "direction" | "ratio" | "sum" | "share" | "arithmetic" | "membership" | "status" | "record" | "unknown";

export interface Proof {
  piece: string;
  /** The figure as written; empty for a proposition without one (a direction, a status). */
  figure: string;
  subject: { metric: MetricKey | null; entity: string | null; period: PeriodKey | null };
  /** The other side of a change or comparison. */
  against: { entity: string; period: PeriodKey } | null;
  relation: Relation;
  /** The calculation: "v(paidCac, B09, oct) − v(paidCac, B09, sep)". */
  formula: string;
  inputs: ProofInput[];
  unit: Unit | null;
  /** The value the facts give, in the claim's terms: dollars, a count, or percent. */
  computed: number | null;
  /** The value the claim states, signed. */
  claimed: number | null;
  qualifier: Qualifier;
  direction: "increase" | "decrease" | "unchanged" | null;
  claimedDirection: "increase" | "decrease" | null;
  /** Decimal places the claim asserts (negative: rounded to tens, thousands…). */
  precision: number;
  rounding: string;
  verdict: Verdict;
  gap: Gap | null;
  reason: string;
}

export interface ProveContext {
  /** The investigation's branch, used when a statement names none. */
  branchId: string | null;
  /** Only the facts the claim cites. */
  facts: MetricFact[];
  /** Readiness and freshness from every tool call of the run (counterevidence counts wherever it came from). */
  status?: StatusFacts;
  /**
   * Who wrote it. Model text is held to a closed reading: whatever the checker did not read is an
   * "unread" gap. Template text is the product's own, written in the checker's vocabulary.
   */
  origin: ProofOrigin;
}

// ── Vocabulary ───────────────────────────────────────────────────────────────

/** "portion": "$1,800 of its spend", a part of a metric, not (necessarily) its level. */
type Family = "cac" | "unknown" | "paidCustomers" | "customers" | "spend" | "collected" | "newCollected" | "refunds" | "gross" | "payments" | "atRisk" | "prospects" | "unsupported" | "portion" | "none";
type EntityType = "branch" | "campaign" | "channel";
interface EntityRef { type: EntityType; id: string }

/** Metric words, in priority order: an earlier pattern wins where two overlap. */
const FAMILY_WORDS: Array<[RegExp, Family]> = [
  [/\b(?:paid[- ](?:media )?)?CAC\b|\bcost per (?:new |paying |paid |acquired )*customers?\b|\bcustomer acquisition cost\b|\bcost per acquisition\b|\bspend per (?:new |paid |paying )*customers?\b/gi, "cac"],
  [/\b(?:invoic\w*|billed|billings?|gross sales|contract(?:ed)? value|booked|bookings|pipeline value|quoted)\b/gi, "unsupported"],
  [/\b(?:revenue |cash |money )?(?:at[- ]risk|in open exceptions|tied up in (?:open )?exceptions)(?: revenue| cash)?/gi, "atRisk"],
  [/\b(?:collected|collections?|cash|revenue) from (?:its |the )?(?:period's |october's |september's )?new customers\b|\bnew[- ]customer (?:collections?|revenue|cash)\b/gi, "newCollected"],
  [/\b(?:refund[- ]adjusted|net) (?:collections|collected|cash|revenue)\b|\bnet of refunds\b|\bafter refunds\b/gi, "collected"],
  [/\bgross (?:payments|collections|collected|cash)\b|\bbefore refunds\b/gi, "gross"],
  [/\brefund\w*/gi, "refunds"],
  [/\bpayments?\b/gi, "payments"],
  [/\bcollect\w*|\bcash\b|\brevenue\b/gi, "collected"],
  [/\b(?:unattributed|unknown(?:-channel)?) (?:share|customers)\b|\bchannel (?:is |was )?unknown\b|\bno (?:evidenced |known )?channel\b|\bunattributed\b/gi, "unknown"],
  [/\b(?:new )?(?:paid|paying)(?:[- ]media)? (?:new )?(?:customers|acquisitions)\b|\bpaid[- ]channel customers\b/gi, "paidCustomers"],
  [/\bnew customers\b|\bcustomers serviced\b|\bacquisitions\b|\bcustomers\b/gi, "customers"],
  [/\b(?:unique )?prospects\b/gi, "prospects"],
  [/\b(?:(?:paid|media|ad|advertising|marketing) )*spend(?:ing)?\b|\bspent\b|\bad costs?\b/gi, "spend"],
];

/**
 * The noun right after a count (past up to three adjectives: "18 stored spend records") decides
 * what it counts. In a compound the last noun counts: "160 payment records" are records.
 */
const COUNTED = /^\s+((?:[A-Za-z][\w-]*\s+){0,3}?)(customers?|prospects?|payments?|refunds?|acquisitions?|leads?|campaigns?|calls?|records?|exceptions?|days?|feeds?|channels?|samples?|runs?|branch(?:es)?|rows?|events?|items?|mappings?|versions?|hours?|minutes?|weeks?|months?|ids?|changes?|cases?|proposals?)\b(?!\s+(?:records?|rows?|events?|ids?|items?|samples?)\b)/i;

/** A metric word further than this from a figure does not name it. */
const MAX_METRIC_DISTANCE = 60;

function resolve(family: Family, kind: ClaimNumber["kind"] | null, entity: EntityType): MetricKey | "unsupported" | null {
  if (entity === "channel") {
    // A channel's figures: its spend, its new customers, its cost per new customer.
    if (family === "spend") return "channelSpend";
    if (family === "customers" || family === "paidCustomers") return "channelAcquired";
    if (family === "cac") return "channelCac";
  }
  if (entity === "campaign" && (family === "customers" || family === "paidCustomers")) return "campaignAcquired";
  switch (family) {
    case "cac": return "paidCac";
    case "unknown": return kind === "count" ? "unknownAcquired" : "unknownShare";
    case "paidCustomers": return "paidAcquired";
    case "customers": return "acquired";
    case "spend": return entity === "campaign" ? "campaignSpend" : "paidSpend";
    case "collected": return "collected";
    case "newCollected": return "newCollected";
    case "refunds": return kind === "count" ? "unsupported" : "refunds";
    case "gross": return "grossCollected";
    case "payments": return kind === "count" ? "unsupported" : "grossCollected";
    case "atRisk": return "atRisk";
    case "prospects": return "prospects";
    case "unsupported": return "unsupported";
    case "portion":
    case "none": return null;
  }
}

// A comparative ("more paid customers in October than in September") is a direction, unless the
// "than" is followed by a figure ("more than $4,000" is a bound).
const UP = /\b(?:increas(?:e|ed|es|ing)|rose|risen|rises?|rising|grew|grown|grows?|growing|went up|(?:is|are|was|were) up|up (?:by|from)|higher|gain(?:ed|s)?|jump(?:ed|s)?|climb(?:ed|s)?|more(?=(?:\s+[\w'-]+){0,6}\s+than\s+(?![$\d−-])))/gi;
const DOWN = /\b(?:decreas(?:e|ed|es|ing)|fell|fallen|falls?|falling|dropp(?:ed|ing)|drops?|declin(?:e|ed|es|ing)|went down|(?:is|are|was|were) down|down (?:by|from)|lower|lost|loses?|shrank|shrunk|reduced|(?:less|fewer)(?=(?:\s+[\w'-]+){0,6}\s+than\s+(?![$\d−-])))/gi;
/** Forward-looking or conditional wording: a projection, not an observation. */
const MODAL = /\b(?:would|could|should|might|will|if|unless|expected to|projected|projection|forecasts?|targets?)\b/i;
/** A judgement that no metric measures. */
const EVALUATIVE = /\b(?:more|less|most|least)\s+(?:effective|efficient|profitable|successful|valuable|productive)\b|\b(?:better|worse|best|worst)\s+(?:channel|campaign|branch|performer|investment|choice)\b|\b(?:outperform\w*|underperform\w*)\b/i;
const SUPERLATIVE = /\b(lowest|highest|cheapest|most expensive|largest|smallest)\b[^.;]{0,60}?\b(?:in the company|of (?:all|any) (?:the )?branch(?:es)?|across (?:all )?(?:the )?branches|company[- ]wide|of all)\b/i;
const MULTIPLE = /\b(twice|doubled|double|tripled|triple|quadrupled|halved|half|(\d+(?:\.\d+)?|two|three|four|five|ten)\s+times)\b/i;
/** "half of B10's", "twice B12's": a multiple of another branch's value. */
const MULTIPLE_OF = /\b(?:twice|double|triple|half|(?:\d+(?:\.\d+)?|two|three|four|five|ten)\s+times)\s+(?:of\s+|that of\s+|as (?:much|high|large) as\s+)?(B\d{2})\b/i;
/** The factor a multiple word states. */
const factorOf = (m: RegExpExecArray): number =>
  /^twice|^double/i.test(m[1]) ? 2 : /^tripl/i.test(m[1]) ? 3 : /^quadrupl/i.test(m[1]) ? 4 : /^hal[fv]/i.test(m[1]) ? 0.5 : NUMBER_WORDS[(m[2] ?? "").toLowerCase()] ?? Number(m[2]);

const MONTH_WORD = String.raw`september|sept|sep|october|oct|this month|current month|last month|previous month|prior month`;
const MONTHS = new RegExp(String.raw`\b(?:${MONTH_WORD})\b`, "gi");
const PER_CMP = new RegExp(String.raw`\b(?:compared (?:with|to)|from|than|vs\.?|versus|since|over|relative to)\s+(?:(?:in|for)\s+)?(?:the\s+)?(?:month of\s+)?(${MONTH_WORD})\b`, "i");
const ENT_CMP = /\b(?:than|vs\.?|versus|compared (?:with|to)|relative to)\s+(B\d{2})\b/i;
/** "across September and October together", "both months": the two months as one period. */
const BOTH_MONTHS = /\b(?:(?:across|over|for|in|during)\s+(?:both\s+)?(?:september|sept?)\s+and\s+(?:october|oct)(?:\s+(?:together|combined))?|(?:september|sept?)\s+and\s+(?:october|oct)\s+(?:together|combined)|both months|(?:september|sept?)\s*[–-]\s*(?:october|oct)|over the two months)\b/i;
const periodOf = (word: string): PeriodKey => (/^(?:oct|this|current)/i.test(word) ? "oct" : "sep");
const other = (p: PeriodKey): PeriodKey => (p === "oct" ? "sep" : "oct");

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** How text names a channel, besides its label. */
const CHANNEL_ALIASES: Record<string, string[]> = {
  google_lsa: ["Google Local Services", "Local Services Ads", "Local Services", "LSA"],
  google_search: ["Google Search", "Google Ads search", "Search ads", "paid search"],
  microsoft: ["Microsoft Advertising", "Microsoft Ads", "Microsoft", "Bing Ads", "Bing"],
  meta: ["Meta Ads", "Meta", "Facebook Ads", "Facebook", "Instagram"],
  organic_gbp: ["Google Business Profile", "GBP"],
};

const BRAND_PATTERNS = BRANDS.map((b) => {
  const first = b.name.split(" ")[0].replace(/'s$/, "");
  // Case-sensitive: a brand is a proper noun ("our mission" is not the Mission brand).
  return { id: b.id, re: new RegExp(String.raw`\b${escapeRe(first)}(?:'?s)?(?:\s+Pest Control)?\b`), name: b.name };
});
const branchesOfBrand = (brandId: string) => BRANCHES.filter((b) => b.brandId === brandId).map((b) => b.id);

const NUMBER_WORDS: Record<string, number> = { zero: 0, one: 1, two: 2, three: 3, four: 4, five: 5, six: 6, seven: 7, eight: 8, nine: 9, ten: 10, eleven: 11, twelve: 12 };

// ── Figures ──────────────────────────────────────────────────────────────────

interface Fig {
  text: string;
  kind: ClaimNumber["kind"];
  /** Signed value in the claim's terms (dollars, count, percent). */
  value: number;
  precision: number;
  start: number;
  end: number;
  /** "nothing", "no": zero in whatever unit the metric has. */
  anyUnit?: boolean;
}

const MONTH_NAMES = "jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec|january|february|march|april|june|july|august|september|october|november|december";
const blank = (m: string) => " ".repeat(m.length);

/**
 * The piece with what is not a quantity blanked out, positions kept: dates ("Oct 1–30"), years,
 * times, ids and versions. A count is located here, so "1" in "Oct 1–30 … across 1 campaign(s)"
 * is the campaign count, not the date (lib/ai/numbers.ts reads the same things as non-quantities).
 */
function maskNonQuantities(piece: string): string {
  return piece
    .replace(/\b[a-z_]+:[\w.:-]+/gi, blank)
    .replace(/\bHTTP\s+\d{3}\b/gi, blank)
    .replace(/\b[A-Za-z]+\d+[\w-]*/g, blank)
    .replace(/\b[A-Za-z][\w]*[-_][\w-]*\d[\w-]*/g, blank)
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\b/g, blank)
    .replace(/\b\d{4}-\d{2}-\d{2}(?:T[\d:.]+Z?)?\b/g, blank)
    .replace(new RegExp(String.raw`\b(?:${MONTH_NAMES})\.?\s+\d{1,2}(?:\s*[–-]\s*\d{1,2})?(?!\d)`, "gi"), blank)
    // "10 October" is a date, but "10 October paid-media customers" is a count of the month's customers.
    .replace(new RegExp(String.raw`\b\d{1,2}\s+(?:${MONTH_NAMES})\b(?!\s+(?:[A-Za-z][\w-]*\s+){0,2}?(?:customers?|payments?|refunds?|prospects?|leads?|calls?|acquisitions?)\b)`, "gi"), blank)
    .replace(/\b(?:199\d|20[0-3]\d)\b/g, blank);
}

/** The figures of a piece, with their positions and signs. Cents are read as money; number words as counts. */
function figuresOf(piece: string): Fig[] {
  const nums = claimNumbers(piece);
  // Names in quotes hold no figures (lib/ai/numbers.ts): figures are located outside them.
  const unquoted = maskQuoted(piece);
  const masked = maskNonQuantities(unquoted);
  const taken: Array<[number, number]> = [];
  const free = (s: number, e: number) => taken.every(([a, b]) => e <= a || s >= b);
  const out: Fig[] = [];
  for (const n of [...nums.filter((x) => x.kind !== "count"), ...nums.filter((x) => x.kind === "count")]) {
    const re = new RegExp(n.kind === "count" ? String.raw`(?<![\d$.,])${escapeRe(n.text)}(?![\d]|[.,]\d|\s?%)` : escapeRe(n.text), "g");
    for (const m of (n.kind === "count" ? masked : unquoted).matchAll(re)) {
      const s = m.index ?? 0;
      const e = s + m[0].length;
      if (!free(s, e)) continue;
      taken.push([s, e]);
      const before = piece.slice(0, s);
      const negative = /^[−-]/.test(n.text) && !/[\d$]\s*$/.test(before);
      let kind = n.kind;
      let value = n.value * n.scale;
      let precision = n.kind === "money" ? n.decimals - Math.log10(n.scale) : n.decimals;
      let end = e;
      const cents = /^\s*cents?\b/i.exec(piece.slice(e));
      if (kind === "count" && cents) {
        kind = "money";
        value /= 100;
        precision = 2;
        end = e + cents[0].length;
      }
      out.push({ text: piece.slice(s, end), kind, value: negative ? -value : value, precision, start: s, end });
      break;
    }
  }
  // Number words (and single digits) before a counted noun or a comparative: "one more paid
  // customer", "2 more new customers", "two customers".
  for (const m of unquoted.matchAll(/(?<![\d$.,])\b(zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|\d)\b(?![.,]\d)(?=(\s+(?:more|fewer|less|additional|extra)\b|\s+(?:[A-Za-z][\w-]*\s+){0,3}?(?:customers?|payments?|refunds?|prospects?|acquisitions?)\b))/gi)) {
    const s = m.index ?? 0;
    const e = s + m[1].length;
    if (!free(s, e) || (/\b(?:of|to)\s*$/i.test(piece.slice(0, s)) && /^\s+of\b/i.test(piece.slice(e)))) continue;
    taken.push([s, e]);
    out.push({ text: m[1], kind: "count", value: /^\d$/.test(m[1]) ? Number(m[1]) : NUMBER_WORDS[m[1].toLowerCase()], precision: 0, start: s, end: e });
  }
  // A change of a share in points: "rose 2 points", "20.6 percentage points", "3 pp". Read as
  // percent; a count reader would otherwise miss single digits and decimals, and the change would
  // be proved by its direction alone.
  for (const f of out) if (f.kind === "count" && /^\s+(?:percentage[- ])?points?\b|^\s*pp\b/i.test(piece.slice(f.end))) f.kind = "percent";
  for (const m of unquoted.matchAll(/(?<![\d$.,])(\d+(?:\.(\d+))?)(?=\s+(?:percentage[- ])?points?\b|\s*pp\b)/gi)) {
    const s = m.index ?? 0;
    const e = s + m[1].length;
    if (!free(s, e)) continue;
    taken.push([s, e]);
    const negative = /[−-]\s*$/.test(piece.slice(0, s));
    out.push({ text: m[1], kind: "percent", value: negative ? -Number(m[1]) : Number(m[1]), precision: m[2]?.length ?? 0, start: s, end: e });
  }
  // Zero words: "spent nothing", "no paid customers", "none of its spend".
  // "no" only when a metric noun follows ("no paid customers", "no paid media spend"), never "no paid touch".
  for (const m of unquoted.matchAll(/\b(none|no)\b(?=\s+(?:(?:[A-Za-z][\w-]*\s+){0,2}?)(?:spend|customers|payments|refunds|prospects|revenue|cash|collections)\b)|\b(nothing)\b/gi)) {
    const s = m.index ?? 0;
    const word = m[1] ?? m[2];
    const e = s + word.length;
    if (!free(s, e)) continue;
    taken.push([s, e]);
    out.push({ text: word, kind: "count", value: 0, precision: 0, start: s, end: e, anyUnit: true });
  }
  return out.sort((a, b) => a.start - b.start);
}

function qualifierOf(before: string): Qualifier {
  if (/\b(?:nearly|almost|just under|just shy of)\s*$/i.test(before)) return "almost";
  if (/\b(?:about|approximately|approx\.?|roughly|around|close to|some)\s*$|~\s*$/i.test(before)) return "approximately";
  if (/\bat least\s*$/i.test(before)) return "at_least";
  if (/\bat most\s*$/i.test(before)) return "at_most";
  if (/\b(?:more than|over|above|exceeding|exceed(?:s|ed)?|in excess of)\s*$/i.test(before)) return "more_than";
  if (/\b(?:less than|fewer than|under|below)\s*$/i.test(before)) return "less_than";
  return "exact";
}

const sigDigits = (x: number) => {
  const digits = String(Math.abs(Math.round(x))).replace(/0+$/, "");
  return Math.max(1, digits.length);
};

/** Whether the claimed figure holds for the actual value, at the precision and qualifier written. */
/**
 * A figure with a scale suffix ("$0.1M", "$4.8K") is rounded to that scale, but it may not be
 * off by more than this share of the actual value: "$0M" is not $100,000, however the rounding
 * is read (review 2026-11-12, AI-claims finding 18).
 */
const SCALED_RELATIVE_TOLERANCE = 0.05;

function holds(claimed: number, actual: number, precision: number, q: Qualifier): boolean {
  const eps = 1e-9;
  const scaledOk = precision >= 0 || (claimed !== 0 && Math.abs(claimed - actual) <= SCALED_RELATIVE_TOLERANCE * Math.abs(actual) + eps);
  const approximately = () => {
    if (claimed === 0) return Math.abs(actual) <= 0.5 * 10 ** -precision + eps;
    // "about $20,000": the figure rounded to at least two significant digits.
    const mag = Math.floor(Math.log10(Math.abs(claimed)));
    const sig = Math.max(2, Number.isInteger(claimed) ? sigDigits(claimed) : precision + mag + 1);
    return Math.abs(claimed - actual) <= Math.max(0.5 * 10 ** (mag - sig + 1), 0.5 * 10 ** -precision) + eps;
  };
  switch (q) {
    case "exact":
      return Math.abs(claimed - actual) <= 0.5 * 10 ** -precision + eps && scaledOk;
    case "approximately":
      return approximately() && scaledOk;
    case "almost":
      // "almost $4,800": close to it, and not more ($4,825.80 is over, so it is not "almost").
      return approximately() && scaledOk && Math.abs(actual) <= Math.abs(claimed) + eps;
    case "more_than": return actual > claimed + eps;
    case "at_least": return actual >= claimed - eps;
    case "less_than": return actual < claimed - eps;
    case "at_most": return actual <= claimed + eps;
  }
}

const ROUNDING: Record<Qualifier, string> = {
  exact: "equal at the precision written (half a unit of the last digit)",
  approximately: "\"about\": equal when rounded to two significant digits",
  almost: "\"almost\": equal when rounded to two significant digits, and not above the figure",
  more_than: "strictly greater",
  at_least: "greater or equal",
  less_than: "strictly less",
  at_most: "less or equal",
};

/** A fact's value in the claim's terms: dollars for money, the count, or percent for a ratio. */
const shown = (value: number, unit: Unit) => (unit === "usd_cents" ? value / 100 : unit === "ratio" ? value * 100 : value);
const unitWord = (u: Unit) => (u === "usd_cents" ? "dollars" : u === "ratio" ? "percent" : "a count");
const compatible = (kind: Fig["kind"], unit: Unit) => (kind === "money" && unit === "usd_cents") || (kind === "count" && unit === "count") || (kind === "percent" && unit === "ratio");
const fmt = (n: number) => (Number.isInteger(n) ? String(n) : n.toFixed(Math.min(6, Math.max(2, String(n).split(".")[1]?.length ?? 2))).replace(/0+$/, "").replace(/\.$/, ""));
/** A value in the claim's terms, in the reader's words: "$17,515.00", "12.5%", "69" (a reason once read "the cited fact is 17515"). */
const fmtIn = (unit: Unit | null, n: number) =>
  unit === "usd_cents" ? `${n < 0 ? "−" : ""}$${Math.abs(n).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}` : unit === "ratio" ? `${fmt(n)}%` : fmt(n);
const dirWord = (d: "increase" | "decrease" | "unchanged") => (d === "unchanged" ? "no change" : d === "increase" ? "an increase" : "a decrease");

// ── Pieces ───────────────────────────────────────────────────────────────────

function splitPieces(text: string): string[] {
  const raw = text.split(/;\s*|(?<=[.!?])\s+(?=[A-Z])|\s*,?\s+(?:while|whereas|but|although|though)\s+/);
  const out: string[] = [];
  // A quotation is one unit: split inside it, each half has one quote mark and its figures would
  // be read as the sentence's own (R-38: a quoted exception summary holding a ";").
  const open = (s: string) => ((s.match(/"/g)?.length ?? 0) % 2 === 1) || (s.match(/“/g)?.length ?? 0) > (s.match(/”/g)?.length ?? 0);
  for (const p of raw) {
    const last = out[out.length - 1];
    if (last !== undefined && open(last)) out[out.length - 1] += `; ${p}`;
    else if (last !== undefined && /\b(?:Oct|Sep|Sept|vs|approx|No|e\.g|i\.e)\.$/i.test(last)) out[out.length - 1] += ` ${p}`;
    else out.push(p);
  }
  return out.map((s) => s.trim()).filter(Boolean);
}

interface Mention { family: Family; start: number; end: number }

function familyMentions(piece: string): Mention[] {
  const out: Mention[] = [];
  for (const [re, family] of FAMILY_WORDS) {
    for (const m of piece.matchAll(re)) {
      const start = m.index ?? 0;
      const end = start + m[0].length;
      if (out.some((o) => start < o.end && end > o.start)) continue;
      out.push({ family, start, end });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

interface Dir { dir: "increase" | "decrease"; at: number }

function directions(piece: string): Dir[] {
  const out: Dir[] = [];
  for (const m of piece.matchAll(UP)) out.push({ dir: "increase", at: m.index ?? 0 });
  for (const m of piece.matchAll(DOWN)) out.push({ dir: "decrease", at: m.index ?? 0 });
  return out.sort((a, b) => a.at - b.at);
}

const PAID_TOUCH = /^\s*(?:whose|with|that had)\s+(?:a\s+|their\s+)?first\s+(?:evidenced\s+)?touch\s+(?:was\s+)?(?:a\s+)?paid\b/i;
/** Text right after a share: "20% of", "20% ($240.00) of". */
const SHARE_OF = /^\s*(?:\([^)]*\)\s*)?of\b/i;

/** The family a figure is about: the noun after it, else the nearest metric word. */
function familyFor(fig: Pick<Fig, "kind" | "start" | "end">, piece: string, mentions: Mention[]): Family | null {
  const after = piece.slice(fig.end);
  // "CAC divides … by all 9 new customers": the count after "by" is the CAC's denominator,
  // whatever noun the sentence uses for it.
  if (fig.kind === "count" && mentions.some((m) => m.family === "cac") && /\b(?:divid\w*|÷)(?:[^.;]|\.(?=\d)){0,60}\bby\s+(?:all\s+(?:of\s+)?|its\s+|the\s+|only\s+|just\s+)?$/i.test(piece.slice(0, fig.start))) return "paidCustomers";
  // "8 of 8 new customers have channel unknown": the first count is the part the predicate names.
  const partOf = fig.kind === "count" ? /^\s+of\s+\d[\d,]*\s+/.exec(after) : null;
  if (partOf) {
    const predicate = mentions.find((m) => m.start >= fig.end + partOf[0].length && m.family === "unknown");
    if (predicate) return "unknown";
    if (PAID_TOUCH.test(after.slice(partOf[0].length).replace(/^(?:[A-Za-z-]+\s+){0,3}?customers?/i, ""))) return "paidCustomers";
    return "portion";
  }
  // "146 new customers serviced (69 paid)", "(3 unknown)": a count qualified by one word.
  if (fig.kind === "count" && mentions.some((m) => m.family === "customers" || m.family === "paidCustomers") && /^\s+(?:paid|paying)\b(?!\s+(?:media|spend|search|ads?)\b)/i.test(after)) return "paidCustomers";
  if (fig.kind === "count" && mentions.some((m) => m.family === "customers") && /^\s+(?:unknown|unattributed)\b/i.test(after)) return "unknown";
  // "$18,551.00 paid − $312.00 refunded": money named by its verb.
  if (fig.kind === "money" && /^\s+(?:paid|in payments|gross)\b(?!\s+(?:media|spend|search|ads?|social|channels?)\b)/i.test(after)) return "gross";
  if (fig.kind === "money" && /^\s+(?:refunded|in refunds)\b/i.test(after)) return "refunds";
  const counted = fig.kind === "count" ? COUNTED.exec(after) : null;
  if (counted) {
    const prefix = counted[1].toLowerCase();
    const noun = counted[2].toLowerCase();
    if (/unknown|unattributed/.test(prefix) && /^customer/.test(noun)) return "unknown";
    if (/^(?:customer|acquisition)/.test(noun) && PAID_TOUCH.test(after.slice(counted[0].length))) return "paidCustomers";
    if (/^(?:customer|acquisition)/.test(noun)) return /paid|paying/.test(prefix) ? "paidCustomers" : "customers";
    if (/^prospect/.test(noun)) return "prospects";
    if (/^payment/.test(noun)) return "payments";
    if (/^refund/.test(noun)) return "refunds";
    return "none";
  }
  if (fig.kind === "percent" && SHARE_OF.test(after)) {
    // "14.4% of new customers…": the unknown share; "20% of B37's spend": a channel's share (handled by the caller).
    return mentions.some((m) => m.family === "unknown") ? "unknown" : "none";
  }
  // "$150.00 per new customer": a cost per customer.
  if (fig.kind === "money" && /^\s*(?:per|\/|for each|a)\s+(?:(?:new|paid|paying|acquired)\s+)*customer\b/i.test(after)) return "cac";
  // "$1,800 of its spend", "$1,800 of Google Local Services spend": a part of the metric, not (necessarily) its level.
  if (fig.kind === "money" && /^\s*of\b/i.test(after) && mentions.some((m) => m.start > fig.end && m.start - fig.end <= 48 && m.family !== "unsupported")) return "portion";
  let best: { m: Mention; d: number } | null = null;
  for (const m of mentions) {
    const d = m.end <= fig.start ? fig.start - m.end : m.start >= fig.end ? (m.start - fig.end) * 1.5 : 0;
    if (!best || d < best.d) best = { m, d };
  }
  if (best && best.d > MAX_METRIC_DISTANCE) return "none";
  return best?.m.family ?? null;
}

type Role = { kind: "magnitude" } | { kind: "same" } | { kind: "level"; side: "subject" | "against" | "month"; period?: PeriodKey; entity?: string };

const HEDGE = String.raw`(?:about|approximately|roughly|around|nearly|almost)?\s*`;

/** What a figure in a change or comparison stands for: the size of the change, or a level. */
function roleOf(fig: Fig, piece: string): Role {
  const before = piece.slice(Math.max(0, fig.start - 48), fig.start);
  const after = piece.slice(fig.end, fig.end + 32);
  const ownMonthAfter = new RegExp(String.raw`^\s*(?:in|for|during)\s+(?:the\s+)?(?:month of\s+)?(${MONTH_WORD})\b`, "i").exec(after);
  const ownMonthBefore = new RegExp(String.raw`\b(${MONTH_WORD})(?:'s)?\s*(?:(?:[A-Za-z-]+\s+){0,3}?(?:level|value|figure|total|spend|CAC|revenue|collections)\s*)?(?:of|was|is|at|:|=)?\s*\(?\s*${HEDGE}$`, "i").exec(before);
  // "on the same $1,500.00 of spend": equal in both periods.
  if (/\b(?:the\s+)?same\s*$/i.test(before) || /^\s*(?:in|for)\s+both\b/i.test(after)) return { kind: "same" };
  if (new RegExp(String.raw`\bby\s*${HEDGE}$`, "i").test(before) || new RegExp(String.raw`\b(?:increase|decrease|rise|drop|fall|change|gain|loss|jump|decline|swing|difference)\s+of\s*${HEDGE}$`, "i").test(before)) return { kind: "magnitude" };
  if (/^\s*(?:higher|lower|more|less|fewer|above|below|up|down)\b/i.test(after)) return { kind: "magnitude" };
  if (ownMonthAfter) return { kind: "level", side: "month", period: periodOf(ownMonthAfter[1]) };
  if (new RegExp(String.raw`\bfrom\s*${HEDGE}$`, "i").test(before)) return { kind: "level", side: "against" };
  if (new RegExp(String.raw`\b(?:increas\w*|decreas\w*|rose|fell|dropp\w*|grew|declin\w*|jump\w*|climb\w*|gain\w*|lost|shrank|(?:is|are|was|were) (?:up|down))\s*${HEDGE}$`, "i").test(before)) return { kind: "magnitude" };
  if (ownMonthBefore) return { kind: "level", side: "month", period: periodOf(ownMonthBefore[1]) };
  const ownEntity = /\b(B\d{2})(?:'s)?\s*(?:[A-Za-z-]+\s+){0,2}?(?:of|was|is|at|:|=)?\s*\(?\s*$/.exec(before);
  if (new RegExp(String.raw`\b(?:to|is|was|are|were|at|of|reached|now|stands at|totals?|totall?ed|hit)\s*\(?\s*${HEDGE}$`, "i").test(before) || /\(\s*$/.test(before)) return { kind: "level", side: "subject", entity: ownEntity?.[1] };
  if (ownEntity) return { kind: "level", side: "subject", entity: ownEntity[1] };
  return { kind: "magnitude" };
}

// ── Facts and values ─────────────────────────────────────────────────────────

const inputOf = (f: MetricFact): ProofInput => ({
  metric: f.metric,
  entity: f.entity.id,
  period: f.period,
  value: f.value,
  unit: f.unit,
  definitionVersion: f.definitionVersion,
  currencyResolved: f.currencyResolved,
  incompleteReason: f.incompleteReason ?? null,
  evidenceIds: f.evidenceIds.slice(0, 5),
  tool: f.tool,
});

type Lookup = { fact: MetricFact } | { gap: Gap; reason: string; period?: PeriodKey; inputs?: ProofInput[] };

function lookup(facts: MetricFact[], metric: MetricKey, entity: EntityRef, period: PeriodKey | null): Lookup {
  const candidates = facts.filter((f) => f.metric === metric && f.entity.type === entity.type && f.entity.id === entity.id);
  if (candidates.length === 0) return { gap: "fact_missing", reason: `the cited evidence holds no ${METRIC_NAME[metric]} for ${entity.id}` };
  const periods = [...new Set(candidates.map((f) => f.period).filter((x) => x !== "all"))];
  const p = period ?? (periods.length === 1 ? periods[0] : null);
  if (!p) return { gap: "period_ambiguous", reason: "no period stated and the cited facts cover more than one" };
  const at = candidates.filter((f) => f.period === p);
  if (at.length === 0) return { gap: "period_missing", reason: `the cited evidence holds ${METRIC_NAME[metric]} for ${entity.id}, but not for ${p}`, period: p };
  // Two tools that disagree about the same number: neither is a proof.
  const values = [...new Set(at.map((f) => f.value))];
  if (values.length > 1) {
    return { gap: "conflicting_facts", reason: `the cited tools disagree about ${entity.id}'s ${p} ${METRIC_NAME[metric]} (${at.map((f) => `${f.tool}: ${f.value === null ? "n/a" : fmt(shown(f.value, f.unit))}`).join(" vs ")})`, period: p, inputs: at.map(inputOf) };
  }
  // Tools that agree: one fact, with the strictest currency and completeness any of them states.
  const fact: MetricFact = { ...at[0], incompleteReason: at.find((f) => f.incompleteReason)?.incompleteReason ?? null };
  if (fact.unit === "usd_cents" && at.some((f) => !f.currencyResolved)) {
    return { gap: "currency_unresolved", reason: `some of ${entity.id}'s ${p} ${METRIC_NAME[metric]} came from a feed that did not state its currency, and no authorized account rule applies: it is not comparable money`, period: p, inputs: [inputOf(fact)] };
  }
  if (fact.value === null) return { gap: "undefined_value", reason: `${METRIC_NAME[metric]} has no value for ${entity.id} in ${p}`, period: p, inputs: [inputOf(fact)] };
  return { fact };
}

interface Value { value: number; unit: Unit; inputs: ProofInput[]; formula: string; period: PeriodKey }
type ValueOrGap = { ok: Value } | { gap: Gap; reason: string; period?: PeriodKey; inputs?: ProofInput[] };

const ADDITIVE = new Set<MetricKey>(["paidSpend", "paidAcquired", "acquired", "unknownAcquired", "collected", "refunds", "grossCollected", "atRisk", "prospects", "campaignSpend", "channelSpend", "channelAcquired"]);
/** Ratios recomputed from their parts when several branches or both months are asked for. */
const RATIO_PARTS: Partial<Record<MetricKey, [MetricKey, MetricKey]>> = { paidCac: ["paidSpend", "paidAcquired"], channelCac: ["channelSpend", "channelAcquired"], unknownShare: ["unknownAcquired", "acquired"] };

/** A metric's value for one entity and period, or summed over several (recomputing ratios from their parts). */
function valueOf(facts: MetricFact[], metric: MetricKey, entities: EntityRef[], periods: Array<PeriodKey | null>): ValueOrGap {
  const unit = METRIC_UNIT[metric];
  if (entities.length === 1 && periods.length === 1) {
    const l = lookup(facts, metric, entities[0], periods[0]);
    if (!("fact" in l)) return l;
    return { ok: { value: l.fact.value as number, unit, inputs: [inputOf(l.fact)], formula: `v(${metric}, ${entities[0].id}, ${l.fact.period})`, period: l.fact.period } };
  }
  const months = periods.filter((p): p is PeriodKey => p !== null);
  // Both months together: the "all" period when every entity has it cited.
  if (months.length === 2 && months.includes("sep") && months.includes("oct")) {
    const whole = entities.map((e) => lookup(facts, metric, e, "all"));
    if (whole.every((w) => "fact" in w)) return entities.length === 1 ? valueOf(facts, metric, entities, ["all"]) : sumOf(facts, metric, entities, ["all"]);
  }
  return sumOf(facts, metric, entities, months.length ? months : periods);
}

function sumOf(facts: MetricFact[], metric: MetricKey, entities: EntityRef[], periods: Array<PeriodKey | null>): ValueOrGap {
  const unit = METRIC_UNIT[metric];
  const label = `${entities.length > 1 ? `{${entities.map((e) => e.id).join(", ")}}` : entities[0]?.id}, ${periods.length > 1 ? `{${periods.join(", ")}}` : periods[0]}`;
  if (ADDITIVE.has(metric)) {
    let total = 0;
    const inputs: ProofInput[] = [];
    for (const e of entities) {
      for (const p of periods) {
        const l = lookup(facts, metric, e, p);
        if (!("fact" in l)) return { ...l, reason: `a total over ${label} needs every part: ${l.reason}` };
        total += l.fact.value as number;
        inputs.push(inputOf(l.fact));
      }
    }
    return { ok: { value: total, unit, inputs, formula: `Σ v(${metric}, ${label})`, period: periods.length === 1 && periods[0] ? periods[0] : "all" } };
  }
  const parts = RATIO_PARTS[metric];
  if (!parts) return { gap: "metric_unknown", reason: `${METRIC_NAME[metric]} cannot be totalled over ${label}` };
  const num = sumOf(facts, parts[0], entities, periods);
  if (!("ok" in num)) return num;
  const den = sumOf(facts, parts[1], entities, periods);
  if (!("ok" in den)) return den;
  if (den.ok.value === 0) return { gap: "undefined_value", reason: `${METRIC_NAME[metric]} over ${label} has no denominator`, inputs: [...num.ok.inputs, ...den.ok.inputs] };
  const value = unit === "usd_cents" ? Math.round(num.ok.value / den.ok.value) : num.ok.value / den.ok.value;
  return { ok: { value, unit, inputs: [...num.ok.inputs, ...den.ok.inputs], formula: `Σ v(${parts[0]}, ${label}) ÷ Σ v(${parts[1]}, ${label})`, period: periods.length === 1 && periods[0] ? periods[0] : "all" } };
}

// ── Statements ───────────────────────────────────────────────────────────────

interface Channel { id: string; branch: string; code: string; names: string[] }

interface Statement {
  facts: MetricFact[];
  status: StatusFacts | undefined;
  campaignIds: string[];
  channels: Channel[];
  subjectBranch: string | null;
  /**
   * Templates quote what they insert verbatim (a campaign name, an exception's own summary), so a
   * quotation asserts nothing of theirs: its words are not read (R-38). Model text is read whole.
   */
  quotesAreNames: boolean;
}

/** What one piece of a statement passes to the next: "Joshua's …: 10 new customers; 10 paid; …". */
interface Carry { family: Family | null; period: PeriodKey | null; branch: string | null; group: string[] | null }

/** The entity a metric is about: a campaign's or channel's own metrics, else the branch's. */
function entityFor(metric: MetricKey, campaign: string | null, channel: string | null, branch: string | null): EntityRef {
  if ((metric === "campaignSpend" || metric === "campaignAcquired") && campaign) return { type: "campaign", id: campaign };
  if (metric.startsWith("channel") && channel) return { type: "channel", id: channel };
  return { type: "branch", id: branch ?? "" };
}

/** "8 of 8 new customers (100.0%)": the share in brackets must be the part over the whole. */
const SHARE_BEFORE = /(\d[\d,]*)\s+of\s+(\d[\d,]*)\b[^()]{0,80}\(\s*$/;

interface ChannelMention extends Channel { at: number; end: number }

function channelMentionsIn(piece: string, channels: Channel[]): ChannelMention[] {
  const out: ChannelMention[] = [];
  for (const ch of channels) {
    for (const name of ch.names) {
      for (const m of piece.matchAll(new RegExp(String.raw`(?<![\w-])${escapeRe(name)}(?![\w-])`, "gi"))) {
        const at = m.index ?? 0;
        const end = at + m[0].length;
        if (!out.some((o) => at < o.end && end > o.at)) out.push({ ...ch, at, end });
      }
    }
  }
  return out.sort((a, b) => a.at - b.at);
}

function provePiece(text: string, st: Statement, carry: Carry): Proof[] {
  // What is read: the piece, with a template's quotations blanked (positions kept). Proofs show `text`.
  const piece = st.quotesAreNames ? maskQuoted(text) : text;
  const out: Proof[] = [];
  const modal = MODAL.test(piece);
  // A figure is hypothetical only when the conditional or forward-looking word governs it, i.e.
  // comes before it: "CAC would be $250" is; "CAC was $4,825.80, which will need review" is a
  // statement of fact followed by a forecast, and the fact is proved (review 2026-11-12, finding 17).
  const modalAt = piece.search(MODAL);
  const modalBefore = (at: number) => modalAt !== -1 && modalAt < at;
  // A count the credited-part reader takes ("10 of them credited to paid media") is not read again.
  // So is a count of readiness verdicts ("4 of 4 paid channel(s) not ready"): statusProofs proves it.
  const credited = [...creditedCountSpans(piece), ...readinessCountSpans(piece)];
  const figs = figuresOf(piece).filter((f) => !credited.some(([a, b]) => f.start < b && f.end > a));
  const mentions = familyMentions(piece);
  const dirs = directions(piece);
  const branches = [...piece.matchAll(/\bB\d{2}\b/g)].map((m) => ({ id: m[0], at: m.index ?? 0 }));
  const campaignMentions = st.campaignIds
    .flatMap((id) => [...piece.matchAll(new RegExp(String.raw`(?<![\w-])${escapeRe(id)}(?![\w-])`, "g"))].map((m) => ({ id, at: m.index ?? 0 })))
    .sort((a, b) => a.at - b.at);
  const campaign = campaignMentions[0]?.id ?? null;
  /** The campaign a figure is about: the nearest one named before it, else the first named. */
  const campaignAt = (start: number) => [...campaignMentions].reverse().find((c) => c.at < start)?.id ?? campaign;
  const entCmp = ENT_CMP.exec(piece);
  const perCmp = entCmp ? null : PER_CMP.exec(piece);
  const bothMonths = BOTH_MONTHS.test(piece);
  const withoutCmp = perCmp ? piece.replace(perCmp[0], " ") : piece;
  const months = [...new Set([...withoutCmp.matchAll(MONTHS)].map((m) => periodOf(m[0])))];
  const multiple = MULTIPLE.exec(piece);
  const subjectBranches = branches.filter((b) => b.id !== entCmp?.[1]);
  // "Customer 415347 has $50.00 in refunds": that customer's own figures, not the branch's. The
  // facts hold branch, channel and campaign metrics only, so they are not proved here, and they
  // never stand in for the branch's (review 2026-11-12, AI-claims finding 19).
  const customer = /\b[Cc]ustomers?\s+#?(\d{2,})\b/.exec(piece)?.[1] ?? null;
  const subject = customer ? `customer:${customer}` : subjectBranches[0]?.id ?? carry.branch ?? st.subjectBranch;
  const channelsHere = channelMentionsIn(piece, st.channels.filter((c) => !subject || c.branch === subject));
  // A channel compared with another: "…less than its Google Search spend", "…1.5 times as much … as Google Search".
  const chanCmp =
    channelsHere.find((c) => {
      const before = piece.slice(Math.max(0, c.at - 30), c.at);
      return /\b(?:than|vs\.?|versus|compared (?:with|to))\s+(?:its\s+|the\s+|their\s+)?$/i.test(before) || (MULTIPLE.test(piece) && /\bas\s+(?:its\s+|the\s+|their\s+)?$/i.test(before));
    }) ?? null;
  const isChange = !bothMonths && (dirs.length > 0 || perCmp !== null || entCmp !== null || chanCmp !== null) && !(multiple && dirs.length === 0);

  // Several branches as one subject ("B41 and B42", "Joshua's"), or a brand.
  const listed = /\b(B\d{2})((?:\s*,\s*B\d{2})*)\s*,?\s*(?:and|&)\s+(B\d{2})\b/.exec(piece);
  const brand = branches.length === 0 ? BRAND_PATTERNS.find((b) => b.re.test(piece)) ?? null : null;
  // A piece that names no branch, brand or channel keeps the group the statement started with.
  const ownGroup: string[] | null = entCmp ? null : listed ? [...listed[0].matchAll(/B\d{2}/g)].map((m) => m[0]) : brand ? branchesOfBrand(brand.id) : null;
  const group = ownGroup ?? (branches.length === 0 && channelsHere.length === 0 ? carry.group : null);
  carry.group = ownGroup ?? (branches.length === 0 ? carry.group : null);

  let p: PeriodKey | null;
  let againstPeriod: PeriodKey | null = null;
  if (entCmp || chanCmp) {
    p = months[0] ?? carry.period;
  } else if (isChange || multiple) {
    p = months.length >= 2 ? "oct" : months[0] ?? (perCmp ? other(periodOf(perCmp[1])) : carry.period);
    againstPeriod = perCmp ? periodOf(perCmp[1]) : months.length >= 2 ? "sep" : p ? other(p) : null;
  } else {
    p = months[0] ?? carry.period;
  }
  if (mentions.length > 0) carry.family = mentions[mentions.length - 1].family;
  if (p && !bothMonths) carry.period = p;
  if (subject) carry.branch = subject;
  /**
   * The channel a figure is about: one named right after it ("$180.00 for Google Search"), else
   * the nearest named before it — unless a branch is named between them ("Local Services was 30%
   * of B05's $2,000.00": the $2,000.00 is the branch's). No channel named before or after: none.
   */
  const channelAt = (start: number, end: number): string | null => {
    const after = channelsHere.find((c) => c.at >= end && c.at - end <= 25 && /^\s*(?:for|on|from|via|in|at|with)\s+(?:its\s+|the\s+)?$/i.test(piece.slice(end, c.at)));
    if (after) return after.id;
    const before = [...channelsHere].reverse().find((c) => c.end <= start);
    if (!before) return null;
    // Only a possessive branch right before the figure takes it over ("…of B05's $2,000.00");
    // "Local Services cost B24 $150.00" stays the channel's.
    const possessive = branches.some((b) => b.at > before.end && b.at < start && /^B\d{2}'s(?:\s+[\w-]+){0,2}\s*$/.test(piece.slice(b.at, start)));
    return possessive ? null : before.id;
  };
  /** In a comparison of two channels, the subject is the one not compared against. */
  const subjectChannel = chanCmp ? channelsHere.find((c) => c.id !== chanCmp.id)?.id ?? null : null;

  const blank = (figure: string, extra: Partial<Proof>): Proof => ({
    piece: text,
    figure,
    subject: { metric: null, entity: subject, period: p },
    against: null,
    relation: "unknown",
    formula: "",
    inputs: [],
    unit: null,
    computed: null,
    claimed: null,
    qualifier: "exact",
    direction: null,
    claimedDirection: null,
    precision: 0,
    rounding: ROUNDING.exact,
    verdict: "UNRESOLVED",
    gap: null,
    reason: "",
    ...extra,
  });
  const unresolved = (figure: string, gap: Gap, reason: string, extra: Partial<Proof> = {}): Proof => blank(figure, { ...extra, verdict: "UNRESOLVED", gap, reason });

  out.push(...statusProofs(piece, st, subject, p, channelsHere, blank));
  out.push(...membershipProofs(piece, branches, blank));
  out.push(...creditedProofs(piece, st, subject, p, channelsHere, blank));
  if (EVALUATIVE.test(piece) && !modal) out.push(unresolved("", "evaluative", "a judgement of effectiveness (better, more effective) is not a metric the evidence measures; attribution is not effectiveness"));

  // "…twice its September CAC": the ratio of the two values.
  if (multiple && !modal) {
    const k = factorOf(multiple);
    // "…cost B06 1.5 times as much per new customer as Google Search": a cost per customer.
    const family = (/\bcost\w*\b/i.test(piece) && /\bper\s+(?:new |paid |paying |acquired )*customer\b/i.test(piece) ? "cac" : null) ?? mentions[0]?.family ?? carry.family;
    const channel = channelAt(multiple.index, multiple.index);
    const metric = family ? resolve(family, null, channel ? "channel" : "branch") : null;
    if (metric && metric !== "unsupported" && Number.isFinite(k)) {
      const multipleOf = MULTIPLE_OF.exec(piece)?.[1] ?? null;
      const ownBranch = multipleOf ? subjectBranches.find((b) => b.id !== multipleOf)?.id ?? subject : subject;
      const entity = entityFor(metric, campaign, channel, ownBranch);
      const thenEntity: EntityRef = entCmp ? { type: "branch", id: entCmp[1] } : multipleOf ? { type: "branch", id: multipleOf } : chanCmp ? { type: "channel", id: chanCmp.id } : entity;
      const sameMonth = entCmp || chanCmp || multipleOf;
      const nowL = lookup(st.facts, metric, entity, p ?? "oct");
      const thenL = "fact" in nowL ? lookup(st.facts, metric, thenEntity, sameMonth ? nowL.fact.period : againstPeriod ?? other(nowL.fact.period)) : nowL;
      if (!("fact" in nowL)) out.push(unresolved(multiple[0], nowL.gap, nowL.reason));
      else if (!("fact" in thenL)) out.push(unresolved(multiple[0], "comparison_missing", `a multiple is stated, but ${thenL.reason}`));
      else if (thenL.fact.value === 0) out.push(unresolved(multiple[0], "undefined_value", "a multiple of zero is undefined"));
      else {
        const ratio = (nowL.fact.value as number) / (thenL.fact.value as number);
        const ok = Math.abs(ratio - k) <= 0.005 * Math.abs(k);
        out.push(blank(multiple[0], { subject: { metric, entity: entity.id, period: nowL.fact.period }, against: { entity: thenEntity.id, period: thenL.fact.period }, relation: "ratio", formula: `v(${metric}, ${entity.id}, ${nowL.fact.period}) ÷ v(${metric}, ${thenEntity.id}, ${thenL.fact.period})`, inputs: [inputOf(nowL.fact), inputOf(thenL.fact)], unit: "ratio", computed: ratio, claimed: k, verdict: ok ? "VERIFIED" : "CONTRADICTED", reason: ok ? "the ratio of the two values is as stated" : `the ratio is ${fmt(ratio)}, not ${fmt(k)}` }));
      }
    }
  }

  // "…has the lowest paid CAC in the company": every branch must be in the cited facts.
  const superlative = SUPERLATIVE.exec(piece);
  if (superlative && !modal && subject) {
    const family = mentions[0]?.family ?? carry.family;
    const metric = family ? resolve(family, null, "branch") : null;
    if (metric && metric !== "unsupported") {
      const values = BRANCHES.map((b) => ({ id: b.id, l: lookup(st.facts, metric, { type: "branch", id: b.id }, p) }));
      const missing = values.filter((v) => !("fact" in v.l));
      if (missing.length > 0) out.push(unresolved(superlative[1], "fact_missing", `"${superlative[1]} in the company" needs every branch's ${METRIC_NAME[metric]}; the cited evidence lacks ${missing.length} of ${BRANCHES.length} branches`));
      else {
        const own = values.find((v) => v.id === subject);
        const all = values.map((v) => ("fact" in v.l ? (v.l.fact.value as number) : 0));
        const ownValue = own && "fact" in own.l ? (own.l.fact.value as number) : null;
        const lowest = /lowest|cheapest|smallest/i.test(superlative[1]);
        const ok = ownValue !== null && (lowest ? ownValue <= Math.min(...all) : ownValue >= Math.max(...all));
        out.push(blank(superlative[1], { relation: "level", formula: `${lowest ? "min" : "max"} over all branches of v(${metric})`, verdict: ok ? "VERIFIED" : "CONTRADICTED", reason: ok ? "the extreme holds across every branch" : "another branch's value is more extreme" }));
      }
    }
  }

  // A direction with no figure: "October revenue increased".
  if (figs.length === 0) {
    if (!isChange || dirs.length === 0) return out;
    if (modalBefore(dirs[0].at + 1)) return [...out, unresolved("", "hypothetical", "a conditional or forward-looking statement: not a fact the evidence can prove", { claimedDirection: dirs[0].dir })];
    const family = mentions[0]?.family ?? carry.family;
    const channel = channelAt(dirs[0].at, dirs[0].at);
    const metric = family ? resolve(family, null, campaign && (family === "spend" || family === "customers" || family === "paidCustomers") ? "campaign" : channel ? "channel" : "branch") : null;
    if (!metric || metric === "unsupported") return out;
    const claimedDirection = dirs[0].dir;
    const entity = entityFor(metric, campaign, channel, subject);
    if (!entity.id) return [...out, unresolved("", "fact_missing", "no branch named and none in scope", { claimedDirection })];
    const nowL = lookup(st.facts, metric, entity, p ?? (againstPeriod ? other(againstPeriod) : "oct"));
    if (!("fact" in nowL)) return [...out, unresolved("", nowL.gap, nowL.reason, { claimedDirection, subject: { metric, entity: entity.id, period: nowL.period ?? p } })];
    const now = nowL.fact;
    const thenEntity: EntityRef = entCmp ? { type: "branch", id: entCmp[1] } : chanCmp && metric.startsWith("channel") ? { type: "channel", id: chanCmp.id } : entity;
    const thenPeriod = entCmp || chanCmp ? now.period : againstPeriod ?? other(now.period);
    const thenL = lookup(st.facts, metric, thenEntity, thenPeriod);
    if (!("fact" in thenL)) return [...out, unresolved("", "comparison_missing", `${dirWord(claimedDirection)} is stated, but ${thenL.reason}`, { claimedDirection, subject: { metric, entity: entity.id, period: now.period }, against: { entity: thenEntity.id, period: thenPeriod }, inputs: [inputOf(now)] })];
    const then = thenL.fact;
    const delta = (now.value as number) - (then.value as number);
    const direction = delta > 0 ? "increase" : delta < 0 ? "decrease" : "unchanged";
    const ok = direction === claimedDirection;
    out.push(
      blank("", {
        subject: { metric, entity: entity.id, period: now.period },
        against: { entity: then.entity.id, period: then.period },
        relation: "direction",
        formula: `sign(v(${metric}, ${entity.id}, ${now.period}) − v(${metric}, ${then.entity.id}, ${then.period}))`,
        inputs: [inputOf(now), inputOf(then)],
        unit: now.unit,
        computed: shown(delta, now.unit),
        direction,
        claimedDirection,
        verdict: ok ? "VERIFIED" : "CONTRADICTED",
        reason: ok ? `${METRIC_NAME[metric]} shows ${dirWord(direction)}, as stated` : `the claim says ${dirWord(claimedDirection)}; the facts show ${dirWord(direction)} (${fmt(shown(delta, now.unit))})`,
      }),
    );
    return out;
  }

  let lastFamily: Family | null = null;
  for (const fig of figs) {
    const qualifier = qualifierOf(piece.slice(0, fig.start));
    const preceding = dirs.filter((d) => d.at < fig.start);
    const afterCue = /^\s*(?:less|lower|fewer|below|down)\b/i.test(piece.slice(fig.end)) ? "decrease" : /^\s*(?:more|higher|above|up)\b/i.test(piece.slice(fig.end)) ? "increase" : null;
    const claimedDirection: Proof["claimedDirection"] = (preceding[preceding.length - 1] ?? dirs.find((d) => d.at > fig.end))?.dir ?? afterCue;
    const figBase: Partial<Proof> = { qualifier, precision: fig.precision, rounding: ROUNDING[qualifier], claimedDirection, claimed: fig.value };
    if (modalBefore(fig.start)) {
      out.push(unresolved(fig.text, "hypothetical", "a conditional or forward-looking statement: not a fact the evidence can prove", figBase));
      continue;
    }
    // A share in brackets after "N of M …": the arithmetic N ÷ M must give it.
    const share = fig.kind === "percent" ? SHARE_BEFORE.exec(piece.slice(0, fig.start)) : null;
    if (share) {
      const part = Number(share[1].replace(/,/g, ""));
      const whole = Number(share[2].replace(/,/g, ""));
      const computed = whole === 0 ? null : (part / whole) * 100;
      const ok = computed !== null && holds(fig.value, computed, fig.precision, qualifier);
      out.push(blank(fig.text, { ...figBase, relation: "arithmetic", formula: `${share[1]} ÷ ${share[2]} × 100`, unit: "ratio", computed, verdict: computed === null ? "UNRESOLVED" : ok ? "VERIFIED" : "CONTRADICTED", gap: computed === null ? "undefined_value" : null, reason: computed === null ? "a share of zero" : ok ? "the share is the part over the whole" : `${share[1]} of ${share[2]} is ${fmt(computed)}%` }));
      continue;
    }
    const channel = channelAt(fig.start, fig.end);
    // A channel's share of the branch's metric: "Microsoft Ads was 20% ($240.00) of B37's spend".
    if (fig.kind === "percent" && channel && SHARE_OF.test(piece.slice(fig.end))) {
      const base = mentions.find((m) => m.start > fig.end)?.family ?? null;
      const partMetric = base ? resolve(base, "money", "channel") : null;
      const wholeMetric = base ? resolve(base, "money", "branch") : null;
      if (partMetric && wholeMetric && partMetric !== "unsupported" && wholeMetric !== "unsupported" && partMetric !== wholeMetric) {
        const partV = valueOf(st.facts, partMetric, [{ type: "channel", id: channel }], [p]);
        const wholeV = valueOf(st.facts, wholeMetric, [{ type: "branch", id: subject ?? "" }], [p]);
        if (!("ok" in partV)) out.push(unresolved(fig.text, partV.gap, partV.reason, figBase));
        else if (!("ok" in wholeV)) out.push(unresolved(fig.text, wholeV.gap, wholeV.reason, figBase));
        else if (wholeV.ok.value === 0) out.push(unresolved(fig.text, "undefined_value", "a share of zero", figBase));
        else {
          const pct = (partV.ok.value / wholeV.ok.value) * 100;
          const ok = holds(fig.value, pct, fig.precision, qualifier);
          out.push(blank(fig.text, { ...figBase, subject: { metric: partMetric, entity: channel, period: partV.ok.period }, relation: "share", formula: `${partV.ok.formula} ÷ ${wholeV.ok.formula} × 100`, inputs: [...partV.ok.inputs, ...wholeV.ok.inputs], unit: "ratio", computed: pct, verdict: ok ? "VERIFIED" : "CONTRADICTED", reason: ok ? "the channel's share of the branch's metric is as stated" : `the share is ${pct.toFixed(2)}%` }));
        }
        continue;
      }
    }
    // Money in brackets right after a channel share: the channel's part of the metric.
    const bracketAfterShare = fig.kind === "money" && /%\s*\(\s*$/.test(piece.slice(0, fig.start)) && channel;
    let family = bracketAfterShare ? mentions.find((m) => m.start > fig.end)?.family ?? null : familyFor(fig, piece, mentions) ?? (mentions.length === 0 ? carry.family : null);
    // A parallel figure ("$270.00 per new customer, versus $180.00 for Google Search") means what
    // the figure before it meant.
    if ((family === null || family === "none") && lastFamily && /\b(?:versus|vs\.?|compared (?:with|to)|against|and)\s*$/i.test(piece.slice(0, fig.start))) family = lastFamily;
    if (family && family !== "none" && family !== "portion") lastFamily = family;
    const portion = family === "portion";
    if (portion && isChange && roleOf(fig, piece).kind !== "same") {
      // "…cheaper than Google Search because $1,800 of its spend is stored under Google Search":
      // a part of a metric inside a comparison is neither side's level.
      out.push(unresolved(fig.text, "metric_unknown", "a part of a metric (\"$1,800 of its spend\") is not the metric's level, so it is not proved here", figBase));
      continue;
    }
    if (portion) family = mentions.find((m) => m.start > fig.end && m.family !== "unsupported")?.family ?? null;
    const figCampaign = campaignAt(fig.start);
    const metric = family ? resolve(family, fig.anyUnit ? null : fig.kind, figCampaign && (family === "spend" || family === "customers" || family === "paidCustomers") ? "campaign" : channel ? "channel" : "branch") : null;
    if (metric === "unsupported") {
      out.push(unresolved(fig.text, "metric_unsupported", "names a measure the product does not verify from these facts (invoiced or billed amounts, contract value, payment or refund counts)", figBase));
      continue;
    }
    if (!metric) {
      out.push(unresolved(fig.text, "metric_unknown", "no metric of the product is named for this figure, so its meaning cannot be checked", figBase));
      continue;
    }
    const unit = METRIC_UNIT[metric];
    const nearestBranch = [...branches].reverse().find((b) => b.at < fig.start)?.id;
    const role: Role = isChange ? roleOf(fig, piece) : { kind: "level", side: "subject" };
    const levelEntityId = (role.kind === "level" && role.entity) || nearestBranch || subject;
    const entity = entityFor(metric, figCampaign, isChange && subjectChannel ? subjectChannel : channel, (isChange ? subject : levelEntityId) ?? null);
    if (!entity.id) {
      out.push(unresolved(fig.text, "fact_missing", "no branch or campaign named and none in scope", figBase));
      continue;
    }
    const subjectOf = (period: PeriodKey | null) => ({ metric, entity: entity.id, period });

    // Unit: a percentage is not money, a count is not dollars.
    const relativeChange = isChange && role.kind === "magnitude" && fig.kind === "percent" && unit !== "ratio";
    if (!fig.anyUnit && !relativeChange && !compatible(fig.kind, unit)) {
      out.push(blank(fig.text, { ...figBase, subject: subjectOf(p), relation: isChange ? "change" : "level", formula: `v(${metric}, ${entity.id}, ${p ?? "?"})`, unit, verdict: "CONTRADICTED", reason: `a ${fig.kind} figure for ${METRIC_NAME[metric]}, which is measured in ${unitWord(unit)}` }));
      continue;
    }

    if (!isChange) {
      const own = roleOf(fig, piece);
      const period = own.kind === "level" && own.side === "month" ? own.period ?? p : p;
      // Several branches (or a brand) as the subject, or both months together: a total.
      const groupIds = group && group.length > 1 && !channel && !figCampaign && (listed ? fig.start > listed.index : true) ? group : null;
      const entities: EntityRef[] = groupIds ? groupIds.map((id) => ({ type: "branch", id })) : [entity];
      const periods: Array<PeriodKey | null> = bothMonths ? ["sep", "oct"] : [period];
      const v = valueOf(st.facts, metric, entities, periods);
      const aggregate = entities.length > 1 || periods.length > 1;
      if (!("ok" in v)) {
        out.push(unresolved(fig.text, portion && v.gap === "fact_missing" ? "metric_unknown" : v.gap, v.reason, { ...figBase, subject: subjectOf(v.period ?? period), unit, inputs: v.inputs ?? [] }));
        continue;
      }
      const actual = shown(v.ok.value, unit);
      const ok = holds(fig.value, actual, fig.precision, qualifier);
      if (portion && !ok) {
        // "$1,800 of its spend" that is not the whole: a part, which these facts do not break down.
        out.push(unresolved(fig.text, "metric_unknown", "a part of a metric (\"$1,800 of its spend\") is not the metric's level, so it is not proved here", { ...figBase, subject: subjectOf(v.ok.period), unit, inputs: v.ok.inputs }));
        continue;
      }
      out.push(blank(fig.text, { ...figBase, subject: { metric, entity: groupIds ? groupIds.join("+") : entity.id, period: v.ok.period }, relation: aggregate ? "sum" : "level", formula: v.ok.formula, inputs: v.ok.inputs, unit, computed: actual, verdict: ok ? "VERIFIED" : "CONTRADICTED", reason: ok ? (aggregate ? "the total over every part equals the figure" : "equals the cited fact at the precision written") : `the cited ${aggregate ? "total" : "fact"} is ${fmtIn(unit, actual)}` }));
      continue;
    }

    // A change or comparison: both sides must be in the cited evidence.
    const nowL = lookup(st.facts, metric, entity, p ?? (againstPeriod ? other(againstPeriod) : "oct"));
    if (!("fact" in nowL)) {
      out.push(unresolved(fig.text, nowL.gap, nowL.reason, { ...figBase, subject: subjectOf(nowL.period ?? p), unit, inputs: nowL.inputs ?? [] }));
      continue;
    }
    const now = nowL.fact;
    const thenEntity: EntityRef = entCmp ? { type: "branch", id: entCmp[1] } : chanCmp && entity.type === "channel" ? { type: "channel", id: chanCmp.id === entity.id ? channelsHere.find((c) => c.id !== entity.id)?.id ?? chanCmp.id : chanCmp.id } : entity;
    const thenPeriod = entCmp || (chanCmp && entity.type === "channel") ? now.period : againstPeriod ?? other(now.period);
    const thenL = lookup(st.facts, metric, thenEntity, thenPeriod);
    if (!("fact" in thenL)) {
      const gap: Gap = thenL.gap === "currency_unresolved" || thenL.gap === "undefined_value" || thenL.gap === "conflicting_facts" ? thenL.gap : "comparison_missing";
      out.push(unresolved(fig.text, gap, `a change or comparison is stated, but ${thenL.reason}`, { ...figBase, subject: subjectOf(now.period), against: { entity: thenEntity.id, period: thenPeriod }, unit, inputs: [inputOf(now)] }));
      continue;
    }
    const then = thenL.fact;
    const delta = (now.value as number) - (then.value as number);
    const direction = delta > 0 ? "increase" : delta < 0 ? "decrease" : "unchanged";
    const stated: Proof["claimedDirection"] = claimedDirection ?? (role.kind === "magnitude" && fig.value < 0 ? "decrease" : null);
    const signOk = stated === null || stated === direction;
    const vNow = `v(${metric}, ${entity.id}, ${now.period})`;
    const vThen = `v(${metric}, ${thenEntity.id}, ${then.period})`;
    const common: Partial<Proof> = { ...figBase, claimedDirection: stated, subject: subjectOf(now.period), against: { entity: thenEntity.id, period: then.period }, inputs: [inputOf(now), inputOf(then)], unit, direction };
    const signReason = `the claim says ${dirWord(stated ?? "unchanged")}; the facts show ${dirWord(direction)} (${fmt(shown(delta, unit))})`;

    if (role.kind === "same") {
      // "…on the same $1,500.00 of spend": the figure is the level of both sides.
      const both = [shown(now.value as number, unit), shown(then.value as number, unit)];
      const ok = both.every((v) => holds(fig.value, v, fig.precision, qualifier));
      out.push(blank(fig.text, { ...common, claimedDirection: null, relation: "change", formula: `${vNow} = ${vThen}`, computed: both[0], verdict: ok ? "VERIFIED" : "CONTRADICTED", reason: ok ? "the value is the same on both sides, as stated" : `the two sides are ${fmt(both[0])} and ${fmt(both[1])}` }));
      continue;
    }
    if (role.kind === "level") {
      // "from $120,000 to $100,000", "higher than B12's $200": the figure is one side's level.
      const figChannel = channel;
      const againstSide =
        role.side === "against" ||
        (role.side === "month" && !entCmp && role.period === then.period && then.period !== now.period) ||
        (entCmp !== null && levelEntityId === thenEntity.id) ||
        (thenEntity.type === "channel" && figChannel === thenEntity.id && thenEntity.id !== entity.id);
      const fact = againstSide ? then : now;
      const actual = shown(fact.value as number, unit);
      const ok = holds(fig.value, actual, fig.precision, qualifier) && signOk;
      out.push(blank(fig.text, { ...common, relation: "change", formula: `${againstSide ? vThen : vNow}; direction: sign(${vNow} − ${vThen})`, computed: actual, verdict: ok ? "VERIFIED" : "CONTRADICTED", reason: ok ? "the level matches its fact and the direction agrees" : !signOk ? signReason : `the ${fact.entity.id} ${fact.period} fact is ${fmt(actual)}` }));
      continue;
    }
    if (relativeChange) {
      if (then.value === 0) {
        out.push(unresolved(fig.text, "undefined_value", "a percentage change from zero is undefined", common));
        continue;
      }
      const pct = (Math.abs(delta) / Math.abs(then.value as number)) * 100;
      const ok = holds(Math.abs(fig.value), pct, fig.precision, qualifier) && signOk;
      out.push(blank(fig.text, { ...common, relation: "relative_change", formula: `|${vNow} − ${vThen}| ÷ |${vThen}| × 100`, computed: pct, verdict: ok ? "VERIFIED" : "CONTRADICTED", reason: ok ? "the relative change and its direction agree" : !signOk ? signReason : `the relative change is ${pct.toFixed(2)}%` }));
      continue;
    }
    if (unit === "ratio") {
      // A change of a share: only "points" has one reading.
      if (!/^\s*(?:percentage[- ])?points?\b|^\s*pp\b/i.test(piece.slice(fig.end))) {
        out.push(unresolved(fig.text, "ambiguous", "a percent change of a share can mean points or a relative change; say \"points\"", common));
        continue;
      }
      const pts = shown(delta, unit);
      const ok = holds(Math.abs(fig.value), Math.abs(pts), fig.precision, qualifier) && signOk;
      out.push(blank(fig.text, { ...common, relation: "points_change", formula: `(${vNow} − ${vThen}) × 100`, computed: pts, verdict: ok ? "VERIFIED" : "CONTRADICTED", reason: ok ? "the change in points and its direction agree" : !signOk ? signReason : `the change is ${fmt(pts)} points` }));
      continue;
    }
    const ok = holds(Math.abs(fig.value), Math.abs(shown(delta, unit)), fig.precision, qualifier) && signOk && !(direction === "unchanged" && stated !== null);
    out.push(blank(fig.text, { ...common, relation: "change", formula: `${vNow} − ${vThen}`, computed: shown(delta, unit), verdict: ok ? "VERIFIED" : "CONTRADICTED", reason: ok ? "the size and direction of the change agree" : !signOk ? signReason : `the change is ${fmt(shown(delta, unit))}` }));
  }
  return out;
}

// ── Credited parts ───────────────────────────────────────────────────────────

const COUNT_WORD = String.raw`(\d+|zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)`;
/** "…, 2 of them credited to Meta", "6 of them credited to paid media". */
const PART_OF_THEM = new RegExp(String.raw`\b${COUNT_WORD}\s+of\s+(?:them|these|those)\s+(?:were\s+|are\s+)?(?:credited to|attributed to|from|via|through)\s+(paid media|paid channels|a paid channel|paid)?`, "gi");
/** "Local Services is credited with 4 of B20's 10 October paid-media customers". */
const CREDITED_WITH = new RegExp(String.raw`\b(?:is|was|are|were|gets|got)\s+credited with\s+${COUNT_WORD}\s+of\b`, "gi");

const countOf = (word: string) => (/^\d+$/.test(word) ? Number(word) : NUMBER_WORDS[word.toLowerCase()]);

/** Where the counts the credited-part reader takes sit in the piece. */
function creditedCountSpans(piece: string): Array<[number, number]> {
  const spans: Array<[number, number]> = [];
  for (const re of [PART_OF_THEM, CREDITED_WITH]) {
    for (const m of piece.matchAll(re)) {
      const at = (m.index ?? 0) + m[0].indexOf(m[1]);
      spans.push([at, at + m[1].length]);
    }
  }
  return spans;
}

/**
 * Customers credited to a channel, or to paid media, stated as a part of a count: each part is
 * a level of the channel's (or the branch's paid) customers. Without this the part was never read
 * and the sentence was proved on its whole alone ("5 paid customers, 3 of them credited to Meta"
 * passed with Meta's true count 2).
 */
function creditedProofs(piece: string, st: Statement, subject: string | null, p: PeriodKey | null, channelsHere: ChannelMention[], blank: (figure: string, extra: Partial<Proof>) => Proof): Proof[] {
  const out: Proof[] = [];
  if (!subject || MODAL.test(piece)) return out;
  const level = (figure: string, claimed: number, entity: EntityRef, metric: MetricKey) => {
    const l = lookup(st.facts, metric, entity, p);
    if (!("fact" in l)) return out.push(blank(figure, { subject: { metric, entity: entity.id, period: l.period ?? p }, relation: "level", claimed, verdict: "UNRESOLVED", gap: l.gap, reason: l.reason }));
    const actual = l.fact.value as number;
    const ok = actual === claimed;
    return out.push(
      blank(figure, {
        subject: { metric, entity: entity.id, period: l.fact.period },
        relation: "level",
        formula: `v(${metric}, ${entity.id}, ${l.fact.period})`,
        inputs: [inputOf(l.fact)],
        unit: "count",
        computed: actual,
        claimed,
        verdict: ok ? "VERIFIED" : "CONTRADICTED",
        reason: ok ? "the credited part equals the cited fact" : `the cited fact is ${actual}`,
      }),
    );
  };
  for (const m of piece.matchAll(PART_OF_THEM)) {
    const at = (m.index ?? 0) + m[0].length;
    const n = countOf(m[1]);
    if (m[2]) level(m[0].trim(), n, { type: "branch", id: subject }, "paidAcquired");
    else {
      const channel = channelsHere.find((c) => c.at >= at && c.at - at <= 2);
      if (channel) level(m[0].trim(), n, { type: "channel", id: channel.id }, "channelAcquired");
    }
  }
  for (const m of piece.matchAll(CREDITED_WITH)) {
    const channel = [...channelsHere].reverse().find((c) => c.end <= (m.index ?? 0));
    if (channel) level(m[0].trim(), countOf(m[1]), { type: "channel", id: channel.id }, "channelAcquired");
  }
  return out;
}

// ── Status and membership ────────────────────────────────────────────────────

const READY = /\b(not\s+(?:yet\s+)?)?(?:decision[- ]ready|ready to (?:move|shift|reallocate) (?:the )?budget|ready for (?:a )?budget (?:decisions?|moves?))\b/i;
const TRUST = /\bbudget signal\b[^.;]{0,40}?\b(not\s+|un)?(trustworthy|reliable|trusted|sound)\b/i;
const COMPLETE = /\b(?:records?|data|payments?|feeds?|figures?|numbers?|collections?)\b[^.;]{0,40}?\b(?:is|are)\s+(?:(?:now|fully)\s+)?(?:complete|up[- ]to[- ]date|current|fresh)\b|\bfor the (?:whole|entire|full) (?:of )?(?:october|september|month|period)\b/i;
const ABSENCE = /\b(?:has|have|had)\s+not\s+(?:yet\s+)?(?:paid|been paid)\b|\bnot\s+(?:yet\s+)?paid\b|\bunpaid\b|\bno payments?\b/i;
/** A feed claimed stale: "the CRM payment feed has not synced successfully since October 15", "the calls feed is stale". */
const STALE = /\b(?:feeds?|sync|records?|data)\b[^.;]{0,40}?\b(?:has|have)\s+not\s+(?:synced|run|updated|refreshed|arrived)\b|\b(?:feeds?|data|records?)\b[^.;]{0,20}?\b(?:is|are)\s+stale\b/i;

function streamsFor(text: string): RegExp {
  if (/\bpay|collect|revenue|cash|refund/i.test(text)) return /^crm\.payment$/;
  if (/\bspend|campaign|ads?\b/i.test(text)) return /^ads$/;
  if (/\bcustomer|serviced|appointment/i.test(text)) return /^crm\./;
  return /./;
}

/**
 * A count of a branch's readiness verdicts: "4 of 4 paid channel(s) not ready to move budget",
 * "two of four channels are decision-ready". Before this reading, such a sentence named no
 * channel, so it proved nothing, and a template stating it was still shown as supported (R-38).
 */
const READY_COUNT = new RegExp(
  String.raw`\b${COUNT_WORD}\s+of\s+(?:(?:the|its|their)\s+)?${COUNT_WORD}\s+(?:paid\s+)?(?:media\s+)?channel(?:s|\(s\))?\s+(?:(?:are|is|were|was)\s+)?(not\s+(?:yet\s+)?)?(?:decision[- ]ready|ready to (?:move|shift|reallocate) (?:the )?budget|ready for (?:a )?budget (?:decisions?|moves?))\b`,
  "i",
);

function readinessCountSpans(piece: string): Array<[number, number]> {
  const m = READY_COUNT.exec(piece);
  if (!m) return [];
  const at = m.index ?? 0;
  const second = m[0].indexOf(m[2], m[1].length);
  return [
    [at, at + m[1].length],
    [at + second, at + second + m[2].length],
  ];
}

function statusProofs(piece: string, st: Statement, subject: string | null, p: PeriodKey | null, channelsHere: ChannelMention[], blank: (figure: string, extra: Partial<Proof>) => Proof): Proof[] {
  const out: Proof[] = [];
  if (MODAL.test(piece)) return out;
  const status = st.status;
  const ready = READY.exec(piece);
  const counted = READY_COUNT.exec(piece);
  if (counted && subject) {
    // Count the verdicts the tools returned for this branch (and period), one per channel.
    const verdicts = new Map<string, boolean>();
    for (const r of status?.readiness ?? []) if (r.branchId === subject && (!p || r.period === p)) verdicts.set(r.channelCode, (verdicts.get(r.channelCode) ?? true) && r.ready);
    const figure = `${counted[1]} of ${counted[2]}`;
    if (verdicts.size === 0) {
      out.push(blank(figure, { relation: "status", verdict: "UNRESOLVED", gap: "fact_missing", reason: `no decision-readiness result for ${subject} was returned` }));
    } else {
      const claimsReady = !counted[3];
      const part = countOf(counted[1]);
      const whole = countOf(counted[2]);
      const actual = [...verdicts.values()].filter((v) => v === claimsReady).length;
      const ok = part === actual && whole === verdicts.size;
      out.push(
        blank(figure, {
          relation: "status",
          formula: `count(readiness(${subject}) ${claimsReady ? "=" : "≠"} ready) of count(readiness(${subject}))`,
          unit: "count",
          computed: actual,
          claimed: part,
          verdict: ok ? "VERIFIED" : "CONTRADICTED",
          reason: ok ? `${actual} of the ${verdicts.size} channel verdicts returned for ${subject} are ${claimsReady ? "" : "not "}ready, as stated` : `${actual} of the ${verdicts.size} channel verdicts returned for ${subject} are ${claimsReady ? "" : "not "}ready`,
        }),
      );
    }
  } else if (ready && subject) {
    const claimsReady = !ready[1];
    // Every channel the piece names is part of the claim: "Google Search and Meta are
    // decision-ready" is two propositions (review 2026-11-12, AI-claims finding 13).
    const codes = [...new Set(channelsHere.map((c) => c.code))];
    if (codes.length === 0) out.push(blank("", { relation: "status", verdict: "UNRESOLVED", gap: "fact_missing", reason: `no decision-readiness result for a channel of ${subject} was returned` }));
    for (const channel of codes) {
      const facts = (status?.readiness ?? []).filter((r) => r.branchId === subject && r.channelCode === channel && (!p || r.period === p));
      if (facts.length === 0) {
        out.push(blank("", { relation: "status", verdict: "UNRESOLVED", gap: "fact_missing", reason: `no decision-readiness result for ${subject}'s ${channel} was returned` }));
        continue;
      }
      const isReady = facts.every((f) => f.ready);
      const ok = isReady === claimsReady;
      out.push(blank("", { relation: "status", formula: `readiness(${subject}, ${channel}) = ${facts[0].status}`, verdict: ok ? "VERIFIED" : "CONTRADICTED", reason: ok ? `${channel}'s readiness verdict is as stated` : `${channel}'s readiness verdict is "${facts[0].status}"` }));
    }
  }
  const trust = TRUST.exec(piece);
  if (trust && subject) {
    const claimsTrust = !trust[1];
    const facts = (status?.budgetSignal ?? []).filter((b) => b.branchId === subject && (!p || b.period === p));
    if (facts.length === 0) out.push(blank("", { relation: "status", verdict: "UNRESOLVED", gap: "fact_missing", reason: `no budget-signal result for ${subject} was returned` }));
    else {
      const ok = facts.every((f) => f.trustworthy === claimsTrust);
      out.push(blank("", { relation: "status", formula: `budgetSignal(${subject}).trustworthy = ${facts[0].trustworthy}`, verdict: ok ? "VERIFIED" : "CONTRADICTED", reason: ok ? "the budget signal's trust is as stated" : `the budget signal is ${facts[0].trustworthy ? "" : "not "}trustworthy` }));
    }
  }
  const relevant = (status?.streams ?? []).filter((s) => streamsFor(piece).test(s.stream));
  if (COMPLETE.test(piece)) {
    const stale = relevant.filter((s) => s.stale);
    if (relevant.length === 0) out.push(blank("", { relation: "status", verdict: "UNRESOLVED", gap: "fact_missing", reason: "completeness is claimed but no feed-freshness result was returned" }));
    else out.push(blank("", { relation: "status", formula: `fresh(${relevant.map((s) => s.stream).join(", ")})`, verdict: stale.length ? "CONTRADICTED" : "VERIFIED", reason: stale.length ? `the ${stale.map((s) => s.stream).join(", ")} feed is stale (${stale.map((s) => `${s.hoursSinceSuccess ?? "?"} h since a successful run`).join(", ")}): the records are not complete` : "every relevant feed is fresh" }));
  }
  if (STALE.test(piece)) {
    const stale = relevant.filter((s) => s.stale);
    if (relevant.length === 0) out.push(blank("", { relation: "status", verdict: "UNRESOLVED", gap: "fact_missing", reason: "a stale feed is claimed but no feed-freshness result was returned" }));
    else out.push(blank("", { relation: "status", formula: `stale(${relevant.map((s) => s.stream).join(", ")})`, verdict: stale.length ? "VERIFIED" : "CONTRADICTED", reason: stale.length ? `the ${stale.map((s) => s.stream).join(", ")} feed is stale, as stated` : "every relevant feed is fresh" }));
  }
  if (ABSENCE.test(piece)) {
    const stale = relevant.filter((s) => s.stale);
    out.push(blank("", { relation: "status", verdict: "UNRESOLVED", gap: stale.length ? "evidence_stale" : "metric_unknown", reason: stale.length ? `an absence cannot be shown while the ${stale.map((s) => s.stream).join(", ")} feed is stale` : "the absence of a payment for particular customers is not one of the metric facts" }));
  }
  return out;
}

const MEMBERSHIP = BRAND_PATTERNS.map((b) => ({ ...b, assert: new RegExp(String.raw`(${b.re.source})(?:'s)?\s+(?:brand|branch(?:es)?|Pest Control|spend|customers?)\b`) }));

function membershipProofs(piece: string, branches: Array<{ id: string; at: number }>, blank: (figure: string, extra: Partial<Proof>) => Proof): Proof[] {
  const out: Proof[] = [];
  for (const b of MEMBERSHIP) {
    const m = b.assert.exec(piece);
    if (!m) continue;
    const named = branches.filter((x) => x.at < (m.index ?? 0));
    const negated = /\b(?:not|isn't|aren't|never)\b[^.;]{0,20}$/i.test(piece.slice(0, m.index));
    for (const x of named) {
      const actual = BRANCH_BY_ID.get(x.id)?.brandId ?? null;
      const inBrand = actual === b.id;
      const ok = negated ? !inBrand : inBrand;
      out.push(blank("", { relation: "membership", formula: `brand(${x.id}) = ${actual ?? "?"}`, verdict: ok ? "VERIFIED" : "CONTRADICTED", reason: ok ? `${x.id} is ${negated ? "not " : ""}a ${b.name} branch, as stated` : `${x.id} is a ${BRANDS.find((y) => y.id === actual)?.name ?? "branch of another brand"} branch` }));
    }
  }
  return out;
}

// ── Arithmetic ───────────────────────────────────────────────────────────────

const TOKEN = String.raw`[−-]?\$?\d[\d,]*(?:\.\d+)?(?:\s?[KkMm]\b)?%?(?:\s?cents\b)?`;
const LABEL = String.raw`(?:\s+(?:(?:(?:new|paid|paying|unique|media|ad)\s+)*(?:customers?|prospects?|leads?|campaigns?|calls?|spend)(?:\s+whose first evidenced touch was paid)?|paid|refunded|gross))?`;
const OPERAND = String.raw`(${TOKEN})(${LABEL})`;
const OPERATOR = String.raw`(?:\s*([÷/×*])\s*|\s+([x+−-])\s+)`;

interface Expr { a: string; aLabel: string; op: string; b: string; bLabel: string; c: string; keep: string }
/** Three written forms: "A ÷ B = C", "C = A ÷ B", and "C per new customer (A ÷ B)". `keep` is what stays in the text. */
const EXPRESSIONS: Array<{ re: RegExp; read: (g: string[]) => Expr }> = [
  {
    re: new RegExp(String.raw`${OPERAND}${OPERATOR}${OPERAND}\s*=\s*(${TOKEN})`, "g"),
    read: (g) => ({ a: g[0], aLabel: g[1] ?? "", op: g[2] ?? g[3], b: g[4], bLabel: g[5] ?? "", c: g[6], keep: g[6] }),
  },
  {
    re: new RegExp(String.raw`(${TOKEN})\s*=\s*${OPERAND}${OPERATOR}${OPERAND}`, "g"),
    read: (g) => ({ c: g[0], a: g[1], aLabel: g[2] ?? "", op: g[3] ?? g[4], b: g[5], bLabel: g[6] ?? "", keep: g[0] }),
  },
  {
    re: new RegExp(String.raw`(${TOKEN})((?:\s+[A-Za-z-]+){0,4})\s*\(\s*${OPERAND}${OPERATOR}${OPERAND}\s*\)`, "g"),
    read: (g) => ({ c: g[0], a: g[2], aLabel: g[3] ?? "", op: g[4] ?? g[5], b: g[6], bLabel: g[7] ?? "", keep: `${g[0]}${g[1] ?? ""}` }),
  },
];

interface Token { value: number; kind: Fig["kind"]; precision: number }

function token(t: string): Token | null {
  let s = t.trim();
  const negative = /^[−-]/.test(s);
  s = s.replace(/^[−-]/, "");
  const cents = /\s?cents$/.test(s);
  s = s.replace(/\s?cents$/, "");
  const money = s.startsWith("$");
  s = s.replace(/^\$/, "");
  const percent = s.endsWith("%");
  s = s.replace(/%$/, "");
  const sc = /\s?([KkMm])$/.exec(s);
  const scale = sc ? (sc[1].toLowerCase() === "k" ? 1e3 : 1e6) : 1;
  s = s.replace(/\s?[KkMm]$/, "").replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(s)) return null;
  const decimals = s.split(".")[1]?.length ?? 0;
  let value = Number(s) * scale * (negative ? -1 : 1);
  let precision = decimals - Math.log10(scale);
  let kind: Fig["kind"] = money ? "money" : percent ? "percent" : "count";
  if (cents) {
    value /= 100;
    precision += 2;
    kind = "money";
  }
  return { value, kind, precision };
}

function extractArithmetic(text: string, st: Statement): { rest: string; proofs: Proof[] } {
  const proofs: Proof[] = [];
  let rest = text;
  for (const { re, read } of EXPRESSIONS) {
    rest = rest.replace(re, (whole: string, ...args: unknown[]) => {
      const offset = args.find((x) => typeof x === "number") as number;
      const groups = args.slice(0, args.indexOf(offset)) as string[];
      const { a: aT, aLabel, op, b: bT, bLabel, c: cT, keep } = read(groups);
      const a = token(aT);
      const b = token(bT);
      const c = token(cT);
      if (!a || !b || !c || !op) return whole;
      // The channel the expression is about: the last one named shortly before it.
      const context = rest.slice(Math.max(0, offset - 80), offset);
      const named = channelMentionsIn(context, st.channels.filter((ch) => !st.subjectBranch || ch.branch === st.subjectBranch));
      const channel = named[named.length - 1]?.id ?? null;
      const symbol = op === "/" ? "÷" : op === "*" || op === "x" ? "×" : op === "-" ? "−" : op;
      let computed: number | null;
      if (symbol === "÷") computed = b.value === 0 ? null : a.value / b.value;
      else if (symbol === "×") computed = a.value * b.value;
      else if (symbol === "+") computed = a.value + b.value;
      else computed = a.value - b.value;
      // A ratio shown as a percentage.
      if (computed !== null && symbol === "÷" && c.kind === "percent" && a.kind !== "percent") computed *= 100;
      const formula = `${aT.trim()} ${symbol} ${bT.trim()}`;
      const proofBase: Proof = {
        piece: whole,
        figure: cT.trim(),
        subject: { metric: null, entity: st.subjectBranch, period: null },
        against: null,
        relation: "arithmetic",
        formula,
        inputs: [],
        unit: null,
        computed,
        claimed: c.value,
        qualifier: "exact",
        direction: null,
        claimedDirection: null,
        precision: c.precision,
        rounding: ROUNDING.exact,
        verdict: "UNRESOLVED",
        gap: null,
        reason: "",
      };
      if (computed === null) {
        proofs.push({ ...proofBase, gap: "undefined_value", reason: "division by zero" });
        return ` ${keep} `;
      }
      // Rounded operands carry their rounding: "$15,193 ÷ 31" means anything from $15,192.50 to
      // $15,193.50 over 31, so $490.11 is consistent with it. The result must fall in that range
      // at its own precision. A count is exact: "÷ 20" is twenty, not 19.5 to 20.5 (review
      // 2026-11-12, AI-claims finding 18: "$4,825.80 ÷ 20 = $247.00" was accepted).
      const half = (t: Token) => (t.kind === "count" && t.precision === 0 && Number.isInteger(t.value) ? 0 : 0.5 * 10 ** -t.precision);
      const corners: number[] = [];
      for (const av of [a.value - half(a), a.value + half(a)]) {
        for (const bv of [b.value - half(b), b.value + half(b)]) {
          const x = symbol === "÷" ? (bv === 0 ? Number.NaN : av / bv) : symbol === "×" ? av * bv : symbol === "+" ? av + bv : av - bv;
          corners.push(symbol === "÷" && c.kind === "percent" && a.kind !== "percent" ? x * 100 : x);
        }
      }
      const lo = Math.min(...corners.filter(Number.isFinite));
      const hi = Math.max(...corners.filter(Number.isFinite));
      const consistent = c.value + half(c) + 1e-9 >= lo && c.value - half(c) - 1e-9 <= hi;
      if (!consistent) {
        proofs.push({ ...proofBase, verdict: "CONTRADICTED", reason: `${formula} = ${fmt(computed)}, not ${cT.trim()}` });
        return ` ${keep} `;
      }
      // Where the operands come from: a labelled operand must equal its metric's fact (the
      // channel's, when a channel is named); an unlabelled one must equal some cited fact of its
      // kind (its provenance, not its meaning).
      const inputs: ProofInput[] = [];
      const inScope = (f: MetricFact) => !st.subjectBranch || f.entity.type === "campaign" || f.entity.id === st.subjectBranch || f.entity.id.startsWith(`${st.subjectBranch}:`);
      for (const [t, tok, label] of [[aT, a, aLabel], [bT, b, bLabel]] as const) {
        const family = label.trim() ? familyFor({ kind: tok.kind, start: 0, end: t.length }, `${t}${label}`, familyMentions(`${t}${label}`)) : null;
        const metric = family ? resolve(family, tok.kind, channel ? "channel" : "branch") : null;
        const labelled = metric !== null && metric !== "unsupported";
        const pool = st.facts.filter((f) => compatible(tok.kind, f.unit) && f.value !== null && inScope(f) && (labelled ? f.metric === metric && (!channel || !metric.startsWith("channel") || f.entity.id === channel) : true));
        const match = pool.find((f) => holds(tok.value, shown(f.value as number, f.unit), tok.precision, "exact"));
        if (!match) {
          const wrong = labelled && pool.length > 0;
          proofs.push({ ...proofBase, inputs, verdict: wrong ? "CONTRADICTED" : "UNRESOLVED", gap: wrong ? null : "operand_missing", reason: wrong ? `${t.trim()}${label} does not match the cited ${METRIC_NAME[metric as MetricKey]}` : `the operand ${t.trim()} is not among the cited facts` });
          return ` ${keep} `;
        }
        inputs.push(inputOf(match));
      }
      proofs.push({ ...proofBase, inputs, verdict: "VERIFIED", reason: "the arithmetic holds and its operands are cited facts" });
      return ` ${keep} `;
    });
  }
  return { rest, proofs };
}

// ── Closed reading (model text) ──────────────────────────────────────────────
//
// Model text is proved only as far as it was READ. The reader above builds propositions from a
// fixed vocabulary; what a piece says outside it would otherwise be ignored, and the piece
// certified on the part that was read: "did not fall" proved as "fell", "surged by $20,000"
// proved by its size alone, "Elm's CAC" proved as the investigation branch's, "300.00 per paid
// customer" not seen at all (review 2026-11-12, AI-claims findings 1–15). For the model's free
// text, each such part is an UNRESOLVED proposition with the hard gap "unread", so the statement
// is not SUPPORTED. The checks are deliberately coarse: a correct sentence in words the checker
// does not read is rejected, never a wrong one accepted. Templates are the product's own
// sentences, written from structured results in this vocabulary, and are not held to it.

const NEGATION = /\b(?:not|never|neither|nor|without|cannot|none|no longer|no more|no less|no fewer)\b|n['’]t\b|\bno\b/i;
/** Negations the reader itself reads: a zero ("no paid customers"), "no evidenced channel", a readiness, trust or payment status. */
const READ_NEGATION: RegExp[] = [
  /\b(?:none|no)\b(?=\s+(?:(?:[A-Za-z][\w-]*\s+){0,2}?)(?:spend|customers|payments|refunds|prospects|revenue|cash|collections)\b)/gi,
  /\bno (?:evidenced |known )?channel\b|\bno paid touch\b/gi,
  /\bnot\s+(?:yet\s+)?(?:decision[- ]ready|ready to (?:move|shift|reallocate) (?:the )?budget|ready for (?:a )?budget (?:decisions?|moves?))\b/gi,
  /\bbudget signal\b[^.;]{0,40}?\bnot\s+(?:trustworthy|reliable|trusted|sound)\b/gi,
  /\b(?:has|have|had)\s+not\s+(?:yet\s+)?(?:paid|been paid)\b|\bnot\s+(?:yet\s+)?paid\b|\bno payments?\b/gi,
  // A feed that "has not synced": read as a staleness claim (statusProofs).
  /\b(?:has|have)\s+not\s+(?:synced|run|updated|refreshed|arrived)\b/gi,
  // Lineage, not a metric: "a campaign mapped to no branch", "a call with no tracking".
  /\b(?:mapped to|with|has|have|had)\s+no\s+(?:branch|campaign|lead(?: records?)?|tracking|source|mapping|call)\b/gi,
];
/** Verbs of change, rank or equality the reader has no direction or relation for. */
const UNREAD_VERB = /\b(?:surg(?:e|ed|es|ing)|soar\w*|plung\w*|plummet\w*|spik(?:e|ed|es|ing)|tumbl\w*|slipp(?:ed|ing)|slips?|dipp(?:ed|ing)|dips?|edged|ticked|rebound\w*|recover\w*|flat|flatlined|unchanged|steady|stable|stayed|remain(?:s|ed|ing)?|balloon\w*|crash\w*|collaps\w*|skyrocket\w*|rocket\w*|sank|sunk|slid|slump\w*|swell\w*|swollen|widen\w*|narrow\w*|improv\w*|worsen\w*|deteriorat\w*|outpac\w*|trail(?:s|ed)|overt(?:ook|ake\w*)|beat|beats|beating|topp(?:ed|ing)|rank\w*|offset\w*|wiped|erased)\b|\bexceed\w*\b(?!\s*[$\d])/i;
const RANK = /\b(?:lowest|highest|cheapest|priciest|most expensive|least expensive|largest|smallest|biggest|best|worst|top|bottom|first|last|record (?:high|low)|all[- ]time|most|least|fewest|maximum|minimum|peak|leading|second|third)\b/gi;
const READ_RANK = /\bat (?:least|most)\b|\blast month\b|\bfirst (?:evidenced )?touch\b/gi;
const CMP_WORD = /\b(?:than|versus|vs\.?|compared (?:with|to)|relative to|against)\s+/gi;
const CMP_TARGET = new RegExp(String.raw`^(?:(?:in|for|during|the|its|their|that of|those of|month of|it did in|it was in|they were in|they did in)\s+)*(?:B\d{2}\b|(?:${MONTH_WORD})\b|[$\d−~-]|(?:about|approximately|around|roughly|nearly|almost)\b)`, "i");
const OTHER_PERIOD = /\b(?:jan(?:uary)?|feb(?:ruary)?|march|apr(?:il)?|june?|july?|aug(?:ust)?|nov(?:ember)?|dec(?:ember)?|Q[1-4]|quarters?|quarterly|years?|yearly|annual\w*|ytd|year[- ]to[- ]date|weeks?|weekly|daily|per day|a day|each day|every day|today|yesterday|tomorrow|mtd|month[- ]to[- ]date|monthly|per month|a month|each month|every month|averag\w*|median|trailing|rolling|run[- ]rate|annuali[sz]ed|fiscal|season\w*|holiday\w*|spring|summer|winter|autumn)\b/i;
/** "May" the month, not the modal "may": case-sensitive. */
const MAY = /\bMay\b(?!\s+(?:have|be|not|also|reflect|indicate|explain|mean|suggest)\b)/;
/** The years the facts are about; any other year names a period they do not hold. */
const DATA_YEARS = new Set(Object.values(PERIODS).map((p) => String(p.from.getUTCFullYear())));
const LOWER_BRANCH = /\bb\d{2}\b|\b[Bb]ranch(?:es)?\s+(?:#|[Nn]o\.?\s*|number\s+)?\d{1,2}\b/;
const BRANCH_NAME = new RegExp(String.raw`\b(${BRANCHES.map((b) => escapeRe(b.name)).join("|")})(?:['’]s|\s+branch)\b`, "g");
const BRANCH_BY_NAME = new Map(BRANCHES.map((b) => [b.name, b.id]));
const COMPANY = /\b(?:company[- ]?wide|the (?:whole |entire )?company|across (?:the )?company|all (?:\d+ |of the |the |our )?branches|every branch|each branch|overall|network[- ]wide|nationwide|in total|altogether|combined|together)\b/i;
/** A brand named in lower case: the reader reads brands as proper nouns only. */
const LOWER_BRAND = /\b(?:moxie|mission|joshua)(?:['’]?s)?\b/;
const CUSTOMER_REF = /\b[Cc]ustomers?\s+#?\d{2,}\b/;
const CAMPAIGN_REF = /\b[Cc]ampaigns?\s+["“'‘]?([A-Za-z0-9][\w-]*\d[\w-]*|[A-Za-z0-9]+-[\w-]+)|\b([A-Z]{1,5}-\d{1,6})\b/g;
/** Channel names text may use, the cited ones and others: a channel the facts do not cover gets none of the branch's numbers. */
const CHANNEL_WORDS = [...new Set([
  ...Object.values(CHANNEL_ALIASES).flat(),
  "Performance Max", "PMax", "Google Ads", "Google Display", "Display ads", "YouTube", "TikTok", "Yelp", "Nextdoor", "Angi", "Thumbtack", "HomeAdvisor",
  "LinkedIn", "Pinterest", "Snapchat", "Direct mail", "Door-to-door", "door to door", "D2D", "Referral", "Referrals", "Organic",
])].sort((a, b) => b.length - a.length);
const OTHER_CURRENCY = /(?<![A-Za-z])(?!US\$)[A-Z]{1,3}\$|[€£¥₹₩]|\b(?:EUR|GBP|CAD|AUD|NZD|MXN|JPY|CNY|INR|CHF|SEK|NOK|DKK|BRL|ZAR|euros?|pounds?|yen|pesos?|rupees?|francs?)\b/;
const BIG_NUMBER_WORD = /\b(?:thirteen|fourteen|fifteen|sixteen|seventeen|eighteen|nineteen|twenty|thirty|forty|fifty|sixty|seventy|eighty|ninety|hundred|thousand|million|billion|trillion|dozens?)\b/gi;
const SMALL_NUMBER_WORD = /\b(?:zero|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b/gi;
/** Qualifiers that change what is measured: another metric, another base, a part of the period's figure. */
const MODIFIER = /\b(?:blended|recogni[sz]ed|profits?|profitab\w*|margins?|earnings|income|ebitda|ltv|lifetime value|arpu|aov|excluding|exclusive of|except|other than|apart from|aside from|not counting|ignoring|minus|including|inclusive of|plus|adjusted|normali[sz]ed|weighted|estimated|implied|true|real|actual|underlying|planned|benchmark|industry|per[- ]capita)\b/i;
const ONLY = /\b(?:from|by|in|at|via|through|on)\s+[^.;,]{1,30}?\s+(?:only|alone)\b|\b(?:only|solely|exclusively)\s+(?:from|by|via|through|on)\b/i;
/** Money "per customer" with a verb of cash: that is not CAC. */
const CASH_PER_CUSTOMER = /\b(?:collect\w*|earn\w*|revenue|cash|brought in|refund\w*|received)\b[^.;]{0,40}?\$[\d,.]+\s*(?:per|\/|for each|a|from each)\s+(?:(?:new|paid|paying|acquired)\s+)*customer/i;
/**
 * A cost per something other than a new customer acquired: "CAC per paying customer", "cost per
 * lead". CAC divides spend by acquisitions; a paying or active customer is another population
 * (R-38 test: "B09's paid-media CAC per paying customer was $250.00" was certified).
 */
const CAC_BASE = /\bper\s+(?:(?:new|paid)\s+)?(?:paying|active|returning|existing|recurring|subscribed|retained|invoiced|billed)\s+customers?\b|\bper\s+(?:leads?|calls?|prospects?|bookings?|appointments?|sales?|subscribers?|accounts?|households?|jobs?|visits?)\b/i;
/** A count of customers with a verb that is not acquisition: paying, invoiced, refunded, cancelled, converted. */
const CUSTOMER_VERB = /\b(?:customers?\s+(?:paid|pay|paying)\b|paying\b|payments?\s+from|paid\s+(?:us|B\d{2}|the branch)\b|invoic\w*|bill(?:ed|ing)\b|refund\w*|cancel\w*|churn\w*|became|become|becoming|convert\w*|conversions?|renew\w*|signed|booked|retain\w*|returning|repeat)\b/i;
/** The unknown share is a share of ALL new customers, not of spend or of paid customers. */
const SHARE_BASE = /%\s*(?:\([^)]*\)\s*)?of\s+(?:[\w'’]+\s+){0,4}?(?:paid(?:[- ]media)?\s+(?:spend|customers)|(?:paid |media |ad )?spend|revenue|collections?|cash|calls|leads|prospects|payments)\b/i;
const PRIMARY = new Set<Family>(["cac", "spend", "collected", "newCollected", "refunds", "gross", "atRisk", "prospects", "unknown"]);
const FAMILY_OF: Record<MetricKey, Family> = {
  paidCac: "cac", channelCac: "cac", paidSpend: "spend", campaignSpend: "spend", channelSpend: "spend", collected: "collected", newCollected: "newCollected",
  refunds: "refunds", grossCollected: "gross", atRisk: "atRisk", prospects: "prospects", unknownShare: "unknown", unknownAcquired: "unknown",
  paidAcquired: "paidCustomers", acquired: "customers", campaignAcquired: "customers", channelAcquired: "customers",
};
const COUNT_METRICS = new Set<MetricKey>(["acquired", "paidAcquired", "campaignAcquired", "channelAcquired", "unknownAcquired", "prospects"]);

/** Blanks every match of each pattern, positions kept. */
function blankAll(text: string, patterns: RegExp[]): string {
  return patterns.reduce((t, re) => t.replace(re, blank), text);
}

/**
 * What a piece of model text says that its proofs do not cover. `own` are the piece's proofs;
 * `statement` the proofs of the whole statement (arithmetic is read before the pieces).
 */
function closedReading(piece: string, own: Proof[], statement: Proof[], st: Statement): Proof[] {
  const reasons: string[] = [];
  const say = (reason: string) => reasons.push(reason);
  const proposition = (gap: Gap, reason: string): Proof => ({
    piece,
    figure: "",
    subject: { metric: null, entity: null, period: null },
    against: null,
    relation: "unknown",
    formula: "",
    inputs: [],
    unit: null,
    computed: null,
    claimed: null,
    qualifier: "exact",
    direction: null,
    claimedDirection: null,
    precision: 0,
    rounding: ROUNDING.exact,
    verdict: "UNRESOLVED",
    gap,
    reason,
  });
  const masked = maskNonQuantities(piece)
    .replace(/\b(?:campaigns?|raw events?|exceptions?|customers?|leads?|runs?|changes?|cases?|proposals?|payments?|tickets?|investigations?|incidents?|records?|subscriptions?|appointments?)\s+#?\d+\b|#\d+\b|@[\w.]+/gi, blank)
    .replace(new RegExp(String.raw`\b\d[\d,]*\s+of\s+(?=\d[\d,]*\b[^()]{0,80}\(\s*\d[\d.,]*\s*%)`, "g"), (m) => (own.some((p) => p.relation === "arithmetic") ? blank(m) : m));
  // A piece with no figure, measure or direction at all (an event, an explanation): nothing to
  // contradict, nothing proved. A hypothesis, not a finding; not a rejection either.
  const figs = figuresOf(piece);
  const substantive = own.length > 0 || figs.length > 0 || familyMentions(piece).length > 0 || directions(piece).length > 0 || /\d/.test(masked);
  if (!substantive) {
    return piece.split(/\s+/).length >= 3 ? [proposition("unproved", "model text that states no figure, measure or direction the checker proves: shown as a hypothesis, not a finding")] : [];
  }
  const relations = new Set(own.map((p) => p.relation));
  const extremum = own.some((p) => /^(?:min|max) over/.test(p.formula));
  const aggregate = own.some((p) => p.relation === "sum") || extremum;
  const metrics = new Set<MetricKey>([...own, ...statement].flatMap((p) => [...(p.subject.metric ? [p.subject.metric] : []), ...p.inputs.map((i) => i.metric)]));
  const bound = new Set<string>(
    [...own, ...statement].flatMap((p) => [
      ...(p.subject.entity ? p.subject.entity.split("+") : []),
      ...(p.against ? [p.against.entity] : []),
      ...p.inputs.map((i) => i.entity),
    ]),
  );
  for (const id of [...bound]) if (/^B\d{2}:/.test(id)) bound.add(id.slice(0, 3));
  // Read figures: those a proposition took, whole ("1.2 times") or as located. A figure located
  // but turned into no proposition was not read.
  const spans: Array<[number, number]> = figs.filter((f) => own.some((p) => p.figure === f.text)).map((f) => [f.start, f.end]);
  for (const p of own) {
    const at = p.figure ? piece.indexOf(p.figure) : -1;
    if (at >= 0) spans.push([at, at + p.figure.length]);
  }
  const covered = (s: number, e: number) => spans.some(([a, b]) => s < b && e > a);
  const status = relations.has("status") || relations.has("membership");

  // Negation the reader does not read inverts what it proved.
  if (!relations.has("membership") && NEGATION.test(blankAll(piece, READ_NEGATION))) say("a negation (\"not\", \"no\", \"n't\", \"without\") the checker does not read: what it proved may be the opposite of what is said");
  // Change, rank and comparison wording it has no relation for.
  const verb = UNREAD_VERB.exec(piece);
  if (verb) say(`"${verb[0]}" is not a change, rank or comparison the checker reads`);
  if (!extremum) {
    const rank = RANK.exec(blankAll(piece, [READ_RANK]));
    RANK.lastIndex = 0;
    if (rank) say(`"${rank[0]}" ranks or bounds a figure the checker does not compare`);
  }
  for (const m of piece.matchAll(CMP_WORD)) {
    const target = piece.slice((m.index ?? 0) + m[0].length, (m.index ?? 0) + m[0].length + 60);
    const channelTarget = st.channels.some((c) => c.names.some((n) => new RegExp(String.raw`^(?:(?:its|the|their)\s+)?${escapeRe(n)}\b`, "i").test(target)));
    if (!CMP_TARGET.test(target) && !channelTarget) {
      say(`compares with "${target.split(/[,;.]/)[0].trim()}", which is not a month, branch, channel or figure the checker reads`);
      break;
    }
  }
  const multiple = MULTIPLE.exec(piece);
  // A multiple the reader proved as a ratio named its other side; otherwise it must be a month or branch.
  if (multiple && !relations.has("ratio")) {
    const around = piece.slice(multiple.index + multiple[0].length, multiple.index + multiple[0].length + 50);
    if (!/\bB\d{2}\b/.test(around) && !new RegExp(String.raw`\b(?:${MONTH_WORD})\b`, "i").test(around)) say(`"${multiple[0]}" of something that is not another month or branch`);
  }
  // Periods it does not hold.
  const period = OTHER_PERIOD.exec(piece) ?? MAY.exec(piece);
  if (period) say(`"${period[0]}" is not a period the cited facts hold (they are September and October ${[...DATA_YEARS].join(", ")} figures)`);
  for (const y of piece.matchAll(/\b(?:19|20)\d{2}\b/g)) {
    if (!DATA_YEARS.has(y[0])) {
      say(`${y[0]} is not a year the cited facts hold`);
      break;
    }
  }
  // Entities it cannot place, or that no proposition is about.
  if (LOWER_BRANCH.test(piece)) say("a branch named in a form the checker does not read (branches are B01–B44)");
  if (LOWER_BRAND.test(piece)) say("a brand named in lower case, which the checker does not read as the brand");
  if (CUSTOMER_REF.test(piece)) say("names a customer; the cited facts are branch, channel and campaign metrics, not one customer's");
  if (COMPANY.test(piece) && !aggregate) say("speaks of the company or a total, but no proposition in it is about more than one branch");
  if (!relations.has("membership")) {
    // A branch id inside a campaign id ("lsa-B44") is part of the id, not a branch named (R-38 survey:
    // 279 correct sentences about campaigns were read as naming a branch no proposition was about).
    const named = new Set<string>([...piece.matchAll(/(?<![\w-])B\d{2}\b/g)].map((m) => m[0]));
    for (const m of piece.matchAll(BRANCH_NAME)) named.add(BRANCH_BY_NAME.get(m[1]) ?? m[1]);
    const unbound = [...named].filter((id) => !bound.has(id));
    if (unbound.length > 0) say(`names ${unbound.join(", ")}, which no proposition in it is about`);
  }
  const channelMentions: string[] = [];
  let rest = piece;
  for (const name of CHANNEL_WORDS) {
    const re = new RegExp(String.raw`(?<![\w-])${escapeRe(name)}(?![\w-])`, /[\s-]/.test(name) ? "gi" : "g");
    if (re.test(rest)) {
      channelMentions.push(name);
      rest = rest.replace(re, blank);
    }
  }
  // A readiness claim checks every channel it names itself (statusProofs).
  for (const name of status ? [] : channelMentions) {
    const ids = st.channels.filter((c) => c.names.some((n) => n.toLowerCase() === name.toLowerCase())).map((c) => c.id);
    if (!ids.some((id) => bound.has(id))) {
      say(`names the ${name} channel, which no proposition in it is about`);
      break;
    }
  }
  for (const m of piece.matchAll(CAMPAIGN_REF)) {
    const id = m[1] ?? m[2];
    if (!st.campaignIds.includes(id) || !bound.has(id)) {
      say(`names campaign ${id}, which no proposition in it is about`);
      break;
    }
  }
  // Money in another currency, and figures in a form the reader does not parse.
  const currency = OTHER_CURRENCY.exec(piece);
  if (currency) say(`"${currency[0]}" is not US dollars; amounts are never converted`);
  for (const m of masked.matchAll(/\d[\d,]*(?:\.\d+)?/g)) {
    const s = m.index ?? 0;
    if (!covered(s, s + m[0].length)) {
      say(`"${piece.slice(s, s + m[0].length)}" is a figure in a form the checker does not read`);
      break;
    }
  }
  for (const re of [BIG_NUMBER_WORD, SMALL_NUMBER_WORD]) {
    for (const m of piece.matchAll(re)) {
      const s = m.index ?? 0;
      if (!covered(s, s + m[0].length)) {
        say(`"${m[0]}" is a figure in words the checker does not read`);
        break;
      }
    }
  }
  // A measure no proposition covers ("its spend and its collections both rose"). A projection's
  // figures are not proved anyway (hypothetical), so its measure words are not held to this.
  if (!status && !own.some((p) => p.gap === "hypothetical")) {
    const proved = new Set<Family>([...metrics].map((k) => FAMILY_OF[k]));
    // A measure named as a source ("from payments synced through …") is not a second claim.
    const asSource = (m: Mention) => /\b(?:from|through|via|based on|out of)\s+(?:the\s+|its\s+|their\s+)?$/i.test(piece.slice(Math.max(0, m.start - 20), m.start));
    const missing = [...new Set(familyMentions(piece).filter((m) => !asSource(m)).map((m) => (m.family === "payments" ? "gross" : m.family)))].filter((f) => PRIMARY.has(f) && !proved.has(f));
    if (missing.length > 0) say(`mentions ${missing.join(", ")}, which no proposition in it is about`);
  }
  // Qualifiers and verbs that change the metric.
  const modifier = MODIFIER.exec(piece);
  if (modifier) say(`"${modifier[0]}" changes what is measured; the checker proves the product's own definitions only`);
  if (ONLY.test(piece)) say("restricts the figure to a part (\"only\", \"alone\") the facts do not break down");
  if (metrics.has("paidCac") && CASH_PER_CUSTOMER.test(piece)) say("money per customer named with a verb of cash: that is not the acquisition cost");
  if ((metrics.has("paidCac") || metrics.has("channelCac")) && CAC_BASE.test(piece)) say("a cost per something other than a new customer acquired: CAC divides spend by acquisitions");
  if ([...metrics].some((k) => COUNT_METRICS.has(k)) && CUSTOMER_VERB.test(piece)) say("counts customers with a verb that is not acquisition (paying, invoiced, refunded, cancelled, converted): the facts count acquisitions");
  if (metrics.has("unknownShare") && SHARE_BASE.test(piece)) say("a share of a base the unknown share does not use (it is a share of all new customers)");
  // Nothing proved, yet something asserted.
  if (own.length === 0 && reasons.length === 0) {
    const asserts = familyMentions(piece).length > 0 || figs.length > 0 || /\d/.test(masked) || directions(piece).length > 0 || READY.test(piece) || TRUST.test(piece) || COMPLETE.test(piece);
    if (asserts) say("states something about the business that the checker cannot read");
  }
  return reasons.slice(0, 4).map((reason) => proposition("unread", `model text: ${reason}; what was not read was not proved`));
}

// ── Entry points ─────────────────────────────────────────────────────────────

/** The channels the cited facts cover, with every name text may use for them. */
function channelsOf(facts: MetricFact[]): Channel[] {
  const out = new Map<string, Channel>();
  for (const f of facts) {
    if (f.entity.type !== "channel" || out.has(f.entity.id)) continue;
    const [branch, code] = f.entity.id.split(":");
    const names = [...new Set([f.entity.label ?? code, ...(CHANNEL_ALIASES[code] ?? []), code.replace(/_/g, " ")])].sort((a, b) => b.length - a.length);
    out.set(f.entity.id, { id: f.entity.id, branch, code, names });
  }
  return [...out.values()];
}

/**
 * A period the evidence cannot hold: a month other than September or October, or a year other
 * than 2026, named outside quotes. The reading below only knows September and October; before
 * this check, "B03's CAC in August 2026 was $140.00" fell back to October and was judged
 * against October's figure (Shadow pack first contact, SH-11). "May" counts only with a year
 * ("may be" is not a month).
 */
const FOREIGN_MONTH = /\b(?:january|february|march|april|june|july|august|november|december|jan|feb|mar|apr|jun|jul|aug|nov|dec)\b\.?|\bmay\s+(?:19|20)\d{2}\b/i;
/** A year other than 2026, only where it reads as a year ("in 2025", "October 2025"), never a bare figure like "$2050". */
const FOREIGN_YEAR = /\b(?:in|of|for|during|since|from|september|sept|sep|october|oct)\s+(?:19|20)(?!26\b)\d{2}\b/i;

export function foreignPeriod(piece: string): string | null {
  const text = maskQuoted(piece);
  return FOREIGN_MONTH.exec(text)?.[0].trim() ?? FOREIGN_YEAR.exec(text)?.[0] ?? null;
}

/** Proves every figure, direction, status and membership a statement asserts against the facts it cites. */
export function proveStatement(text: string, ctx: ProveContext): Proof[] {
  const st: Statement = {
    facts: ctx.facts,
    status: ctx.status,
    campaignIds: [...new Set(ctx.facts.filter((f) => f.entity.type === "campaign").map((f) => f.entity.id))],
    channels: channelsOf(ctx.facts),
    subjectBranch: /\bB\d{2}\b/.exec(text)?.[0] ?? ctx.branchId,
    quotesAreNames: ctx.origin === "template",
  };
  const { rest, proofs } = extractArithmetic(text, st);
  const arithmetic = [...proofs];
  const carry: Carry = { family: null, period: null, branch: st.subjectBranch, group: null };
  for (const piece of splitPieces(rest)) {
    const foreign = foreignPeriod(piece);
    // A piece about a period the evidence does not hold proves nothing and contradicts nothing:
    // whatever its figures were read against, it was not that period.
    const own = provePiece(piece, st, carry).map((p): Proof =>
      foreign && p.verdict !== "UNRESOLVED"
        ? { ...p, verdict: "UNRESOLVED", gap: "period_missing", reason: `it names ${foreign}; the evidence holds September and October 2026 only, so this cannot be checked` }
        : p,
    );
    proofs.push(...own);
    if (ctx.origin === "model") proofs.push(...closedReading(piece, own, arithmetic, st));
  }
  return proofs;
}

/** The facts a claim cites: those whose evidence ids intersect the claim's. */
export function citedFacts(facts: MetricFact[], evidenceIds: readonly string[]): MetricFact[] {
  const cited = new Set(evidenceIds);
  return facts.filter((f) => f.evidenceIds.some((id) => cited.has(id)));
}

/** Who wrote the sentence: a template filled from structured results, or the model. */
export type ProofOrigin = "template" | "model";

const HARD_GAPS: ReadonlySet<Gap> = new Set<Gap>(["metric_unsupported", "fact_missing", "period_missing", "period_ambiguous", "comparison_missing", "currency_unresolved", "undefined_value", "operand_missing", "conflicting_facts", "evaluative", "evidence_stale", "unread"]);

export interface Judgement {
  status: "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED";
  reason: string;
  /** The proposition that decided it, when it was not every one verifying. */
  decisive: Proof | null;
}

/**
 * What the proofs mean for a claim.
 * - Any contradiction: UNSUPPORTED (whoever wrote it).
 * - Model-written, with a hard gap (the cited evidence cannot establish the proposition): UNSUPPORTED.
 * - Tools that disagree, or money whose currency is not established: at best PARTIALLY_SUPPORTED.
 * - Model-written, with a soft gap (a figure outside the metric vocabulary, an ambiguous or
 *   conditional reading): PARTIALLY_SUPPORTED — shown with its limitation, never as verified.
 * - Template-written, with any proposition not proved: PARTIALLY_SUPPORTED. A sentence the
 *   product wrote is not certified for that reason; it is certified when every figure and status
 *   it states is proved, whether against a metric fact or against the record field it renders
 *   (lib/ai/rendered.ts). Before R-38 a template was trusted unless contradicted, so a sentence
 *   with an unproved part read as verified ("supported" beside "0 of 2 propositions follow").
 *   A hard gap does not drop a template's sentence as it drops the model's: its figures were
 *   copied from structured results, so it is shown with the limitation instead.
 * - Every proposition verified: SUPPORTED.
 * - Model-written with nothing to prove: PARTIALLY_SUPPORTED. The model is never the only
 *   verifier, so its text is SUPPORTED only by a proof (review 2026-11-12, AI-claims shared root:
 *   a "verified" sentence the checker could not read was certified).
 * Null when a template asserts nothing the checker can test: a statement of what a cited record
 * says, with no figure, status or direction in it.
 */
export function judge(proofs: Proof[], origin: ProofOrigin): Judgement | null {
  if (proofs.length === 0) {
    return origin === "model" ? { status: "PARTIALLY_SUPPORTED", reason: "nothing in it is a proposition the checker proves, so it is not a finding", decisive: null } : null;
  }
  const why = (p: Proof) => `${p.figure ? `${p.figure}: ` : ""}${p.reason}`;
  const contradicted = proofs.find((p) => p.verdict === "CONTRADICTED");
  if (contradicted) return { status: "UNSUPPORTED", reason: why(contradicted), decisive: contradicted };
  const hard = proofs.find((p) => p.verdict === "UNRESOLVED" && p.gap !== null && HARD_GAPS.has(p.gap));
  if (hard && origin === "model") return { status: "UNSUPPORTED", reason: why(hard), decisive: hard };
  const doubtful = proofs.find((p) => p.gap === "currency_unresolved" || p.gap === "conflicting_facts");
  if (doubtful) return { status: "PARTIALLY_SUPPORTED", reason: why(doubtful), decisive: doubtful };
  const soft = proofs.find((p) => p.verdict === "UNRESOLVED");
  if (soft && origin === "model") return { status: "PARTIALLY_SUPPORTED", reason: why(soft), decisive: soft };
  if (soft) {
    const proved = proofs.filter((p) => p.verdict === "VERIFIED").length;
    return { status: "PARTIALLY_SUPPORTED", reason: `written from a calculation, but not certified: ${proved} of ${proofs.length} propositions are proved; ${why(hard ?? soft)}`, decisive: hard ?? soft };
  }
  // Right as stored, but the facts leave records out: model text stating it plainly is a
  // limitation, not a finding (templates state the held records in their own sentence).
  const incomplete = proofs.find((p) => p.verdict === "VERIFIED" && p.inputs.some((i) => i.incompleteReason));
  if (incomplete && origin === "model") return { status: "PARTIALLY_SUPPORTED", reason: `${incomplete.figure ? `${incomplete.figure}: ` : ""}correct as stored, but ${incomplete.inputs.find((i) => i.incompleteReason)?.incompleteReason}`, decisive: incomplete };
  return { status: "SUPPORTED", reason: "every proposition follows from the cited facts", decisive: null };
}
