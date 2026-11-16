// What each surface says for one scope, as text plus a screenshot (HOLD-TO-DECISION.md §2).
//   node docs/agent-work/hold-to-decision/harness/capture.cjs <baseUrl> <outDir> <label> [role] [width] [exceptionIds...]
// Reads only: it never writes to the product. The role is set the demo's way (POST /api/role).
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const req = createRequire(path.resolve(__dirname, "../../../../package.json"));
const { chromium } = req("@playwright/test");

const [base, outDir, label, role = "marketing", widthArg = "1440", ...ids] = process.argv.slice(2);
const width = Number(widthArg);
const WEEK = "2026-10-19";
const CTX = `period=oct&channel=google_lsa&week=${WEEK}`;

const surfaces = [
  { name: "overview", path: `/?period=oct&branch=B09&channel=google_lsa&week=${WEEK}#movement`, wait: '[data-testid="movement"]', grab: ['main [role="status"], main .rounded-lg:first-of-type', '[data-testid="movement"]', '#holds'] },
  { name: "daily-evidence", path: `/branches/B09/trace?period=oct&metric=paid_spend&channel=google_lsa&week=${WEEK}`, wait: '[data-testid="overview-selection"]', grab: ['[data-testid="overview-selection"]', '[data-testid="selection-summary"]'] },
  ...ids.map((id) => ({ name: `incident-${id}`, path: `/exceptions/${id}?${CTX}`, wait: '[data-testid="exception-summary"]', grab: ["main header, main h1", '[data-testid="exception-summary"]', '[data-testid="incident-impact"]', "#recovery", "#evidence", "#records"] })),
  { name: "decision-lab", path: `/decisions?branch=B09&${CTX}`, wait: '[data-testid="readiness-summary"]', grab: ['[data-testid="readiness-summary"]', "#verdicts", '[data-testid="verified-readiness"]'] },
];

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const context = await browser.newContext({ baseURL: base, viewport: { width, height: 900 } });
  const page = await context.newPage();
  const errors = [];
  page.on("console", (m) => m.type() === "error" && errors.push(m.text().slice(0, 300)));
  const res = await page.request.post("/api/role", { data: { role } });
  if (!res.ok()) throw new Error(`role ${role}: HTTP ${res.status()}`);
  const out = { label, base, role, width, capturedAt: new Date().toISOString(), surfaces: {} };
  for (const s of surfaces) {
    const response = await page.goto(s.path, { waitUntil: "domcontentloaded" });
    const status = response ? response.status() : null;
    const found = await page.locator(s.wait).first().waitFor({ timeout: 60_000 }).then(() => true, () => false);
    // Let streamed sections land: wait until no "Loading" placeholder is busy, at most 20 s.
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 20_000 }).catch(() => {});
    const texts = {};
    for (const sel of s.grab) {
      texts[sel] = await page.locator(sel).evaluateAll((els) => els.map((e) => (e.textContent || "").replace(/\s+/g, " ").trim()).filter(Boolean)).catch(() => []);
    }
    const shot = path.join(outDir, `${label}-${s.name}-${width}.jpg`);
    await page.screenshot({ path: shot, fullPage: true, type: "jpeg", quality: 80 });
    out.surfaces[s.name] = { url: s.path, status, found, texts, screenshot: path.basename(shot) };
    console.log(`${s.name}: ${status} ${found ? "found" : "NOT FOUND"}`);
  }
  out.consoleErrors = errors;
  fs.writeFileSync(path.join(outDir, `${label}-${role}-${width}.json`), JSON.stringify(out, null, 2));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
