// A visitor brings the "missed calls" sample, counts it in a private copy and opens their dashboard;
// a second visitor then reads the shared figures, unchanged. Captures each screen at 1440 px (and
// the dashboard at 390 px), times the count, and deletes the upload at the end.
//
//   node your-dashboard-walk.cjs <baseUrl> <outDir> <node_modules dir>
const fs = require("node:fs");
const path = require("node:path");

const [, , baseUrl, outDir, modulesDir] = process.argv;
const { chromium } = require(path.join(modulesDir, "playwright"));

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const shot = async (page, name, fullPage = false) => {
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(400);
    await page.screenshot({ path: path.join(outDir, `${name}.png`), fullPage });
    console.log("shot", name);
  };
  const a = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await a.goto(`${baseUrl}/onboarding`, { waitUntil: "networkidle" });
  await shot(a, "1-onboarding");
  await a.getByRole("button", { name: /Calls the feed missed/ }).click();
  await a.waitForURL(/\/onboarding\/\d+$/, { timeout: 60_000 });
  const uploadUrl = a.url();
  // The page streams: the mapping and its questions are in place once the dry-run button is.
  await a.getByTestId("propose-and-dry-run").waitFor({ timeout: 60_000 });
  const questions = a.getByTestId("mapping-questions");
  if (await questions.count()) {
    const month = questions.getByLabel("month first (March 4)");
    if (await month.count()) await month.check();
    const local = questions.getByText(/branch local time/);
    if (await local.count()) await local.first().click();
  }
  await a.getByTestId("propose-and-dry-run").click();
  await a.getByTestId("upload-result").waitFor({ timeout: 90_000 });
  await shot(a, "2-result");
  console.log("RESULT:", (await a.getByTestId("upload-result").innerText()).replace(/\s+/g, " ").slice(0, 600));
  const t0 = Date.now();
  await a.getByTestId("count-privately").click();
  await a.waitForURL(/\/onboarding\/\d+\/dashboard$/, { timeout: 90_000 });
  await a.getByTestId("your-headline").waitFor();
  console.log(`counted and opened in ${Date.now() - t0} ms`);
  await shot(a, "3-dashboard");
  await shot(a, "3-dashboard-full", true);
  console.log("DASHBOARD:", (await a.locator("main").innerText()).replace(/\s+/g, " ").slice(0, 1800));

  // Another visitor: the shared Overview and B01 read as before.
  const b = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await b.goto(`${baseUrl}/branches/B01?period=oct`, { waitUntil: "networkidle" });
  console.log("SHARED B01:", (await b.locator("main").innerText()).replace(/\s+/g, " ").match(/Paid-media CAC[^$]*\$[\d,.]+/)?.[0]);

  // The dashboard on a phone.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, storageState: await a.context().storageState() })).newPage();
  await phone.goto(a.url(), { waitUntil: "networkidle" });
  await shot(phone, "4-dashboard-390");
  const sideways = await phone.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
  console.log("phone sideways scroll:", sideways);

  await a.goto(uploadUrl, { waitUntil: "networkidle" });
  await a.getByTestId("delete-now").first().click();
  await a.waitForURL(/\/onboarding\?deleted=1$/, { timeout: 30_000 });
  console.log("upload deleted");
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
