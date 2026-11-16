// The changed path as a reader sees it, per state (HOLD-TO-DECISION.md §5): desktop and phone captures,
// one open evidence state, the 320 px and 200% zoom checks, and what sits above the fold.
//   node docs/agent-work/hold-to-decision/harness/states.cjs <baseUrl> <outDir> <state> <incidentId> [panel=recovery|hold]
// Reads only. The role is the demo's Marketing analyst (POST /api/role).
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const req = createRequire(path.resolve(__dirname, "../../../../package.json"));
const { chromium } = req("@playwright/test");

const [base, outDir, state, incident, panel = "recovery"] = process.argv.slice(2);
const WEEK = state === "missing" || state === "partial" ? "2026-10-12" : "2026-10-19";
const CTX = `period=oct&channel=google_lsa&week=${WEEK}`;
const pages = {
  overview: `/?period=oct&branch=B09&channel=google_lsa&week=${WEEK}#movement`,
  evidence: `/branches/B09/trace?period=oct&metric=paid_spend&channel=google_lsa&week=${WEEK}`,
  incident: `/exceptions/${incident}?${CTX}#recovery`,
  lab: `/decisions?branch=B09&${CTX}`,
};
const ready = { overview: '[data-testid="movement-trust"]', evidence: '[data-testid="overview-selection"]', incident: "#recovery", lab: '[data-testid="readiness-summary"]' };
const headline = panel === "hold" ? '[data-testid="hold-headline"]' : '[data-testid="recovery-headline"]';
const primary = panel === "hold" ? '[data-testid="hold-records"], [data-testid="hold-decisions"]' : '[data-testid="recovery-records"], [data-testid="recovery-decisions"]';
const details = panel === "hold" ? '[data-testid="hold-details"]' : '[data-testid="recovery-details"]';

async function open(context, url, wait) {
  const page = await context.newPage();
  const res = await page.request.post("/api/role", { data: { role: "marketing" } });
  if (!res.ok()) throw new Error(`role: HTTP ${res.status()}`);
  await page.goto(url, { waitUntil: "domcontentloaded" });
  await page.locator(wait).filter({ visible: true }).first().waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 20_000 }).catch(() => {});
  return page;
}

const overflow = (page) => page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, innerWidth: window.innerWidth, overflows: document.documentElement.scrollWidth > window.innerWidth + 1 }));

(async () => {
  fs.mkdirSync(outDir, { recursive: true });
  const browser = await chromium.launch();
  const out = { state, base, incident, capturedAt: new Date().toISOString(), widths: {}, zoom200: {}, w320: {}, foldDesktop: null, phoneOrder: null, evidenceOpen: null };

  for (const width of [1440, 390]) {
    const context = await browser.newContext({ baseURL: base, viewport: { width, height: width === 390 ? 844 : 900 }, ...(width === 390 ? { isMobile: true, hasTouch: true, deviceScaleFactor: 2 } : {}) });
    for (const [name, url] of Object.entries(pages)) {
      const page = await open(context, url, ready[name]);
      const file = `${state}-${name}-${width}.jpg`;
      await page.screenshot({ path: path.join(outDir, file), fullPage: true, type: "jpeg", quality: 82 });
      out.widths[`${name}-${width}`] = { file, ...(await overflow(page)) };
      if (name === "incident" && width === 1440) {
        // Above the fold on desktop: the decision, why, and the one next action.
        out.foldDesktop = await page.evaluate(({ headline, primary }) => {
          const box = (sel) => { const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null); if (!el) return null; const r = el.getBoundingClientRect(); return { top: Math.round(r.top + window.scrollY), bottom: Math.round(r.bottom + window.scrollY), text: (el.textContent || "").trim().slice(0, 120) }; };
          return { viewport: window.innerHeight, headline: box(headline), primary: box(primary) };
        }, { headline, primary });
        // Keyboard: Tab to the primary action; its focus must be visible.
        await page.evaluate(() => window.scrollTo(0, 0));
        let focused = null;
        for (let i = 0; i < 40; i++) {
          await page.keyboard.press("Tab");
          focused = await page.evaluate((primary) => { const a = document.activeElement; return a && a.matches(primary) ? { text: (a.textContent || "").trim(), visible: a.matches(":focus-visible"), outline: getComputedStyle(a).outlineStyle } : null; }, primary);
          if (focused) break;
        }
        out.keyboardPrimary = focused;
      }
      if (name === "incident" && width === 390) {
        // Phone: the reading order of the decision, the reason and the action against the rest of the page.
        out.phoneOrder = await page.evaluate(({ headline, primary }) => {
          const top = (sel) => { const el = [...document.querySelectorAll(sel)].find((e) => e.offsetParent !== null); return el ? Math.round(el.getBoundingClientRect().top + window.scrollY) : null; };
          return { headline: top(headline), primary: top(primary), impact: top('[data-testid="incident-impact"]'), evidence: top("#evidence"), workflow: top("#action-center"), records: top("#records") };
        }, { headline, primary });
        // One open evidence state: the details opened from the keyboard, captured, then closed.
        const summary = page.locator(`${details} > summary`).filter({ visible: true }).first();
        await summary.focus();
        await page.keyboard.press("Enter");
        await page.waitForTimeout(150);
        // Centered, so the sticky header never covers the summary that was just opened.
        await summary.evaluate((el) => el.scrollIntoView({ block: "center" }));
        await page.screenshot({ path: path.join(outDir, `${state}-incident-390-evidence-open.jpg`), fullPage: false, type: "jpeg", quality: 82 });
        const opened = await page.locator(details).filter({ visible: true }).first().evaluate((d) => d.open);
        const focusVisible = await summary.evaluate((el) => document.activeElement === el && el.matches(":focus-visible"));
        await page.keyboard.press("Enter");
        const closed = await page.locator(details).filter({ visible: true }).first().evaluate((d) => !d.open);
        const focusKept = await summary.evaluate((el) => document.activeElement === el);
        out.evidenceOpen = { file: `${state}-incident-390-evidence-open.jpg`, opened, focusVisible, closed, focusKept, overflow: await overflow(page) };
      }
      await page.close();
    }
    await context.close();
  }

  // 320 px: no page-level sideways scroll on the changed path.
  {
    const context = await browser.newContext({ baseURL: base, viewport: { width: 320, height: 700 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    for (const [name, url] of Object.entries(pages)) {
      const page = await open(context, url, ready[name]);
      out.w320[name] = await overflow(page);
      if (name === "incident") await page.screenshot({ path: path.join(outDir, `${state}-incident-320.jpg`), fullPage: false, type: "jpeg", quality: 80 });
      await page.close();
    }
    await context.close();
  }

  // 200% zoom of a 1440 x 900 window: 720 x 450 CSS pixels at twice the density.
  {
    const context = await browser.newContext({ baseURL: base, viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
    for (const [name, url] of Object.entries(pages)) {
      const page = await open(context, url, ready[name]);
      out.zoom200[name] = await overflow(page);
      if (name === "incident") await page.screenshot({ path: path.join(outDir, `${state}-incident-zoom200.jpg`), fullPage: false, type: "jpeg", quality: 80 });
      await page.close();
    }
    await context.close();
  }

  fs.writeFileSync(path.join(outDir, `${state}-checks.json`), JSON.stringify(out, null, 2));
  console.log(JSON.stringify({ state, foldDesktop: out.foldDesktop, keyboardPrimary: out.keyboardPrimary, phoneOrder: out.phoneOrder, evidenceOpen: out.evidenceOpen, w320: out.w320, zoom200: out.zoom200 }, null, 1));
  await browser.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
