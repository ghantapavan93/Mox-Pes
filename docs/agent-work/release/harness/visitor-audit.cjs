// Walks every page a visitor can open on a deployment, as the public-demo guest: the first screen
// at 1440 and 390 px, the page's text, how long it took, and console errors. Read-only.
//
//   node visitor-audit.cjs <baseUrl> <outDir> <node_modules dir>
const fs = require("node:fs");
const path = require("node:path");

const [, , baseUrl, outDir, modulesDir] = process.argv;
const { chromium } = require(path.join(modulesDir, "playwright"));

const PAGES = [
  ["start", "/start"],
  ["overview", "/"],
  ["incidents", "/exceptions"],
  ["incident-b20", "/exceptions/1063"],
  ["investigator", "/investigator"],
  ["answer-check", "/assurance"],
  ["customers", "/customers"],
  ["decision-lab", "/decisions"],
  ["google-feedback", "/feedback"],
  ["definitions", "/definitions"],
  ["onboarding", "/onboarding"],
  ["integrations", "/integrations"],
  ["changeguard", "/changes"],
  ["audit", "/audit"],
  ["guided-demo", "/demo"],
  ["branch-b20", "/branches/B20"],
];

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const report = [];
  for (const [w, h] of [[1440, 900], [390, 844]]) {
    const context = await browser.newContext({ viewport: { width: w, height: h }, isMobile: w < 500, hasTouch: w < 500 });
    const page = await context.newPage();
    const errors = [];
    page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 200)));
    page.on("pageerror", (e) => errors.push(`pageerror: ${e.message.slice(0, 200)}`));
    for (const [name, url] of PAGES) {
      errors.length = 0;
      const t0 = Date.now();
      await page.goto(`${baseUrl}${url}`, { waitUntil: "networkidle", timeout: 60_000 });
      const ms = Date.now() - t0;
      await page.waitForTimeout(400);
      await page.screenshot({ path: path.join(outDir, `${name}-${w}.png`) });
      if (w === 1440) {
        const info = await page.evaluate(() => {
          const main = document.querySelector("main");
          return {
            title: document.title,
            h1: [...document.querySelectorAll("h1")].map((e) => e.textContent.trim()).join(" | "),
            height: document.documentElement.scrollHeight,
            text: (main ? main.innerText : document.body.innerText).replace(/\n{2,}/g, "\n").slice(0, 2500),
          };
        });
        report.push({ name, url, ms, errors: [...errors], ...info });
      } else {
        const sideways = await page.evaluate(() => document.documentElement.scrollWidth > document.documentElement.clientWidth + 1);
        const r = report.find((x) => x.name === name);
        if (r) Object.assign(r, { phoneMs: ms, phoneSideways: sideways, phoneErrors: [...errors] });
      }
      console.log(w, name, `${ms} ms`, errors.length ? `${errors.length} console errors` : "");
    }
    await context.close();
  }
  await browser.close();
  fs.writeFileSync(path.join(outDir, "report.json"), JSON.stringify(report, null, 2));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
