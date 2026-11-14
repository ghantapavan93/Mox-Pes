import { chromium, type Browser, type Page } from "@playwright/test";
import pg from "pg";
import { createPool, DEFAULT_DATABASE_URL, getNow } from "@/lib/db";
import { AA_DEFAULTS, listExperiments, runAaExperiment } from "@/lib/decision/experiment";
import { listScenarios } from "@/lib/decision/scenario";
import { decisionVerdicts } from "@/lib/decision/verdicts";
import { verifiedReadinessSnapshot } from "@/lib/decision/verified";
import { freshness } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { VIEWERS, type Role } from "@/lib/viewer";

/**
 * R-34, Decision Lab: how long until the hold (or go-ahead), its reason and its evidence link are
 * usable, split by layer. Measures a running production server (BASE_URL) and its database;
 * changes nothing.
 *
 *   npx tsx scripts/measure-decision-lab.ts db        the page's reads as the page issues them
 *                                                     (when each finished), each alone, and the
 *                                                     slowest read's SQL statements in order
 *   npx tsx scripts/measure-decision-lab.ts server    one HTTP request: first byte, the chunk that
 *                                                     carries the hold and its link, the later
 *                                                     cards' chunks, end of stream
 *   npx tsx scripts/measure-decision-lab.ts direct    headless Chromium: page.goto(the Decision
 *                                                     Lab) until the hold is usable
 *   npx tsx scripts/measure-decision-lab.ts nav       the branch page's "Decision readiness…" link
 *                                                     (a client navigation) until usable
 *   npx tsx scripts/measure-decision-lab.ts snapshot  what the page shows once every card has
 *                                                     loaded: text with every <details> open, links,
 *                                                     branch choices, scope (not a timing)
 *   npx tsx scripts/measure-decision-lab.ts decision  the library's decision objects for the
 *                                                     scenario, as JSON (not a timing)
 *
 * Usable means all three, at one moment, in the visible document (not the hidden streamed
 * segment, not the skeleton):
 *   1. the hold: the readiness summary with its "Ready" or "Not ready" badge;
 *   2. its reason: the summary's sentence, and for a scenario with a blocking incident the
 *      "Blocking incident #…" line;
 *   3. its evidence link: the summary's first "open incident →" link, with an /exceptions/<id>
 *      href, not covered by another element.
 * Also recorded, not part of "usable": when React has attached to that link (a click is then a
 * client navigation; before it, a plain link that still works), and when the verified-readiness
 * card and the A/A card became visible.
 *
 * SCENARIO=b09 (default: marketing, all branches, B09 in October, one blocking incident), b40
 * (the brand lead, five branches, B40: no incident) or b20 (the branch partner, B20 only).
 * RUNS (default 1). WIDTH × HEIGHT (default 1280 × 800). One JSON line per run; milliseconds.
 */

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const RUNS = Number(process.env.RUNS ?? 1);
const WIDTH = Number(process.env.WIDTH ?? 1280);
const HEIGHT = Number(process.env.HEIGHT ?? 800);

interface Scenario {
  role: Role;
  branchId: string;
  period: "oct" | "sep";
  /** The page a person comes from in the `nav` layer. */
  from: string;
  /** True when the hold names a blocking incident, so its link is part of "usable". */
  blockingIncident: boolean;
}

const SCENARIOS: Record<string, Scenario> = {
  // The flagship: every paid channel held by the Local Services coverage gap.
  b09: { role: "marketing", branchId: "B09", period: "oct", from: "/branches/B09?period=oct", blockingIncident: true },
  // The contrast: the brand lead (five branches) on their default branch. No incident; a trusted
  // budget signal; one channel held back for too few customers.
  b40: { role: "brand", branchId: "B40", period: "oct", from: "/branches/B40?period=oct", blockingIncident: false },
  // A branch partner (one branch) whose hold is a different incident: quarantined call records.
  b20: { role: "partner", branchId: "B20", period: "oct", from: "/branches/B20?period=oct", blockingIncident: true },
};
const SCENARIO_KEY = process.env.SCENARIO ?? "b09";
const SC = SCENARIOS[SCENARIO_KEY];
if (!SC) throw new Error(`SCENARIO: ${Object.keys(SCENARIOS).join(" | ")}`);
const PATH = `/decisions?branch=${SC.branchId}&period=${SC.period}`;

// ── database ────────────────────────────────────────────────────────────────

interface Statement {
  sql: string;
  start: number;
  ms: number;
}

/** Records every statement any pg client runs (pool.query goes through Client#query too). */
function recordStatements(): { take: (t0: number) => Statement[] } {
  const log: Array<{ sql: string; start: number; end: number }> = [];
  const proto = pg.Client.prototype as unknown as { query: (...args: unknown[]) => unknown };
  const original = proto.query;
  proto.query = function (this: unknown, ...args: unknown[]) {
    const result = original.apply(this, args);
    const first = args[0];
    const text = typeof first === "string" ? first : ((first as { text?: string } | null)?.text ?? "");
    if (result && typeof (result as Promise<unknown>).then === "function") {
      const start = performance.now();
      const entry = { sql: text.replace(/\s+/g, " ").trim().slice(0, 90), start, end: start };
      log.push(entry);
      (result as Promise<unknown>).then(
        () => (entry.end = performance.now()),
        () => (entry.end = performance.now()),
      );
    }
    return result;
  };
  return {
    take: (t0) => {
      const out = log.splice(0).map((s) => ({ sql: s.sql, start: Math.round(s.start - t0), ms: Math.round(s.end - s.start) }));
      return out;
    },
  };
}

async function db() {
  const statements = recordStatements();
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const viewer = VIEWERS[SC.role];
  const period = PERIODS[SC.period];
  const args = { branchId: SC.branchId, period };
  const timed = async <T>(fn: () => Promise<T>) => {
    const t0 = performance.now();
    await fn();
    return Math.round(performance.now() - t0);
  };
  try {
    for (let run = 1; run <= RUNS; run++) {
      // As the layout and app/decisions/page.tsx issue them: the shell's freshness and clock, the
      // verified-readiness snapshot first, then the verdicts card's and the A/A card's reads.
      // Each value is when that read FINISHED, counted from the start of the batch.
      const t0 = performance.now();
      const at = <T>(name: string, p: Promise<T>) => p.then(() => [name, Math.round(performance.now() - t0)] as const);
      const finished = await Promise.all([
        at("layout:freshness", freshness(pool)),
        at("layout:now", getNow(pool)),
        at("verifiedReadinessSnapshot", verifiedReadinessSnapshot(pool, viewer, args)),
        at("decisionVerdicts", decisionVerdicts(pool, viewer, args)),
        at("listScenarios", listScenarios(pool, viewer, { branchId: SC.branchId, limit: 10 })),
        at("runAaExperiment", runAaExperiment(pool, viewer, { period: SC.period, windowDays: AA_DEFAULTS.windowDays, salt: AA_DEFAULTS.salt })),
        at("listExperiments", listExperiments(pool, viewer)),
      ]);
      const wall = Math.round(performance.now() - t0);
      statements.take(t0);
      const alone = {
        decisionVerdicts: await timed(() => decisionVerdicts(pool, viewer, args)),
        runAaExperiment: await timed(() => runAaExperiment(pool, viewer, { period: SC.period, windowDays: AA_DEFAULTS.windowDays, salt: AA_DEFAULTS.salt })),
        verifiedReadinessSnapshot: 0,
      };
      statements.take(0);
      const v0 = performance.now();
      await verifiedReadinessSnapshot(pool, viewer, args);
      alone.verifiedReadinessSnapshot = Math.round(performance.now() - v0);
      const verifiedStatements = statements.take(v0);
      console.log(JSON.stringify({ mode: "db", scenario: SCENARIO_KEY, run, finishedAt: Object.fromEntries(finished), wall, alone, verifiedStatements }));
    }
  } finally {
    await pool.end();
  }
}

// ── server ──────────────────────────────────────────────────────────────────

async function roleCookie(): Promise<string> {
  const res = await fetch(`${BASE}/api/role`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: SC.role }) });
  return (res.headers.get("set-cookie") ?? "").split(";")[0];
}

const MARKERS = {
  hold: 'data-testid="readiness-summary"',
  holdLink: 'data-testid="readiness-incident-link"',
  verdicts: 'data-testid="verdict-row-',
  aa: 'id="experiments"',
  verified: 'data-testid="verified-readiness"',
} as const;

async function server() {
  const cookie = await roleCookie();
  for (let run = 1; run <= RUNS; run++) {
    const t0 = performance.now();
    const res = await fetch(`${BASE}${PATH}`, { headers: { cookie } });
    const firstByte = Math.round(performance.now() - t0);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let chunks = 0;
    const at: Partial<Record<keyof typeof MARKERS, number>> = {};
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks++;
      text += decoder.decode(value, { stream: true });
      const ms = Math.round(performance.now() - t0);
      for (const [key, marker] of Object.entries(MARKERS) as Array<[keyof typeof MARKERS, string]>) {
        if (at[key] === undefined && text.includes(marker)) at[key] = ms;
      }
    }
    console.log(JSON.stringify({ mode: "server", scenario: SCENARIO_KEY, run, status: res.status, firstByte, ...at, end: Math.round(performance.now() - t0), chunks, bytes: text.length }));
  }
}

// ── browser ─────────────────────────────────────────────────────────────────

interface LabMarks {
  holdInDom: number | null;
  holdVisible: number | null;
  usable: number | null;
  linkHydrated: number | null;
  verifiedVisible: number | null;
  aaVisible: number | null;
  reason: string | null;
  href: string | null;
}

/** Records, in the page, when the hold, its reason and its link first sit in the visible document. */
const WATCH = `(() => {
  const w = window;
  const marks = (w.__lab = { holdInDom: null, holdVisible: null, usable: null, linkHydrated: null, verifiedVisible: null, aaVisible: null, reason: null, href: null });
  const needsLink = ${JSON.stringify(SC.blockingIncident)};
  const visible = (el) => {
    if (!el || !el.isConnected || el.offsetParent === null) return false;
    const r = el.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(el).visibility !== "hidden";
  };
  const uncovered = (el) => {
    const r = el.getBoundingClientRect();
    const x = r.left + Math.min(r.width / 2, 8), y = r.top + r.height / 2;
    if (y < 0 || y > innerHeight || x < 0 || x > innerWidth) return true; // below the fold: reachable by scrolling
    const hit = document.elementFromPoint(x, y);
    return hit !== null && (hit === el || el.contains(hit));
  };
  const hydrated = (el) => Object.keys(el).some((k) => k.startsWith("__reactProps$"));
  const check = () => {
    const now = performance.now();
    const hold = document.querySelector('[data-testid="readiness-summary"]');
    if (hold && marks.holdInDom === null) marks.holdInDom = now;
    // The badge is the paragraph's first element: "Ready" or "Not ready".
    const badge = hold && hold.querySelector("p > span");
    if (hold && visible(hold) && badge !== null && visible(badge) && /^(Not ready|Ready)$/.test(badge.textContent.trim())) {
      if (marks.holdVisible === null) marks.holdVisible = now;
      // The sentence after the badge (the badge is font-medium too, so match on its colour class).
      const sentence = hold.querySelector("p > span.text-text");
      const line = [...hold.querySelectorAll("li")].find((li) => li.textContent.includes("Blocking incident #"));
      const link = hold.querySelector('[data-testid="readiness-incident-link"]');
      const reasonOk = sentence !== null && visible(sentence) && sentence.textContent.trim().length > 0 && (!needsLink || (line !== undefined && visible(line)));
      const linkOk = !needsLink || (link !== null && visible(link) && /^\\/exceptions\\/\\d+$/.test(link.getAttribute("href") || "") && uncovered(link));
      if (marks.usable === null && reasonOk && linkOk) {
        marks.usable = now;
        marks.reason = (line || sentence).textContent.trim().slice(0, 160);
        marks.href = link ? link.getAttribute("href") : null;
      }
      if (link && marks.linkHydrated === null && hydrated(link)) marks.linkHydrated = now;
    }
    if (marks.verifiedVisible === null && visible(document.querySelector('[data-testid="verified-readiness"] li'))) marks.verifiedVisible = now;
    if (marks.aaVisible === null && visible(document.querySelector("section#experiments"))) marks.aaVisible = now;
  };
  new MutationObserver(check).observe(document, { childList: true, subtree: true, attributes: true, characterData: true });
  // Visibility can also change without a mutation (layout); a frame loop covers that until done.
  const frame = () => { check(); if (marks.usable === null || marks.linkHydrated === null || marks.verifiedVisible === null || marks.aaVisible === null) requestAnimationFrame(frame); };
  requestAnimationFrame(frame);
})();`;

const marksOf = (page: Page) => page.evaluate(() => (window as unknown as { __lab: LabMarks }).__lab);
const round = (v: number | null) => (v === null ? null : Math.round(v));

async function waitForAll(page: Page) {
  await page.waitForFunction(() => (window as unknown as { __lab: LabMarks }).__lab.usable !== null, null, { timeout: 60_000 });
  // The rest of the page, for context and so the next run starts from a quiet server.
  // A hold without a blocking incident has no link to hydrate.
  await page.waitForFunction(
    (needsLink) => {
      const m = (window as unknown as { __lab: LabMarks }).__lab;
      return m.verifiedVisible !== null && m.aaVisible !== null && (m.linkHydrated !== null || !needsLink);
    },
    SC.blockingIncident,
    { timeout: 60_000 },
  );
  await page.waitForLoadState("load");
}

/**
 * A just-launched Chromium paints its first page about 1.2 s late whatever the page is (measured
 * 2026-11-13: first paint 1,316 ms on the first page, 120–168 ms on the next ones, the same
 * stylesheet loaded by 28 ms each time). React reveals the first streamed boundaries on the first
 * frame, so that cost would land on run 1 only. A local page painted first absorbs it, so every
 * run measures the app, not the browser's start-up; it never touches the server.
 */
async function warmUp(b: Browser) {
  const context = await b.newContext();
  const page = await context.newPage();
  await page.setContent("<p>warm-up</p>");
  await page.evaluate("new Promise((resolve) => requestAnimationFrame(() => requestAnimationFrame(resolve)))");
  await context.close();
}

async function browser(mode: "direct" | "nav") {
  const b = await chromium.launch();
  try {
    await warmUp(b);
    for (let run = 1; run <= RUNS; run++) {
      const context = await b.newContext({ baseURL: BASE, viewport: { width: WIDTH, height: HEIGHT } });
      await context.request.post("/api/role", { data: { role: SC.role } });
      const page = await context.newPage();
      page.on("pageerror", (error) => console.error(`pageerror (run ${run}): ${error.message}`));
      await page.addInitScript(WATCH);
      let out: Record<string, unknown>;
      if (mode === "direct") {
        const wall0 = Date.now();
        await page.goto(PATH, { waitUntil: "commit" });
        await page.waitForFunction(() => (window as unknown as { __lab: LabMarks }).__lab.usable !== null, null, { timeout: 60_000 });
        const wall = Date.now() - wall0;
        await waitForAll(page);
        const m = await marksOf(page);
        const nav = await page.evaluate(() => {
          const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
          return { ttfb: n.responseStart, htmlEnd: n.responseEnd, domContentLoaded: n.domContentLoadedEventEnd, load: n.loadEventEnd };
        });
        out = {
          mode, scenario: SCENARIO_KEY, width: WIDTH, run, wall,
          ttfb: round(nav.ttfb), holdInDom: round(m.holdInDom), holdVisible: round(m.holdVisible), usable: round(m.usable),
          linkHydrated: round(m.linkHydrated), domContentLoaded: round(nav.domContentLoaded), aaVisible: round(m.aaVisible),
          verifiedVisible: round(m.verifiedVisible), htmlEnd: round(nav.htmlEnd), load: round(nav.load), reason: m.reason, href: m.href,
        };
      } else {
        await page.goto(SC.from);
        const link = page.getByRole("link", { name: "Decision readiness and effectiveness per channel →" });
        await link.waitFor({ state: "visible", timeout: 60_000 });
        // A person reads the branch page first: let it finish loading and hydrate.
        await page.waitForLoadState("networkidle");
        await page.waitForFunction(() => {
          const a = [...document.querySelectorAll("a")].find((x) => x.textContent?.includes("Decision readiness and effectiveness per channel"));
          return a !== undefined && Object.keys(a).some((k) => k.startsWith("__reactProps$"));
        });
        const t0 = await page.evaluate(() => performance.now());
        const wall0 = Date.now();
        await link.click();
        await page.waitForFunction(() => (window as unknown as { __lab: LabMarks }).__lab.usable !== null, null, { timeout: 60_000 });
        const wall = Date.now() - wall0;
        await waitForAll(page);
        const m = await marksOf(page);
        const after = (v: number | null) => (v === null ? null : Math.round(v - t0));
        out = {
          mode, scenario: SCENARIO_KEY, width: WIDTH, run, wall,
          holdInDom: after(m.holdInDom), holdVisible: after(m.holdVisible), usable: after(m.usable), linkHydrated: after(m.linkHydrated),
          aaVisible: after(m.aaVisible), verifiedVisible: after(m.verifiedVisible), url: new URL(page.url()).pathname + new URL(page.url()).search,
          reason: m.reason, href: m.href,
        };
      }
      console.log(JSON.stringify(out));
      await context.close();
    }
  } finally {
    await b.close();
  }
}

// ── what the page decides (before/after comparison) ─────────────────────────

async function snapshot() {
  const b = await chromium.launch();
  try {
    const context = await b.newContext({ baseURL: BASE, viewport: { width: WIDTH, height: HEIGHT } });
    await context.request.post("/api/role", { data: { role: SC.role } });
    const page = await context.newPage();
    await page.addInitScript(WATCH);
    await page.goto(PATH);
    await waitForAll(page);
    // A string, not a function: tsx would wrap a named inner function in a helper the page lacks.
    const shown = (await page.evaluate(`(() => {
      for (const d of document.querySelectorAll("main details")) d.open = true;
      const text = (sel) => { const el = document.querySelector(sel); return el ? el.innerText.trim() : null; };
      return {
        scope: text('[data-testid="scope-indicator"]'),
        branchChoices: [...document.querySelectorAll('select[name="branch"] option')].map((o) => o.value),
        hold: text('[data-testid="readiness-summary"]'),
        verdicts: text("#verdicts"),
        verified: text("#verified"),
        scenarios: text("#scenarios"),
        experiments: text("#experiments"),
        links: [...document.querySelectorAll("main a[href]")].map((a) => a.getAttribute("href")),
      };
    })()`)) as Record<string, unknown>;
    console.log(JSON.stringify({ mode: "snapshot", scenario: SCENARIO_KEY, path: PATH, role: SC.role, ...shown }));
    await context.close();
  } finally {
    await b.close();
  }
}

async function decision() {
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const viewer = VIEWERS[SC.role];
  const args = { branchId: SC.branchId, period: PERIODS[SC.period] };
  try {
    const [verdicts, verified, aa, scenarios, experiments] = await Promise.all([
      decisionVerdicts(pool, viewer, args),
      verifiedReadinessSnapshot(pool, viewer, args),
      runAaExperiment(pool, viewer, { period: SC.period, windowDays: AA_DEFAULTS.windowDays, salt: AA_DEFAULTS.salt }),
      listScenarios(pool, viewer, { branchId: SC.branchId, limit: 10 }),
      listExperiments(pool, viewer),
    ]);
    console.log(JSON.stringify({ mode: "decision", scenario: SCENARIO_KEY, role: SC.role, verdicts, verified, aa, scenarios, experiments }));
  } finally {
    await pool.end();
  }
}

const mode = process.argv[2];
const job =
  mode === "db" ? db()
  : mode === "server" ? server()
  : mode === "direct" || mode === "nav" ? browser(mode)
  : mode === "snapshot" ? snapshot()
  : mode === "decision" ? decision()
  : Promise.reject(new Error("mode: db | server | direct | nav | snapshot | decision"));
job.catch((error) => {
  console.error(error);
  process.exit(1);
});
