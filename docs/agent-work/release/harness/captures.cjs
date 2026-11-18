/**
 * Light-mode captures for the release's side-by-side comparison
 * (docs/agent-work/release/RELEASE-DESIGN.md, WP-J step 3). One run per build, same data:
 *
 *   node captures.cjs <baseUrl> <before|after> <outDir> [nodeModulesDir]
 *
 * Scenes, each at 1440 × 900 and 390 × 844:
 *   focus    Decision Lab (B20, October): the page's main action reached by keyboard (Tab)
 *   pending  Data onboarding: the sample's button while its request is in flight (the response
 *            is held for 4 s by the test, so the in-flight state can be seen)
 *   point    Overview: B09, October, one chart point selected (restored from the URL)
 *   result   the view that point opens (its evidence), or the trace when no link is offered
 * The server runs with DEMO_MODE=1 so the analyst role can upload.
 */
const path = require("node:path");
const fs = require("node:fs");

const [, , baseUrl, label, outDir, modulesDir] = process.argv;
if (!baseUrl || !label || !outDir) {
  console.error("usage: node captures.cjs <baseUrl> <before|after> <outDir> [nodeModulesDir]");
  process.exit(2);
}
const { chromium } = require(path.join(modulesDir ?? path.resolve("node_modules"), "playwright"));

const POINT = "/?branch=B09&period=oct&channel=google_search&week=2026-10-12#movement";
const SIZES = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

async function shot(page, name) {
  const file = path.join(outDir, `${label}-${name}.png`);
  await page.screenshot({ path: file, fullPage: false });
  return file;
}

/** Tabs until the element matching `selector` has focus (keyboard modality, so :focus-visible applies). */
async function tabTo(page, selector, max = 60) {
  for (let i = 0; i < max; i++) {
    await page.keyboard.press("Tab");
    const hit = await page.evaluate((sel) => {
      const a = document.activeElement;
      return !!a && (a.matches(sel) || !!a.closest(sel));
    }, selector);
    if (hit) return true;
  }
  return false;
}

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const log = {};
  for (const [size, viewport] of Object.entries(SIZES)) {
    const context = await browser.newContext({ viewport, deviceScaleFactor: 1, colorScheme: "light" });
    await context.request.post(baseUrl + "/api/role", { data: { role: "marketing" } });
    const page = await context.newPage();

    // focus
    await page.goto(baseUrl + "/decisions?branch=B20&period=oct", { waitUntil: "networkidle", timeout: 120_000 });
    const focused = await tabTo(page, '[data-testid="readiness-incident-link"], [data-testid="readiness-summary"] a');
    if (focused) await page.evaluate(() => document.activeElement?.scrollIntoView({ block: "center" }));
    log[`focus-${size}`] = { focused, file: await shot(page, `focus-${size}`) };

    // pending
    await page.goto(baseUrl + "/onboarding", { waitUntil: "networkidle", timeout: 120_000 });
    await page.route("**/api/onboarding/uploads", async (route) => {
      await new Promise((r) => setTimeout(r, 4000));
      await route.continue();
    });
    const sample = page.getByTestId("sample-demo-calls.csv");
    await sample.scrollIntoViewIfNeeded();
    await sample.click();
    await page.waitForTimeout(600);
    log[`pending-${size}`] = { file: await shot(page, `pending-${size}`) };
    await page.waitForURL(/\/onboarding\/\d+$/, { timeout: 60_000 }).catch(() => {});
    await page.unroute("**/api/onboarding/uploads");

    // point
    await page.goto(baseUrl + POINT, { waitUntil: "networkidle", timeout: 120_000 });
    await page.locator("#movement").scrollIntoViewIfNeeded().catch(() => {});
    log[`point-${size}`] = { file: await shot(page, `point-${size}`) };

    // result: the evidence the selected point opens
    const open = page.getByRole("link", { name: "Open evidence", exact: true }).or(page.getByRole("button", { name: "Open evidence", exact: true })).first();
    if (await open.count()) {
      await open.click();
      // A client-side navigation: wait for the new URL, then for its data.
      await page.waitForURL(/\/trace/, { timeout: 60_000 });
      await page.waitForLoadState("networkidle");
    } else {
      await page.goto(baseUrl + "/branches/B09/trace?period=oct&metric=paid_spend&channel=google_search&week=2026-10-12#selection", { waitUntil: "networkidle" });
    }
    log[`result-${size}`] = { url: page.url(), file: await shot(page, `result-${size}`) };
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(outDir, `${label}-captures.json`), JSON.stringify(log, null, 2));
  console.log(JSON.stringify(log));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
