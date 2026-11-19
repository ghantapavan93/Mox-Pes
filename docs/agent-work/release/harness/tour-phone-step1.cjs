// The visitor tour's first step on a phone, loaded n times from its start (/demo/tour, a redirect,
// so each is a full page load): how often the receipt's figure ends above the tour bar. Before
// 99518da the browser's one try at #fix-result often came while the receipt was still streaming in.
// Read-only.
//
//   node tour-phone-step1.cjs <baseUrl> <n> <node_modules dir>
const path = require("node:path");

const [, , baseUrl, n = "10", modulesDir] = process.argv;
const { chromium } = require(path.join(modulesDir, "playwright"));

(async () => {
  const browser = await chromium.launch();
  let above = 0;
  const rows = [];
  for (let i = 0; i < Number(n); i += 1) {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    await page.goto(`${baseUrl}/demo/tour`, { waitUntil: "networkidle" });
    await page.waitForTimeout(1500);
    const r = await page.evaluate(() => {
      const f = document.querySelector("[data-testid=fix-result-cac]")?.getBoundingClientRect();
      const b = document.querySelector("[data-testid=tour-bar]")?.getBoundingClientRect();
      return f && b ? { figureBottom: Math.round(f.bottom), barTop: Math.round(b.top), scrollY: Math.round(scrollY) } : null;
    });
    const ok = r !== null && r.figureBottom > 0 && r.figureBottom <= r.barTop;
    if (ok) above += 1;
    rows.push(`${i + 1}:${ok ? "above" : "UNDER"}(scrollY ${r ? r.scrollY : "-"})`);
    await context.close();
  }
  await browser.close();
  console.log(`${baseUrl}: the figure ended above the tour bar in ${above} of ${n} loads`);
  console.log(rows.join(" "));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
