// The B09 polish as rendered (docs/agent-work/HOLD-TO-DECISION.md §9): the same first screen before
// and after, at 5 of 18 and at 18 of 18; the phone view with a missing date's evidence open; and the
// checks a reviewer makes by eye, measured: clipping, contrast, keyboard focus and target size.
//   node docs/agent-work/hold-to-decision/harness/polish.cjs <outDir>
// Reads only. Before = the build of 718e4aa (C:/Temp/rso-hold); after = the working tree's build.
// Each state's two servers read the same isolated database, so only the build differs.
const { createRequire } = require("node:module");
const fs = require("node:fs");
const path = require("node:path");
const req = createRequire(path.resolve(__dirname, "../../../../package.json"));
const { chromium } = req("@playwright/test");

const out = path.resolve(process.argv[2] ?? "polish");
const URL_PATH = "/exceptions/2455?period=oct&channel=google_lsa&week=2026-10-26";
const SERVERS = {
  "before-5of18": "http://localhost:3999",
  "after-5of18": "http://localhost:3996",
  "before-18of18": "http://localhost:4000",
  "after-18of18": "http://localhost:3997",
};
const DESKTOP = { viewport: { width: 1440, height: 900 } };
const PHONE = (width) => ({ viewport: { width, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
const ZOOM200 = { viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 };

fs.mkdirSync(out, { recursive: true });
const buildId = (dir) => {
  try {
    return fs.readFileSync(path.join(dir, ".next/BUILD_ID"), "utf8").trim();
  } catch {
    return null;
  }
};
const checks = { builds: { before: buildId("C:/Temp/rso-hold"), after: buildId(path.resolve(__dirname, "../../../..")) } };

async function open(browser, base, opts) {
  const context = await browser.newContext({ baseURL: base, reducedMotion: "reduce", ...opts });
  const page = await context.newPage();
  const res = await page.request.post("/api/role", { data: { role: "marketing" } });
  if (!res.ok()) throw new Error(`role: HTTP ${res.status()}`);
  await page.goto(URL_PATH, { waitUntil: "load" });
  await page.locator("#recovery").first().waitFor({ timeout: 60_000 });
  await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 20_000 }).catch(() => {});
  // The strip is a client component: wait until React has hydrated its buttons before pressing keys.
  if (await page.locator('[data-testid="window-strip"]').count()) {
    await page.waitForFunction(() => {
      const b = document.querySelector('[data-testid="window-strip"] button');
      return !!b && Object.keys(b).some((k) => k.startsWith("__reactProps"));
    }, null, { timeout: 30_000 });
  }
  await page.evaluate(() => window.scrollTo(0, 0));
  return { context, page };
}

// Measured in the page: horizontal overflow, anything in #recovery that runs past the viewport, the
// strip's target sizes, and the contrast of the text a reader has to read (WCAG 2.x ratio).
function measure() {
  const lum = ([r, g, b]) => {
    const c = [r, g, b].map((v) => {
      v /= 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
  };
  const rgb = (s) => (s.match(/[\d.]+/g) ?? []).slice(0, 4).map(Number);
  const ratio = (a, b) => {
    const [l1, l2] = [lum(a), lum(b)].sort((x, y) => y - x);
    return Math.round(((l1 + 0.05) / (l2 + 0.05)) * 100) / 100;
  };
  const bgOf = (el) => {
    for (let n = el; n; n = n.parentElement) {
      const c = rgb(getComputedStyle(n).backgroundColor);
      if (c.length >= 3 && (c.length === 3 || c[3] > 0)) return c.slice(0, 3);
    }
    return [255, 255, 255];
  };
  const contrast = {};
  const probe = (name, el) => {
    if (!el) return;
    const style = getComputedStyle(el);
    contrast[name] = { ratio: ratio(rgb(style.color).slice(0, 3), bgOf(el)), color: style.color, size: style.fontSize, weight: style.fontWeight };
  };
  const q = (s) => document.querySelector(s);
  probe("verdict", q('[data-testid="recovery-headline"]'));
  probe("status", q('[data-testid="recovery-status"]'));
  probe("next", q('[data-testid="recovery-next"]'));
  probe("scope", q('[data-testid="incident-scope"]'));
  probe("legend", q('[data-testid="window-legend"] li'));
  probe("stripDay", q('[data-testid="window-strip"] button[aria-checked="false"] span:nth-child(2)'));
  probe("factWeekDetail", q('[data-testid="fact-week"] p:nth-child(2)'));
  probe("factWindowTitle", q('[data-testid="fact-window"] p'));
  probe("factWindowDetail", q('[data-testid="fact-window"] p:nth-child(2)'));
  probe("evidenceLabel", q('[data-testid="day-evidence"] dt'));
  probe("evidenceText", q('[data-testid="day-why"]'));
  probe("evidenceRawId", q('[data-testid="day-received"] .font-mono'));
  probe("movedLabel", q('[data-testid="money-moved"] header span, [data-testid="money-moved"] h3 + span'));
  probe("movedChange", q('[data-testid="money-moved"] [data-testid="recovery-change"]'));
  probe("movedFootnote", q('[data-testid="money-moved"] > p:last-child'));
  const vw = window.innerWidth;
  const root = q("#recovery");
  const pastEdge = root
    ? [...root.querySelectorAll("*")]
        .filter((el) => {
          const r = el.getBoundingClientRect();
          return r.width > 0 && (r.right > vw + 0.5 || r.left < -0.5) && getComputedStyle(el).position !== "fixed";
        })
        .map((el) => el.dataset.testid ?? el.tagName.toLowerCase())
        .slice(0, 10)
    : [];
  const strip = [...document.querySelectorAll('[data-testid="window-strip"] button')].map((b) => b.getBoundingClientRect());
  const box = (s) => {
    const el = q(s);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { top: Math.round(r.top + scrollY), bottom: Math.round(r.bottom + scrollY), left: Math.round(r.left), right: Math.round(r.right) };
  };
  return {
    viewport: { width: vw, height: window.innerHeight },
    pageOverflowX: document.scrollingElement.scrollWidth - vw,
    pastEdge,
    strip: strip.length ? { count: strip.length, minWidth: Math.round(Math.min(...strip.map((r) => r.width))), minHeight: Math.round(Math.min(...strip.map((r) => r.height))), rows: new Set(strip.map((r) => Math.round(r.top))).size } : null,
    verdictColor: q('[data-testid="recovery-headline"]') ? getComputedStyle(q('[data-testid="recovery-headline"]')).color : null,
    boxes: {
      verdict: box('[data-testid="recovery-headline"]'),
      primary: box('[data-testid="recovery-records"], [data-testid="recovery-decisions"]'),
      strip: box('[data-testid="window-strip"]'),
      factWeek: box('[data-testid="fact-week"]'),
      factWindow: box('[data-testid="fact-window"]'),
      evidence: box('[data-testid="day-evidence"]'),
      hint: box('[data-testid="day-hint"]'),
      moved: box('[data-testid="money-moved"]'),
      movedTotal: box('[data-testid="moved-total"]'),
      noBudget: (() => {
        const p = q('[data-testid="recovery-next"]');
        return p && /No budget change was approved/.test(p.textContent) ? box('[data-testid="recovery-next"]') : null;
      })(),
    },
    contrast,
  };
}

async function shoot(page, name) {
  await page.screenshot({ path: path.join(out, `${name}.jpg`), type: "jpeg", quality: 90 });
}

(async () => {
  const browser = await chromium.launch();
  try {
    // 1. The same desktop frame, before and after, in both states.
    for (const [name, base] of Object.entries(SERVERS)) {
      const { context, page } = await open(browser, base, DESKTOP);
      await shoot(page, `${name}-1440`);
      checks[`${name}-1440`] = await page.evaluate(measure);
      await context.close();
    }

    // 2. Keyboard: Tab reaches the strip once (one tab stop), arrows move the date and its evidence.
    {
      const { context, page } = await open(browser, SERVERS["after-5of18"], DESKTOP);
      let tabs = 0;
      for (; tabs < 40; tabs++) {
        const role = await page.evaluate(() => document.activeElement?.getAttribute("role"));
        if (role === "radio") break;
        await page.keyboard.press("Tab");
      }
      const at = () => page.evaluate(() => ({ focused: document.activeElement?.dataset.date ?? null, checked: document.querySelector('[data-testid="window-strip"] [aria-checked="true"]')?.dataset.date ?? null, evidence: document.querySelector('[data-testid="day-evidence"]')?.dataset.date ?? null, focusVisible: document.activeElement?.matches(":focus-visible") ?? false }));
      const keyboard = { tabsToStrip: tabs, first: await at() };
      await page.keyboard.press("ArrowRight");
      keyboard.afterArrowRight = await at();
      await page.keyboard.press("End");
      keyboard.afterEnd = await at();
      await page.keyboard.press("Home");
      keyboard.afterHome = await at();
      for (let i = 0; i < 7; i++) await page.keyboard.press("ArrowRight");
      keyboard.afterSevenRight = await at();
      await page.keyboard.press("Tab");
      keyboard.tabLeavesStrip = await page.evaluate(() => document.activeElement?.dataset.testid ?? document.activeElement?.tagName ?? null);
      await page.keyboard.press("Shift+Tab");
      keyboard.shiftTabReturnsTo = await page.evaluate(() => document.activeElement?.dataset.date ?? null);
      await page.locator('[data-testid="decision-window"]').scrollIntoViewIfNeeded();
      await page.locator('[data-testid="decision-window"]').screenshot({ path: path.join(out, "after-5of18-focus-1440.jpg"), type: "jpeg", quality: 90 });
      checks.keyboard = keyboard;
      await context.close();
    }

    // 2b. At 18 of 18 no date is open: Tab lands on the first date unchecked, Space opens it.
    {
      const { context, page } = await open(browser, SERVERS["after-18of18"], DESKTOP);
      for (let i = 0; i < 40; i++) {
        if ((await page.evaluate(() => document.activeElement?.getAttribute("role"))) === "radio") break;
        await page.keyboard.press("Tab");
      }
      const at = () => page.evaluate(() => ({ focused: document.activeElement?.dataset.date ?? null, checked: document.querySelector('[data-testid="window-strip"] [aria-checked="true"]')?.dataset.date ?? null, evidence: document.querySelector('[data-testid="day-evidence"]')?.dataset.date ?? null, hint: document.querySelector('[data-testid="day-hint"]')?.textContent ?? null }));
      const keyboard = { first: await at() };
      await page.keyboard.press("Space");
      keyboard.afterSpace = await at();
      await page.keyboard.press("ArrowLeft");
      keyboard.afterArrowLeftAtStart = await at();
      checks.keyboard18 = keyboard;
      await context.close();
    }

    // 3. The phone, with a missing date's evidence open: tap Oct 20, then its records on the daily evidence.
    for (const width of [390, 320]) {
      const { context, page } = await open(browser, SERVERS["after-5of18"], PHONE(width));
      await shoot(page, `after-5of18-${width}`);
      checks[`after-5of18-${width}`] = await page.evaluate(measure);
      await page.locator('[data-testid="window-strip"] button[data-date="2026-10-20"]').tap();
      await page.locator('[data-testid="day-evidence"][data-date="2026-10-20"]').waitFor();
      const stripTop = await page.locator('[data-testid="decision-window"]').evaluate((el) => el.getBoundingClientRect().top + scrollY);
      await page.evaluate((y) => window.scrollTo(0, y - 72), stripTop);
      await shoot(page, `after-5of18-${width}-evidence`);
      checks[`after-5of18-${width}-evidence`] = await page.evaluate(measure);
      if (width === 390) {
        const href = await page.locator('[data-testid="day-records"]').getAttribute("href");
        await page.locator('[data-testid="day-records"]').tap();
        await page.waitForURL((u) => u.pathname.includes("/trace"), { timeout: 60_000 });
        // The daily evidence streams its records in: wait for the week's rows, then show them.
        const selection = page.locator('[data-testid="overview-selection"]:visible').first();
        await selection.waitFor({ timeout: 60_000 });
        await page.waitForFunction(() => !document.querySelector('[aria-busy="true"]'), null, { timeout: 20_000 }).catch(() => {});
        const rows = await page.locator('[data-testid="overview-selection"]:visible tr[data-day]').evaluateAll((trs) => trs.map((r) => (r.textContent ?? "").replace(/\s+/g, " ").trim()));
        const top = await page.locator("#selection").first().evaluate((el) => el.getBoundingClientRect().top + scrollY);
        await page.evaluate((y) => window.scrollTo(0, y - 72), top);
        checks.evidenceLink = { href, landed: page.url().replace(SERVERS["after-5of18"], ""), summary: (await page.locator('[data-testid="selection-summary"]:visible').first().innerText()).trim(), rows };
        await shoot(page, "after-5of18-390-records");
      }
      await context.close();
    }

    // 4. 18 of 18 on the phone: first screen, then what moved.
    {
      const { context, page } = await open(browser, SERVERS["after-18of18"], PHONE(390));
      await shoot(page, "after-18of18-390");
      checks["after-18of18-390"] = await page.evaluate(measure);
      const movedTop = await page.locator('[data-testid="money-moved"]').evaluate((el) => el.getBoundingClientRect().top + scrollY);
      await page.evaluate((y) => window.scrollTo(0, y - 72), movedTop);
      await shoot(page, "after-18of18-390-moved");
      await context.close();
    }

    // 5. 200% zoom (1440 at 200% is a 720 CSS px viewport).
    for (const name of ["after-5of18", "after-18of18"]) {
      const { context, page } = await open(browser, SERVERS[name], ZOOM200);
      await shoot(page, `${name}-zoom200`);
      checks[`${name}-zoom200`] = await page.evaluate(measure);
      await context.close();
    }
  } finally {
    await browser.close();
  }
  fs.writeFileSync(path.join(out, "checks.json"), JSON.stringify(checks, null, 2) + "\n");
  console.log(`wrote ${out}`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
