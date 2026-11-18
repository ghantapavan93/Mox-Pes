// The Overview's verdict on a deployed URL, as a guest (§10): the first load in a fresh context,
// then three more, each in a fresh context, read by Element Timing. Public URLs only.
const path = require("node:path");
const [, , baseUrl, modulesDir] = process.argv;
const { chromium } = require(path.join(modulesDir, "playwright"));
const verdictMs = (page) => page.evaluate(() => new Promise((resolve) => {
  const out = [];
  new PerformanceObserver((l) => out.push(...l.getEntries())).observe({ type: "element", buffered: true });
  setTimeout(() => resolve(out.filter((e) => e.identifier === "verdict").map((e) => Math.round(e.renderTime || e.loadTime))[0] ?? null), 300);
}));
(async () => {
  const browser = await chromium.launch();
  const runs = [];
  for (let i = 0; i < 4; i++) {
    const context = await browser.newContext({ viewport: { width: 1440, height: 900 } });
    const page = await context.newPage();
    await page.goto(baseUrl + "/", { waitUntil: "load", timeout: 120_000 });
    await page.locator('[data-testid="headline-answer"]').waitFor({ state: "visible", timeout: 60_000 });
    await page.waitForTimeout(800);
    runs.push(await verdictMs(page));
    await context.close();
  }
  const warm = runs.slice(1).sort((a, b) => a - b);
  console.log(JSON.stringify({ baseUrl, at: new Date().toISOString(), firstMs: runs[0], warmRuns: runs.slice(1), warmMedianMs: warm[1] }));
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
