// The premium-polish scenes as rendered (docs/agent-work/PREMIUM-POLISH.md): the Overview's headline
// figure, B20's receipt, the incident queue, Decision Lab's verdict rows and the incident rail. Each
// scene is captured from two builds reading the same database, before and after, at 1440 and 390 px;
// then the checks a reviewer makes by eye are measured in the after build (checks.json).
//   node docs/agent-work/premium-polish/harness/scenes.cjs <outDir>
// Before = a build of 0d97c13 (C:/Temp/rso-hold, the same code) on :3990; after = the working
// tree's build on :3991; both in demo mode on revenue_signal_rc, freshly seeded. It reads, except
// for B20: it proposes, dry-runs and approves B20's replay through the API, and the after build's
// Execute applies it once, as the golden path does.
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const req = createRequire(path.resolve(__dirname, "../../../../package.json"));
const { chromium } = req("@playwright/test");

const out = path.resolve(process.argv[2] ?? "premium-polish");
const BEFORE = "http://localhost:3990";
const AFTER = "http://localhost:3991";
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 };
const WIDTHS = { 1440: DESKTOP, 390: PHONE };

fs.mkdirSync(out, { recursive: true });
const buildId = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, ".next/BUILD_ID"), "utf8").trim();
  } catch {
    return null;
  }
};
const checks = { builds: { before: buildId("C:/Temp/rso-hold"), after: buildId(path.resolve(__dirname, "../../../..")) }, scenes: {} };

async function open(browser, base, opts, role, url, motion = "reduce") {
  const context = await browser.newContext({ baseURL: base, reducedMotion: motion, ...opts });
  const page = await context.newPage();
  const res = await page.request.post("/api/role", { data: { role } });
  if (!res.ok()) throw new Error(`role ${role}: HTTP ${res.status()}`);
  if (url) {
    await page.goto(url, { waitUntil: "load" });
    await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 60_000 }).catch(() => {});
    await page.waitForLoadState("networkidle").catch(() => {});
  }
  return { context, page };
}

const shot = (page, name, opts = {}) => page.screenshot({ path: path.join(out, `${name}.jpg`), type: "jpeg", quality: 82, ...opts });

/** Scrolls a section to the top of the viewport, under the sticky top bar. */
async function scrollTo(page, selector, offset = 64) {
  await page.locator(selector).first().waitFor({ timeout: 60_000 });
  await page.evaluate(([s, o]) => {
    const el = document.querySelector(s);
    window.scrollTo(0, el.getBoundingClientRect().top + window.scrollY - o);
  }, [selector, offset]);
  await page.waitForTimeout(250);
}

const overflow = (page) => page.evaluate(() => document.scrollingElement.scrollWidth - window.innerWidth);

/** WCAG 2.x contrast of an element's text against the first opaque background behind it. */
function contrastOf(selectors) {
  const lum = ([r, g, b]) => {
    const c = [r, g, b].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const rgb = (s) => (s.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c.length === 3 || c[3] > 0)) return c.slice(0, 3);
    }
    return [255, 255, 255];
  };
  const result = {};
  for (const [name, selector] of Object.entries(selectors)) {
    const el = document.querySelector(selector);
    if (!el) continue;
    const style = getComputedStyle(el);
    const [l1, l2] = [lum(rgb(style.color).slice(0, 3)), lum(bgOf(el))].sort((x, y) => y - x);
    result[name] = { ratio: Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100, color: style.color, size: style.fontSize, weight: style.fontWeight };
  }
  return result;
}

async function overview(browser) {
  const c = (checks.scenes.overview = {});
  for (const [w, opts] of Object.entries(WIDTHS)) {
    for (const [label, base] of [["before", BEFORE], ["after", AFTER]]) {
      const { context, page } = await open(browser, base, opts, "marketing", "/?period=oct");
      await page.evaluate(() => window.scrollTo(0, 0));
      await shot(page, `${label}-overview-${w}`);
      if (label === "after") c[`overflow${w}`] = await overflow(page);
      await context.close();
    }
  }
  // The count, with motion allowed: the figure's text is the final value from the first frame; the
  // moving figure is painted over it and lets go when the count ends.
  const { context, page } = await open(browser, AFTER, DESKTOP, "marketing", null, "no-preference");
  await page.goto("/?period=oct", { waitUntil: "commit" });
  await page.locator('[data-testid="at-risk-figure"]').waitFor({ timeout: 60_000 });
  const first = await page.locator('[data-testid="at-risk-figure"]').evaluate((el) => ({ text: el.textContent, display: el.getAttribute("data-display"), counted: el.hasAttribute("data-counted") }));
  await page.waitForFunction(() => {
    const d = document.querySelector('[data-testid="at-risk-figure"]')?.getAttribute("data-display") ?? "";
    return d !== "$0" && d !== "";
  }, null, { timeout: 10_000 }).catch(() => {});
  await page.waitForTimeout(150);
  const mid = await page.locator('[data-testid="at-risk-figure"]').evaluate((el) => ({ text: el.textContent, display: el.getAttribute("data-display"), counted: el.hasAttribute("data-counted"), overlay: getComputedStyle(el, "::after").content, textColor: getComputedStyle(el.firstElementChild).color }));
  await shot(page, "after-overview-counting-1440", { clip: { x: 240, y: 40, width: 1200, height: 260 } });
  await page.waitForFunction(() => document.querySelector('[data-testid="at-risk-figure"]')?.hasAttribute("data-counted"), null, { timeout: 10_000 });
  const end = await page.locator('[data-testid="at-risk-figure"]').evaluate((el) => ({ text: el.textContent, display: el.getAttribute("data-display"), overlay: getComputedStyle(el, "::after").content, textColor: getComputedStyle(el.firstElementChild).color }));
  c.counter = { firstFrame: first, midCount: mid, settled: end };
  await context.close();
  // Reduced motion: no count at all, the figure settles on mount.
  const reduced = await open(browser, AFTER, DESKTOP, "marketing", "/?period=oct", "reduce");
  c.counter.reducedMotion = await reduced.page.locator('[data-testid="at-risk-figure"]').evaluate((el) => ({ text: el.textContent, counted: el.hasAttribute("data-counted"), overlay: getComputedStyle(el, "::after").content }));
  c.contrast = await reduced.page.evaluate(contrastOf, { figure: '[data-testid="at-risk-figure"] .count-up-value', sentence: '[data-testid="headline-at-risk"] p:nth-of-type(2)', kpiDelta: ".tabular-nums svg + *" });
  await reduced.context.close();
}

async function queue(browser) {
  const c = (checks.scenes.queue = {});
  for (const [w, opts] of Object.entries(WIDTHS)) {
    for (const [label, base] of [["before", BEFORE], ["after", AFTER]]) {
      const { context, page } = await open(browser, base, opts, "marketing", "/exceptions");
      await scrollTo(page, "#queue");
      await shot(page, `${label}-queue-${w}`);
      if (label === "after") c[`overflow${w}`] = await overflow(page);
      await context.close();
    }
  }
  // Keyboard: the groups are buttons in reading order; the first starts open, Enter opens another.
  const { context, page } = await open(browser, AFTER, DESKTOP, "marketing", "/exceptions");
  const buttons = page.locator('[data-testid="case-queue"] tbody th button');
  c.groups = await buttons.evaluateAll((bs) => bs.map((b) => ({ name: b.textContent.trim(), expanded: b.getAttribute("aria-expanded") })));
  await buttons.nth(3).focus();
  await page.keyboard.press("Enter");
  c.keyboard = {
    focused: await page.evaluate(() => document.activeElement?.textContent?.trim()),
    expandedAfterEnter: await buttons.nth(3).getAttribute("aria-expanded"),
    rowsShown: await page.locator('[data-testid="case-queue"] tbody').nth(3).locator("tr[data-case-row]:visible").count(),
  };
  await scrollTo(page, "#queue");
  await shot(page, "after-queue-keyboard-1440");
  c.contrast = await page.evaluate(contrastOf, { groupName: '[data-testid="case-queue"] tbody th button span.truncate', groupAmount: '[data-testid="case-queue"] tbody tr:first-child td:nth-last-child(2) span', header: '[data-testid="case-queue"] thead th' });
  await context.close();
}

async function lab(browser) {
  const c = (checks.scenes.lab = {});
  for (const [w, opts] of Object.entries(WIDTHS)) {
    for (const [label, base] of [["before", BEFORE], ["after", AFTER]]) {
      const { context, page } = await open(browser, base, opts, "marketing", "/decisions?branch=B09&period=oct");
      await scrollTo(page, "#verdicts", 110);
      await shot(page, `${label}-lab-${w}`);
      if (label === "after") {
        c[`overflow${w}`] = await overflow(page);
        // Open the first channel's row from the keyboard: its three verdicts' reasons, in place.
        const summary = page.locator('[data-testid^="verdict-row-"] summary').first();
        await summary.focus();
        await page.keyboard.press("Enter");
        await page.waitForTimeout(200);
        c[`openFromKeyboard${w}`] = await page.locator('[data-testid^="verdict-row-"] details').first().evaluate((d) => d.open);
        await scrollTo(page, "#verdicts", 110);
        await shot(page, `after-lab-open-${w}`);
      }
      await context.close();
    }
  }
  const { context, page } = await open(browser, AFTER, DESKTOP, "marketing", "/decisions?branch=B09&period=oct");
  c.rows = await page.locator('[data-testid^="verdict-row-"]').evaluateAll((rs) => rs.map((r) => ({ row: r.dataset.testid, chips: [...r.querySelectorAll("summary .rounded")].map((b) => b.textContent.trim()) })));
  c.contrast = await page.evaluate(contrastOf, { channel: '[data-testid^="verdict-row-"] summary span.truncate', meta: '[data-testid^="verdict-row-"] summary span.text-faint', columnHeader: "#verdicts [aria-hidden] span" });
  await context.close();
}

async function b20Href(browser) {
  const { context, page } = await open(browser, AFTER, DESKTOP, "engineer", null);
  const res = await page.request.get(`/api/search?q=B20`);
  const { hits } = await res.json();
  await context.close();
  const hit = hits.find((h) => h.kind === "incident" && /Quarantined/.test(h.title));
  if (!hit) throw new Error("B20's quarantine incident was not found");
  return hit.href;
}

async function rail(browser, href) {
  const c = (checks.scenes.rail = {});
  for (const [w, opts] of Object.entries(WIDTHS)) {
    for (const [label, base] of [["before", BEFORE], ["after", AFTER]]) {
      const { context, page } = await open(browser, base, opts, "engineer", href);
      const aside = page.locator('aside[aria-label="Decision and role"]');
      await aside.waitFor({ timeout: 60_000 });
      if (w === "1440") {
        await page.evaluate(() => window.scrollTo(0, 0));
        await shot(page, `${label}-rail-${w}`);
      } else {
        await scrollTo(page, 'aside[aria-label="Decision and role"]', 8);
        await shot(page, `${label}-rail-${w}`);
      }
      if (label === "after") {
        c[`overflow${w}`] = await overflow(page);
        c[`cards${w}`] = await aside.locator("section").evaluateAll((ss) => ss.map((s) => ({ title: s.querySelector("h2")?.textContent, size: s.dataset.size, height: Math.round(s.getBoundingClientRect().height) })));
      }
      await context.close();
    }
  }
  const { context, page } = await open(browser, AFTER, DESKTOP, "engineer", href);
  c.freshness = await page.locator('[data-testid="rail-freshness"]').innerText().catch(() => null);
  c.contrast = await page.evaluate(contrastOf, { notYourRole: '[data-testid="rail-steps"] li span.text-faint', youCan: '[data-testid="rail-steps"] li span.text-good', feed: '[data-testid="rail-freshness"] li p' });
  await context.close();
}

/** Proposes, dry-runs and approves B20's replay through the API: the state the Execute button needs. */
async function prepareB20(browser, href) {
  const exceptionId = Number(href.match(/\/exceptions\/(\d+)/)[1]);
  const { context, page } = await open(browser, AFTER, DESKTOP, "engineer", null);
  const post = async (url, data) => {
    const res = await page.request.post(url, { data, timeout: 120_000 });
    const body = await res.json();
    if (!res.ok()) throw new Error(`${url}: HTTP ${res.status()} ${JSON.stringify(body)}`);
    return body;
  };
  const { proposal } = await post("/api/proposals", { exceptionId, kind: "replay_quarantine", params: { mapperVersion: "1.1" }, rationale: "calls@1.1 reads the renamed caller field; replay the held records" });
  await post(`/api/proposals/${proposal.id}`, { action: "dry_run" });
  await page.request.post("/api/role", { data: { role: "approver" } });
  await post(`/api/proposals/${proposal.id}`, { action: "approve", reason: "The dry run projects every held record and keeps the ledger whole" });
  await context.close();
  return proposal.id;
}

async function receipt(browser, href) {
  const c = (checks.scenes.b20 = {});
  c.proposalId = await prepareB20(browser, href);
  const card = '[data-testid="proposal"]';
  // Idle and working, in both builds. The working frame holds the request and then aborts it, so
  // nothing is executed here; the error that follows is not captured.
  for (const [label, base] of [["before", BEFORE], ["after", AFTER]]) {
    const { context, page } = await open(browser, base, DESKTOP, "approver", href);
    await scrollTo(page, card, 80);
    await shot(page, `${label}-b20-approved-1440`);
    let release;
    await page.route(/\/api\/proposals\/\d+$/, (route) => new Promise((resolve) => (release = () => resolve(route.abort()))));
    await page.locator(card).first().getByRole("button", { name: "Execute (application, once)" }).click();
    await page.waitForTimeout(400);
    await shot(page, `${label}-b20-executing-1440`, { clip: await page.locator(card).first().boundingBox() });
    if (label === "after") c.executing = await page.locator(card).first().getByRole("button", { name: /Executing/ }).evaluate((b) => ({ ariaDisabled: b.getAttribute("aria-disabled"), disabled: b.disabled, focusable: b.tabIndex >= 0, spinner: !!b.querySelector("svg.animate-spin") }));
    release();
    await page.waitForTimeout(300);
    await context.close();
  }
  // The real execution, once, through the after build's button: the receipt takes focus.
  {
    const { context, page } = await open(browser, AFTER, DESKTOP, "approver", href);
    await scrollTo(page, card, 80);
    const done = page.waitForResponse((r) => /\/api\/proposals\/\d+$/.test(r.url()) && r.request().method() === "POST", { timeout: 120_000 });
    await page.locator(card).first().getByRole("button", { name: "Execute (application, once)" }).click();
    c.executeStatus = (await done).status();
    await page.locator('[data-testid="execution-result"]').first().waitFor({ timeout: 60_000 });
    await page.waitForFunction(() => document.activeElement?.getAttribute("data-testid") === "execution-result", null, { timeout: 20_000 }).catch(() => {});
    c.focusAfterExecute = await page.evaluate(() => document.activeElement?.getAttribute("data-testid"));
    c.status = await page.locator(card).first().getByRole("status").innerText();
    c.headline = await page.locator('[data-testid="execution-result"] [data-testid="receipt-headline"]').first().innerText().catch(() => null);
    c.conserved = await page.locator('[data-testid="execution-result"]').first().getByText("conserved", { exact: true }).count();
    await context.close();
  }
  for (const [w, opts] of Object.entries(WIDTHS)) {
    for (const [label, base] of [["before", BEFORE], ["after", AFTER]]) {
      const { context, page } = await open(browser, base, opts, "approver", href);
      await scrollTo(page, '[data-testid="execution-result"]', w === "1440" ? 120 : 72);
      await shot(page, `${label}-b20-receipt-${w}`);
      if (label === "after") {
        c[`overflow${w}`] = await overflow(page);
        if (w === "1440") {
          await page.locator('[data-testid="idempotency-proof"] summary').first().click();
          c.proofOpens = await page.locator('[data-testid="idempotency-proof"]').first().evaluate((d) => d.open && /Idempotency-Key/.test(d.textContent));
          c.contrast = await page.evaluate(contrastOf, { headline: '[data-testid="receipt-headline"] span:last-child', unchanged: '[data-testid="execution-result"] td span.text-muted', section: '[data-testid="execution-result"] th[scope="rowgroup"]', outcome: '[data-testid="execution-result"] .bg-good-soft p span' });
        }
      }
      await context.close();
    }
  }
}

(async () => {
  const browser = await chromium.launch();
  try {
    await overview(browser);
    await queue(browser);
    await lab(browser);
    const href = await b20Href(browser);
    checks.b20Href = href;
    await rail(browser, href);
    await receipt(browser, href);
  } finally {
    fs.writeFileSync(path.join(out, "checks.json"), `${JSON.stringify(checks, null, 1)}\n`);
    await browser.close();
  }
  console.log(JSON.stringify(checks, null, 1));
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
