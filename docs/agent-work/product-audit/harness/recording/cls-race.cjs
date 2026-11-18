/**
 * Reproduces the Decision Lab layout-shift race on demand (quality gate · layout shift).
 *
 *   node cls-race.cjs <base> <databaseUrl> <out.json> [runs=6] [lockMs=1500]
 *
 * The page streams two sibling boundaries: the verdicts (readiness, matrix, scenarios) and, below
 * them, the A/A analysis. When the A/A analysis is painted first, the verdicts replace a short
 * fallback above it and push it down the page. A busy server orders them that way by chance; here
 * the order is forced by holding the exceptions table (which the verdicts read and the A/A
 * analysis does not) for lockMs while the page loads. lockMs=0 is the unforced load.
 *
 * The CLS observer is the gate's own (tests/e2e/z-quality-gates.spec.ts): same entries, same
 * sources, measured after networkidle + 500 ms. Run against an isolated database only.
 */
const { chromium } = require("playwright");
const { Client } = require("pg");
const fs = require("node:fs");

const [base, databaseUrl, out, runsArg = "6", lockArg = "1500"] = process.argv.slice(2);
if (!base || !databaseUrl || !out) throw new Error("usage: cls-race.cjs <base> <databaseUrl> <out.json> [runs] [lockMs]");
if (/\/revenue_signal$/.test(databaseUrl)) throw new Error("refusing the demo database");
const runs = Number(runsArg);
const lockMs = Number(lockArg);
const URL_PATH = "/decisions?branch=B09&period=oct";

async function holdExceptions(ms) {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  await client.query("begin");
  await client.query("lock table exceptions in access exclusive mode");
  const released = new Promise((resolve) => setTimeout(async () => {
    await client.query("commit");
    await client.end();
    resolve();
  }, ms));
  // Inside an object: an async function that returns the promise itself makes the caller's
  // await wait for the release, so the page would load after it (the first version did).
  return { released };
}

(async () => {
  const browser = await chromium.launch();
  const results = [];
  for (const width of [1440, 390]) {
    const context = await browser.newContext({ viewport: { width, height: 900 } });
    const page = await context.newPage();
    await page.request.post(`${base}/api/role`, { data: { role: "marketing" } });
    await page.addInitScript(() => {
      window.__cls = 0;
      window.__shifts = [];
      new PerformanceObserver((list) => {
        for (const entry of list.getEntries()) {
          if (entry.hadRecentInput) continue;
          window.__cls += entry.value;
          const node = entry.sources?.[0]?.node;
          window.__shifts.push(`${entry.value.toFixed(3)} ${node instanceof Element ? `${node.tagName.toLowerCase()}${node.id ? `#${node.id}` : ""}.${String(node.className).slice(0, 50)}` : "?"}`);
        }
      }).observe({ type: "layout-shift", buffered: true });
    });
    // Warm the fonts and the route once, as the gate does by visiting other pages first.
    await page.goto(`${base}/?period=oct`);
    await page.waitForLoadState("networkidle");
    for (let i = 0; i < runs; i++) {
      const lock = lockMs > 0 ? await holdExceptions(lockMs) : null;
      const t0 = Date.now();
      await page.goto(`${base}${URL_PATH}`);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(500);
      if (lock) await lock.released;
      const { cls, shifts } = await page.evaluate(() => ({ cls: window.__cls, shifts: window.__shifts }));
      results.push({ width, run: i + 1, lockMs, cls: Number(cls.toFixed(3)), over: cls >= 0.1, shifts, ms: Date.now() - t0 });
      console.log(`${width}px run ${i + 1} lock ${lockMs} ms: CLS ${cls.toFixed(3)} ${cls >= 0.1 ? "OVER" : "ok"}  ${shifts.join("; ")}`);
    }
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(out, JSON.stringify({ base, path: URL_PATH, runs, lockMs, results }, null, 2));
  const over = results.filter((r) => r.over).length;
  console.log(`over 0.1: ${over} of ${results.length}`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
