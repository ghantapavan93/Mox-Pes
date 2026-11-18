// A short B20 walkthrough on the production URL, as a guest (WP-J step 10), recorded as video. Read-only apart from the visitor's own question, which
// is deleted at the end.
const path = require("node:path");
const fs = require("node:fs");
const [, , baseUrl, outDir, modulesDir] = process.argv;
const { chromium } = require(path.join(modulesDir, "playwright"));
fs.mkdirSync(outDir, { recursive: true });
const pause = (page, ms) => page.waitForTimeout(ms);
(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, recordVideo: { dir: outDir, size: { width: 1280, height: 800 } } });
  const page = await context.newPage();
  await page.goto(baseUrl + "/?period=oct", { waitUntil: "load" });
  await page.getByTestId("headline-answer").waitFor({ state: "visible" });
  await pause(page, 3500);
  await page.getByTestId("headline-action").click();
  await page.waitForLoadState("load");
  await pause(page, 3500);
  await page.goto(baseUrl + "/branches/B20/trace?period=oct&metric=paid_cac", { waitUntil: "load" });
  await page.locator("h1").waitFor({ state: "visible" });
  await pause(page, 4000);
  await page.mouse.wheel(0, 700);
  await pause(page, 2500);
  await page.goto(baseUrl + "/decisions?branch=B20&period=oct", { waitUntil: "load" });
  await page.getByTestId("readiness-summary").waitFor({ state: "visible" });
  await pause(page, 3500);
  const incident = page.getByTestId("readiness-incident-link").first();
  if (await incident.count()) {
    await incident.click();
    await page.waitForLoadState("load");
    await pause(page, 4000);
  }
  // The approved correction: what it changed and what it did not.
  await page.goto(baseUrl + "/exceptions/1063", { waitUntil: "load" });
  await page.locator("h1").waitFor({ state: "visible" });
  await pause(page, 5000);
  await page.mouse.wheel(0, 400);
  await pause(page, 3500);
  await page.goto(baseUrl + "/investigator", { waitUntil: "load" });
  await page.getByLabel("Question").fill("Why did B20's CAC jump in October?");
  await pause(page, 1500);
  await page.getByLabel("Question").press("Control+Enter");
  await page.waitForURL(/\/investigator\/\d+$/, { timeout: 90_000 });
  await page.getByTestId("findings").waitFor({ state: "visible" });
  await pause(page, 5000);
  const del = page.getByRole("button", { name: "Delete it now" }).first();
  if (await del.count()) await del.click();
  await pause(page, 1500);
  const video = page.video();
  await context.close();
  const file = await video.path();
  const named = path.join(outDir, "b20-walkthrough.webm");
  fs.renameSync(file, named);
  console.log(named);
  await browser.close();
})().catch((e) => { console.error(e); process.exit(1); });
