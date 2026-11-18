/**
 * Where a visitor's upload button and result action land, at 1440 × 900 and 390 × 844 (release
 * WP-D step 8, the route audit's /onboarding rows). Uploads <file> as a new visitor, answers the two
 * questions and dry-runs it, then measures:
 *
 *   node guest-first-screen.cjs <baseUrl> <file> [nodeModulesDir]
 *
 * The server runs with PUBLIC_WORKSPACE=1. Writes only the visitor's own workspace upload.
 */
const path = require("node:path");
const fs = require("node:fs");
const [, , base, file, modulesDir] = process.argv;
if (!base || !file) {
  console.error("usage: node guest-first-screen.cjs <baseUrl> <file> [nodeModulesDir]");
  process.exit(2);
}
const { chromium } = require(path.join(modulesDir ?? path.resolve("node_modules"), "playwright"));

async function top(page, testId) {
  const el = page.getByTestId(testId).first();
  await el.waitFor({ state: "visible", timeout: 60_000 });
  return Math.round((await el.boundingBox()).y);
}

(async () => {
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  for (let i = 0; i < 90; i++) {
    try {
      if ((await page.request.get(base + "/onboarding")).ok()) break;
    } catch {}
    await new Promise((r) => setTimeout(r, 1000));
  }
  const res = await page.request.post(base + "/api/onboarding/uploads", { headers: { "x-filename": "unseen.csv", "content-type": "application/octet-stream" }, data: fs.readFileSync(file) });
  const json = await res.json();
  const id = (json.upload ?? json.repeatOf).id;
  await page.goto(`${base}/onboarding/${id}`);
  if (!(await page.getByTestId("upload-result").count())) {
    const q = page.getByTestId("mapping-questions");
    await q.getByLabel("month first (March 4)").check();
    await q.getByText(/branch local time/).click();
    await page.getByTestId("propose-and-dry-run").click();
    await page.getByTestId("upload-result").waitFor({ timeout: 90_000 });
  }
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    await page.setViewportSize({ width: w, height: h });
    await page.goto(`${base}/onboarding`);
    const submit = await top(page, "upload-submit");
    await page.goto(`${base}/onboarding/${id}`);
    const result = await top(page, "upload-result");
    const next = await top(page, "result-next");
    const primaries = await page.locator('[data-variant="primary"]:visible').count();
    console.log(`${w}x${h}: upload button ${submit}px; result ${result}px; next action ${next}px; visible primaries ${primaries}`);
  }
  await browser.close();
})();
