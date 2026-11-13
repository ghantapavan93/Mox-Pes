import { chromium, type Page } from "@playwright/test";
import { createPool, DEFAULT_DATABASE_URL } from "@/lib/db";
import { brandRows } from "@/lib/metrics/brands";
import { decisionHolds } from "@/lib/metrics/decision";
import { branchRows, conversionBridge, freshness, totals } from "@/lib/metrics/scorecard";
import { PERIODS } from "@/lib/period";
import { weeklySeries } from "@/lib/queries";

/**
 * R-34: how long until the Overview's B09 decision hold is usable, split by layer. Measures a
 * running production server (BASE_URL) and its database; changes nothing.
 *
 *   npx tsx scripts/measure-overview.ts db       the Overview's reads, concurrently as the page
 *                                                 issues them, then each alone
 *   npx tsx scripts/measure-overview.ts server   one HTTP request: first byte, the chunk that
 *                                                 carries the holds, end of stream
 *   npx tsx scripts/measure-overview.ts direct   headless Chromium: page.goto("/") until the B09
 *                                                 hold is visible
 *   npx tsx scripts/measure-overview.ts guide    /demo → "Start" (a client navigation) until the
 *                                                 B09 hold is visible
 *
 * RUNS (default 1). Each run prints one JSON line. Timings are milliseconds.
 */

const BASE = process.env.BASE_URL ?? "http://localhost:3000";
const RUNS = Number(process.env.RUNS ?? 1);
const HOLD_TEXT = "Google Local Services spend at B09 stopped";

async function db() {
  const pool = createPool(process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL);
  const scope = { from: PERIODS.oct.from, to: PERIODS.oct.to, branchIds: null };
  const compare = { from: PERIODS.sep.from, to: PERIODS.sep.to, branchIds: null };
  const timed = async (fn: () => Promise<unknown>) => {
    const t0 = performance.now();
    await fn();
    return Math.round(performance.now() - t0);
  };
  try {
    for (let run = 1; run <= RUNS; run++) {
      // As app/page.tsx does it: every read at once (brand lines from the branch rows once those
      // are ready), then the period's totals from the rows. Each value is when that read FINISHED,
      // counted from the start of the batch.
      const t0 = performance.now();
      const at = (p: Promise<unknown>) => p.then(() => Math.round(performance.now() - t0));
      const rowsReady = branchRows(pool, scope);
      const finished = await Promise.all([
        at(rowsReady).then((ms) => ["branchRows", ms] as const),
        at(conversionBridge(pool, scope)).then((ms) => ["conversionBridge", ms] as const),
        at(freshness(pool)).then((ms) => ["freshness", ms] as const),
        at(decisionHolds(pool, null)).then((ms) => ["decisionHolds", ms] as const),
        at(rowsReady.then((rows) => brandRows(pool, scope, rows))).then((ms) => ["brandRows", ms] as const),
        at(weeklySeries(pool, null)).then((ms) => ["weeklySeries", ms] as const),
        at(totals(pool, compare)).then((ms) => ["totals(sep)", ms] as const),
        at(freshness(pool)).then((ms) => ["freshness(layout)", ms] as const),
      ]);
      const tTotals = await timed(async () => totals(pool, scope, await rowsReady));
      const wall = Math.round(performance.now() - t0);
      const rows = await rowsReady;
      const alone = {
        branchRows: await timed(() => branchRows(pool, scope)),
        brandRowsFromRows: await timed(() => brandRows(pool, scope, rows)),
        brandRowsRecomputed: await timed(() => brandRows(pool, scope)),
        decisionHolds: await timed(() => decisionHolds(pool, null)),
      };
      console.log(JSON.stringify({ mode: "db", run, finishedAt: Object.fromEntries(finished), totalsAfter: tTotals, wall, alone }));
    }
  } finally {
    await pool.end();
  }
}

async function roleCookie(): Promise<string> {
  const res = await fetch(`${BASE}/api/role`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ role: "marketing" }) });
  const set = res.headers.get("set-cookie") ?? "";
  return set.split(";")[0];
}

async function server() {
  const cookie = await roleCookie();
  for (let run = 1; run <= RUNS; run++) {
    const t0 = performance.now();
    const res = await fetch(`${BASE}/`, { headers: { cookie } });
    const firstByte = Math.round(performance.now() - t0);
    const reader = res.body!.getReader();
    const decoder = new TextDecoder();
    let text = "";
    let holdsAt: number | null = null;
    let holdTextAt: number | null = null;
    const chunks: number[] = [];
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      chunks.push(Math.round(performance.now() - t0));
      text += decoder.decode(value, { stream: true });
      if (holdsAt === null && text.includes('data-testid="decision-holds"')) holdsAt = Math.round(performance.now() - t0);
      if (holdTextAt === null && text.includes(HOLD_TEXT)) holdTextAt = Math.round(performance.now() - t0);
    }
    console.log(JSON.stringify({ mode: "server", run, status: res.status, firstByte, holdsChunk: holdsAt, holdText: holdTextAt, end: Math.round(performance.now() - t0), chunks: chunks.length, bytes: text.length }));
  }
}

/** Records, in the page, when the hold first sits in the visible document. */
const WATCH = `(() => {
  const w = window; w.__r34 = { visibleAt: null, inDomAt: null };
  const check = () => {
    const list = document.querySelector('[data-testid="decision-holds"]');
    const li = list && [...list.querySelectorAll('li')].find((l) => l.textContent.includes(${JSON.stringify(HOLD_TEXT)}));
    if (li && w.__r34.inDomAt === null) w.__r34.inDomAt = performance.now();
    if (li && w.__r34.visibleAt === null) {
      const r = li.getBoundingClientRect();
      if (li.offsetParent !== null && r.height > 0) w.__r34.visibleAt = performance.now();
    }
  };
  new MutationObserver(check).observe(document, { childList: true, subtree: true, attributes: true });
})();`;

async function browser(mode: "direct" | "guide") {
  const b = await chromium.launch();
  try {
    for (let run = 1; run <= RUNS; run++) {
      const context = await b.newContext({ baseURL: BASE });
      await context.request.post("/api/role", { data: { role: "marketing" } });
      const page: Page = await context.newPage();
      await page.addInitScript(WATCH);
      const hold = page.locator('[data-testid="decision-holds"] li', { hasText: HOLD_TEXT });
      let out: Record<string, unknown>;
      if (mode === "direct") {
        const t0 = Date.now();
        await page.goto("/", { waitUntil: "commit" });
        await hold.waitFor({ state: "visible", timeout: 60_000 });
        const wall = Date.now() - t0;
        const nav = await page.evaluate(() => {
          const n = performance.getEntriesByType("navigation")[0] as PerformanceNavigationTiming;
          const w = window as unknown as { __r34: { visibleAt: number | null; inDomAt: number | null } };
          return { ttfb: Math.round(n.responseStart), htmlEnd: Math.round(n.responseEnd), domContentLoaded: Math.round(n.domContentLoadedEventEnd), holdInDom: w.__r34.inDomAt && Math.round(w.__r34.inDomAt), holdVisible: w.__r34.visibleAt && Math.round(w.__r34.visibleAt) };
        });
        out = { mode, run, wall, ...nav };
      } else {
        await page.goto("/demo");
        await page.getByTestId("demo-state").filter({ hasText: "Ready" }).waitFor({ timeout: 60_000 });
        const t0 = await page.evaluate(() => performance.now());
        const wall0 = Date.now();
        await page.getByTestId("demo-start").click();
        await hold.waitFor({ state: "visible", timeout: 60_000 });
        const wall = Date.now() - wall0;
        const seen = await page.evaluate(() => (window as unknown as { __r34: { visibleAt: number | null } }).__r34.visibleAt);
        out = { mode, run, wall, holdVisibleAfterClick: seen === null ? null : Math.round(seen - t0) };
      }
      console.log(JSON.stringify(out));
      await context.close();
    }
  } finally {
    await b.close();
  }
}

const mode = process.argv[2];
const job = mode === "db" ? db() : mode === "server" ? server() : mode === "direct" || mode === "guide" ? browser(mode) : Promise.reject(new Error("mode: db | server | direct | guide"));
job.catch((error) => {
  console.error(error);
  process.exit(1);
});
