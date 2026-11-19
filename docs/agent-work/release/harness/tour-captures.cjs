// Captures the Start page, the visitor tour and the guided demo, as the public-demo guest, for the
// release record: each step at 1440 px, the Start page and two steps at 390 px. Read-only apart from
// the visitor's own question at step 6, which is deleted at the end.
//
//   node tour-captures.cjs <baseUrl> <outDir> <node_modules dir>
const fs = require("node:fs");
const path = require("node:path");

const [, , baseUrl, outDir, modulesDir] = process.argv;
const { chromium } = require(path.join(modulesDir, "playwright"));

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const shot = async (page, name) => {
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    await page.waitForTimeout(500);
    await page.screenshot({ path: path.join(outDir, `${name}.png`) });
    console.log(name);
  };

  // Desktop: the Start page, every step, the guided demo.
  const desk = await (await browser.newContext({ viewport: { width: 1440, height: 900 }, reducedMotion: "reduce" })).newPage();
  await desk.goto(`${baseUrl}/start`);
  await shot(desk, "start-1440");
  await desk.getByTestId("start-tour").click();
  await desk.getByTestId("tour-step").waitFor();
  let question = null;
  for (let n = 1; n <= 7; n += 1) {
    await desk.getByTestId("tour-step").filter({ hasText: `Step ${n} of 7` }).waitFor();
    await shot(desk, `tour-${n}-1440`);
    if (n === 6) {
      await desk.getByTestId("investigate-submit").click();
      await desk.waitForURL(/\/investigator\/\d+\?/, { timeout: 90_000 });
      await desk.getByTestId("findings").waitFor();
      question = new URL(desk.url()).pathname;
      await shot(desk, "tour-6-answered-1440");
    }
    if (n < 7) await desk.getByTestId("tour-next").click();
  }
  await desk.goto(`${baseUrl}/demo`);
  await shot(desk, "demo-1440");

  // Phone: the Start page, the first step and the evidence step.
  const phone = await (await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, reducedMotion: "reduce" })).newPage();
  await phone.goto(`${baseUrl}/start`);
  await shot(phone, "start-390");
  await phone.getByTestId("start-tour").click();
  await phone.getByTestId("tour-step").waitFor();
  await shot(phone, "tour-1-390");
  for (const n of [2, 3]) {
    await phone.getByTestId("tour-next").click();
    await phone.getByTestId("tour-step").filter({ hasText: `Step ${n} of 7` }).waitFor();
  }
  await shot(phone, "tour-3-390");

  // The visitor's question is theirs: delete it.
  if (question) {
    await desk.goto(`${baseUrl}${question}`);
    await desk.getByRole("button", { name: "Delete it now" }).first().click();
    await desk.waitForURL(/\/investigator$/, { timeout: 30_000 });
    console.log("question deleted");
  }
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
