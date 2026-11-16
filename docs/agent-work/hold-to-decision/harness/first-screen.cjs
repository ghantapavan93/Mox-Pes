// The first screen of a page, as a reader opens it (no hash, no scroll), at desktop and phone size.
//   node docs/agent-work/hold-to-decision/harness/first-screen.cjs <baseUrl> <path> <outPrefix>
// Reads only. The role is the demo's Marketing analyst.
const { createRequire } = require("node:module");
const path = require("node:path");
const req = createRequire(path.resolve(__dirname, "../../../../package.json"));
const { chromium } = req("@playwright/test");

const [base, url, prefix] = process.argv.slice(2);

(async () => {
  const browser = await chromium.launch();
  for (const [suffix, opts] of [
    ["1440", { viewport: { width: 1440, height: 900 } }],
    ["390", { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }],
  ]) {
    const context = await browser.newContext({ baseURL: base, ...opts });
    const page = await context.newPage();
    const res = await page.request.post("/api/role", { data: { role: "marketing" } });
    if (!res.ok()) throw new Error(`role: HTTP ${res.status()}`);
    await page.goto(url, { waitUntil: "domcontentloaded" });
    await page.locator("#recovery").first().waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 20_000 }).catch(() => {});
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: `${prefix}-${suffix}.jpg`, type: "jpeg", quality: 88 });
    await context.close();
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
