// Captures what the running app shows for the cohort fixture's servicing branch (B11): the paid CAC
// stat, the weekly CAC bars, the channel row, the Overview row, and the CAC trace's equation.
// Usage: node proof.cjs <label> [base url]   (writes proof/<label>/*.png and proof/<label>/texts.json)
// The app must be running on the restored fixture database, never the demo one.
const path = require("node:path");
const fs = require("node:fs");
const REPO = path.resolve(__dirname, "../../../../..");
const { chromium } = require(path.join(REPO, "node_modules", "@playwright/test"));

const label = process.argv[2] ?? "before";
const base = process.argv[3] ?? "http://localhost:3991";
const out = path.join(__dirname, "proof", label);
fs.mkdirSync(out, { recursive: true });

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 1440, height: 1000 } });
  const texts = {};
  const grab = async (name, locator) => {
    await locator.scrollIntoViewIfNeeded();
    texts[name] = (await locator.innerText()).replace(/\s+\n/g, "\n").trim();
    await locator.screenshot({ path: path.join(out, `${name}.png`) });
  };

  await page.goto(`${base}/branches/B11?period=oct`, { waitUntil: "networkidle", timeout: 180_000 });
  const stat = page.locator("div.rounded-xl", { has: page.locator("summary", { hasText: "Paid-media CAC" }) }).first();
  await grab("branch-stat", stat);
  // The bars' data table (screen readers, tooltips): a $0 bar has no height, so read the week's cell.
  texts["branch-weekly-oct05"] = await page
    .locator('[data-testid="weekly-bars-data"]', { hasText: "Paid-media CAC" })
    .locator("tr", { hasText: "2026-10-05" })
    .evaluate((tr) => tr.textContent.trim());
  await grab("branch-channel-row", page.locator("tr", { hasText: "Google Search" }).first());

  await page.goto(`${base}/?period=oct`, { waitUntil: "networkidle", timeout: 180_000 });
  await grab("overview-row", page.locator("tr", { hasText: "B11 Driftwood" }).first());

  await page.goto(`${base}/branches/B11/trace?period=oct&metric=paid_cac`, { waitUntil: "networkidle", timeout: 180_000 });
  await grab("trace-equation", page.locator('[data-testid="trace-reproduced"], [data-testid="trace-discrepancy"]').first());

  fs.writeFileSync(path.join(out, "texts.json"), JSON.stringify(texts, null, 2));
  console.log(JSON.stringify(texts, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
