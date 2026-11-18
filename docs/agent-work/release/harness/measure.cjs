/**
 * Time to a usable verdict, layout shift and the phone's first screen, for the release's three
 * measured journeys (docs/agent-work/release/RELEASE-DESIGN.md §4). Run against a production
 * server (`next start`) over a seeded database that is not the demo's, before and after the
 * release, on the same data:
 *
 *   node measure.cjs <baseUrl> <label> <outJson> [nodeModulesDir]
 *
 * - cold: the first load of each page after the server started, in a fresh browser context;
 * - warm: the median of three further loads, each in a fresh context (no HTTP cache), so only
 *   the server's own warm state differs;
 * - verdict: navigation start until the page's answer is visible with its final text (not a
 *   skeleton or "Loading");
 * - CLS: the sum of layout-shift entries without recent input, read 1.5 s after the verdict;
 * - phone: at 390 × 844, where the verdict and the primary action sit (px from the top), and
 *   whether both are inside the first screen.
 */
const path = require("node:path");
const fs = require("node:fs");

const [, , baseUrl, label, outJson, modulesDir] = process.argv;
if (!baseUrl || !label || !outJson) {
  console.error("usage: node measure.cjs <baseUrl> <label> <outJson> [nodeModulesDir]");
  process.exit(2);
}
const { chromium } = require(path.join(modulesDir ?? path.resolve("node_modules"), "playwright"));

/** The measured pages. `verdict` is the answer a reader acts on; `action` is the page's next step. */
const TARGETS = process.env.MEASURE_ONLY_UPLOAD === "1" ? [] : [
  // The Overview's next action is the branch the headline answer names ("start with B20 Heron"); a
  // release build marks it `overview-next`. (An earlier selector matched the holds list 2,690 px
  // down instead: corrected 2026-11-18 before any layout change.)
  { name: "overview", path: "/", verdict: '[data-testid="headline-answer"]', action: '[data-testid="overview-next"], [data-testid="headline-answer"] a:not([href*="/definitions"])' },
  { name: "decision-lab-b20", path: "/decisions?branch=B20&period=oct", verdict: '[data-testid="readiness-summary"]', action: '[data-testid="readiness-incident-link"], [data-testid="readiness-blockers"] a' },
  { name: "decision-lab-b09", path: "/decisions?branch=B09&period=oct", verdict: '[data-testid="readiness-summary"]', action: '[data-testid="readiness-incident-link"], [data-testid="readiness-blockers"] a' },
];

const CLS_PROBE = () => {
  window.__cls = 0;
  new PerformanceObserver((list) => {
    for (const e of list.getEntries()) if (!e.hadRecentInput) window.__cls += e.value;
  }).observe({ type: "layout-shift", buffered: true });
};

/** Waits until the selector is visible with settled text: no skeleton, no "Loading". */
async function settled(page, selector) {
  const el = page.locator(selector).first();
  await el.waitFor({ state: "visible", timeout: 120_000 });
  await page.waitForFunction(
    (sel) => {
      const n = document.querySelector(sel);
      const t = (n?.textContent ?? "").trim();
      return t.length > 0 && !/loading|checking…|reading…/i.test(t) && !n.querySelector('[data-skeleton], .animate-pulse');
    },
    selector,
    { timeout: 120_000 },
  );
  return el;
}

async function once(browser, target, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript(CLS_PROBE);
  const page = await context.newPage();
  const started = Date.now();
  await page.goto(baseUrl + target.path, { waitUntil: "commit", timeout: 120_000 });
  const el = await settled(page, target.verdict);
  const verdictMs = Date.now() - started;
  await page.waitForTimeout(1500);
  const cls = await page.evaluate(() => window.__cls ?? null);
  const box = await el.boundingBox();
  const action = page.locator(target.action).first();
  const actionBox = (await action.count()) > 0 ? await action.boundingBox() : null;
  const scrollWidth = await page.evaluate(() => document.documentElement.scrollWidth);
  await context.close();
  return {
    verdictMs,
    cls: cls === null ? null : Math.round(cls * 1000) / 1000,
    verdictTop: box ? Math.round(box.y) : null,
    actionTop: actionBox ? Math.round(actionBox.y) : null,
    actionBottom: actionBox ? Math.round(actionBox.y + actionBox.height) : null,
    sideways: scrollWidth > viewport.width,
  };
}

const median = (xs) => [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)];

/**
 * The upload journey, as a marketing analyst (the server runs with DEMO_MODE=1): the built-in call
 * sample, from the click to the result card's conclusion. The two questions a file cannot answer
 * are answered when the page asks them; nothing else is clicked. Where the result sits on the first
 * screen is read after a reload, from the top: the page scrolls to the result after a dry run.
 */
async function uploadOnce(browser, viewport) {
  const context = await browser.newContext({ viewport, deviceScaleFactor: 1 });
  await context.addInitScript(CLS_PROBE);
  const role = await context.request.post(baseUrl + "/api/role", { data: { role: "marketing" } });
  if (!role.ok()) throw new Error(`role: ${role.status()}`);
  const page = await context.newPage();
  await page.goto(baseUrl + "/onboarding", { waitUntil: "load", timeout: 120_000 });
  // The clock starts when the sample can be clicked. React reveals streamed sections in batches,
  // at least 300 ms apart, so the button can stay hidden for up to a second after the load event:
  // page time, not upload time, recorded apart as `readyMs`. (Until 2026-11-18 the clock started
  // before Playwright waited for the button, so each run carried that wait.)
  const sample = page.getByTestId("sample-demo-calls.csv");
  const loaded = Date.now();
  await sample.waitFor({ state: "visible", timeout: 120_000 });
  const started = Date.now();
  await sample.click();
  await page.waitForURL(/\/onboarding\/\d+$/, { timeout: 120_000 });
  // The mapping form streams in after the URL changes: wait for it (or for a result the page
  // already reached on its own) before reading what it asks.
  await page.locator('[data-testid="propose-and-dry-run"], [data-testid="dry-run-counts"]').first().waitFor({ state: "visible", timeout: 120_000 });
  const go = page.getByTestId("propose-and-dry-run");
  if (await go.count()) {
    const questions = page.getByTestId("mapping-questions");
    if (await questions.count()) {
      const mdy = questions.getByLabel("month first (March 4)");
      if (await mdy.count()) await mdy.check();
      // Set, never toggle: a later upload of the same layout starts from the earlier mapping's
      // answers, so the box may already be checked.
      const local = questions.getByLabel(/branch local time/);
      if (await local.count()) await local.check();
    }
    await go.click();
  }
  // A build from before the result card (WP-D) shows the dry run's counts; both appear together on newer builds.
  const result = await settled(page, '[data-testid="result-conclusion"], [data-testid="dry-run-counts"]').catch(async (e) => {
    const shot = path.join(path.dirname(outJson), `upload-failure-${label}.png`);
    await page.screenshot({ path: shot, fullPage: true });
    console.error("upload stalled at", page.url(), "screenshot:", shot);
    throw e;
  });
  const ms = Date.now() - started;
  await page.waitForTimeout(1500);
  const cls = await page.evaluate(() => window.__cls ?? null);
  await page.reload({ waitUntil: "load" });
  const card = page.locator('[data-testid="upload-result"], [data-testid="dry-run-counts"]').first();
  await card.waitFor({ state: "visible", timeout: 60_000 });
  const box = await card.boundingBox();
  void result;
  await context.close();
  return { ms, readyMs: started - loaded, cls: cls === null ? null : Math.round(cls * 1000) / 1000, resultTop: box ? Math.round(box.y) : null };
}

/** Writes what has been measured so far, so a later failure does not lose the earlier numbers. */
function save(out) {
  fs.mkdirSync(path.dirname(outJson), { recursive: true });
  fs.writeFileSync(outJson, JSON.stringify(out, null, 2));
}

(async () => {
  const browser = await chromium.launch();
  const out = { label, baseUrl, at: new Date().toISOString(), pages: {} };
  for (const t of TARGETS) {
    const desktop = { width: 1440, height: 900 };
    const cold = await once(browser, t, desktop);
    const warm = [];
    for (let i = 0; i < 3; i++) warm.push(await once(browser, t, desktop));
    const phone = await once(browser, t, { width: 390, height: 844 });
    out.pages[t.name] = {
      path: t.path,
      coldVerdictMs: cold.verdictMs,
      warmVerdictMs: median(warm.map((w) => w.verdictMs)),
      warmRuns: warm.map((w) => w.verdictMs),
      cls: Math.max(cold.cls ?? 0, ...warm.map((w) => w.cls ?? 0)),
      phone: {
        verdictTop: phone.verdictTop,
        actionTop: phone.actionTop,
        firstScreen: phone.verdictTop !== null && phone.verdictTop < 844 && phone.actionBottom !== null && phone.actionBottom <= 844,
        sideways: phone.sideways,
        verdictMs: phone.verdictMs,
        cls: phone.cls,
      },
    };
    console.log(t.name, JSON.stringify(out.pages[t.name]));
    save(out);
  }
  if (process.env.MEASURE_UPLOAD !== "0") {
    const desktop = [];
    // Five runs: three gave a median that fell on either side of React's reveal batches.
    for (let i = 0; i < 5; i++) desktop.push(await uploadOnce(browser, { width: 1440, height: 900 }));
    const phone = await uploadOnce(browser, { width: 390, height: 844 });
    out.pages.upload = {
      path: "/onboarding → sample-demo-calls.csv → result",
      firstMs: desktop[0].ms,
      medianMs: median(desktop.map((d) => d.ms)),
      runs: desktop.map((d) => d.ms),
      readyRuns: desktop.map((d) => d.readyMs),
      cls: Math.max(...desktop.map((d) => d.cls ?? 0)),
      phone: { resultTop: phone.resultTop, firstScreen: phone.resultTop !== null && phone.resultTop < 844, ms: phone.ms, cls: phone.cls },
    };
    console.log("upload", JSON.stringify(out.pages.upload));
  }
  await browser.close();
  save(out);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
