// The hosted Guided demo before the visitor tour, as the public-demo guest: /demo, the B09 path's
// step 4 with its "Use this role" button, and what that button sends (POST /api/role, refused
// outside demo mode). Nothing else is written.
//
//   node guided-demo-before.cjs <baseUrl> <outDir> <node_modules dir>
const fs = require("node:fs");
const path = require("node:path");

const [, , baseUrl, outDir, modulesDir] = process.argv;
const { chromium } = require(path.join(modulesDir, "playwright"));

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
  await page.goto(`${baseUrl}/demo`, { waitUntil: "networkidle" });
  await page.screenshot({ path: path.join(outDir, "before-demo-1440.png") });
  const start = page.getByTestId("demo-start");
  const href = (await start.count()) ? await start.getAttribute("href") : null;
  const gap = href ? new URL(href, baseUrl).searchParams.get("gap") : null;
  console.log("demo-state:", (await page.getByTestId("demo-state").textContent())?.trim(), "| gap", gap);
  if (gap) {
    await page.goto(`${baseUrl}/exceptions/${gap}?guide=b09&step=4&gap=${gap}#action-center`, { waitUntil: "networkidle" });
    await page.evaluate(() => window.scrollTo(0, 0));
    await page.screenshot({ path: path.join(outDir, "before-step4-1440.png") });
    console.log("step 4 bar:", (await page.getByTestId("guide-step").textContent())?.trim(), "| role button:", await page.getByTestId("guide-use-role").count());
  }
  // What "Use this role" sends.
  const res = await page.request.post(`${baseUrl}/api/role`, { data: { role: "engineer" } });
  console.log("POST /api/role ->", res.status());
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
