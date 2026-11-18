/**
 * The states a cold reviewer can meet on the ★ routes (RELEASE-DESIGN.md §6, WP-J step 2), each
 * with a screenshot and a pass or fail line:
 *
 *   node states.cjs <baseUrl> <outMd> [nodeModulesDir]
 *
 * Run against `next start` with DEMO_MODE=1 and PUBLIC_WORKSPACE=1 on a seeded database that is not
 * the demo's: the role picker sets the staff roles, and each fresh browser context is a new visitor
 * with an empty workspace.
 *
 * - loaded: every route at 1440, 390 and 320 px and at 200% zoom (720 × 450 CSS px at device scale
 *   2), as the guest and as the role that acts there: no sideways scroll, at most one visible
 *   primary action, and exactly one where the table below says the role has a next step;
 * - loading: a client navigation to the route with its server response held for 1.5 s, then let go;
 * - empty: a fresh visitor's /onboarding and /investigator;
 * - failed: the upload, the dry run and the question each answered 500 by `page.route`;
 * - restricted: the guest on an incident (no case controls), the B20 partner on B09's trace.
 *
 * Screenshots go next to <outMd>, in states/. Exit 1 if any line fails.
 */
const path = require("node:path");
const fs = require("node:fs");

const [, , baseUrl, outMd, modulesDir] = process.argv;
if (!baseUrl || !outMd) {
  console.error("usage: node states.cjs <baseUrl> <outMd> [nodeModulesDir]");
  process.exit(2);
}
const { chromium } = require(path.join(modulesDir ?? path.resolve("node_modules"), "playwright"));
const shots = path.join(path.dirname(outMd), "states");
fs.mkdirSync(shots, { recursive: true });

const VIEWPORTS = [
  { name: "1440", viewport: { width: 1440, height: 900 }, scale: 1 },
  { name: "390", viewport: { width: 390, height: 844 }, scale: 1 },
  { name: "320", viewport: { width: 320, height: 720 }, scale: 1 },
  { name: "zoom200", viewport: { width: 720, height: 450 }, scale: 2 },
];
const PRIMARY = '[data-variant="primary"]';
const lines = [];
let failed = 0;

function record(state, route, role, width, ok, detail, shot) {
  if (!ok) failed += 1;
  lines.push(`| ${state} | \`${route}\` | ${role} | ${width} | ${ok ? "pass" : "**fail**"} | ${detail} | ${shot ? `[png](states/${shot})` : ""} |`);
  console.log(`${ok ? "pass" : "FAIL"} ${state} ${route} ${role} ${width} ${detail}`);
}

async function contextFor(browser, role, vp = VIEWPORTS[0]) {
  const context = await browser.newContext({ viewport: vp.viewport, deviceScaleFactor: vp.scale });
  if (role !== "guest") {
    const res = await context.request.post(baseUrl + "/api/role", { data: { role } });
    if (!res.ok()) throw new Error(`role ${role}: ${res.status()}`);
  }
  return context;
}

/** Sideways scroll, visible primaries and the h1, once the page has settled. */
async function inspect(page) {
  await page.waitForLoadState("load");
  await page.locator("h1").first().waitFor({ state: "visible", timeout: 60_000 });
  // React reveals streamed sections in batches after the load event: let them land.
  await page.waitForTimeout(1200);
  return page.evaluate((sel) => {
    const visible = (el) => {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none" && !el.closest("[hidden]");
    };
    const root = document.scrollingElement;
    return {
      sideways: root.scrollWidth > window.innerWidth + 1,
      primaries: [...document.querySelectorAll(sel)].filter(visible).map((el) => (el.textContent ?? "").trim().slice(0, 40)),
      h1: (document.querySelector("h1")?.textContent ?? "").trim().slice(0, 60),
    };
  }, PRIMARY);
}

const slug = (s) => s.replace(/[^a-z0-9]+/gi, "-").replace(/^-|-$/g, "").slice(0, 60);

/** A guest's workspace upload of the call sample, compared: returns the result's path. */
async function workspaceUpload(page) {
  await page.goto(baseUrl + "/onboarding");
  const sample = page.getByTestId("sample-demo-calls.csv");
  await sample.waitFor({ state: "visible", timeout: 60_000 });
  await sample.click();
  await page.waitForURL(/\/onboarding\/\d+/, { timeout: 60_000 });
  await page.locator('[data-testid="propose-and-dry-run"], [data-testid="upload-result"]').first().waitFor({ state: "visible", timeout: 60_000 });
  const go = page.getByTestId("propose-and-dry-run");
  if (await go.count()) {
    const questions = page.getByTestId("mapping-questions");
    if (await questions.count()) {
      const mdy = questions.getByLabel("month first (March 4)");
      if (await mdy.count()) await mdy.check();
      const local = questions.getByLabel(/branch local time/);
      if (await local.count()) await local.check();
    }
    await go.click();
  }
  await page.getByTestId("upload-result").waitFor({ state: "visible", timeout: 90_000 });
  return new URL(page.url()).pathname;
}

/** A guest's question, answered by the deterministic path: returns the investigation's path. */
async function workspaceQuestion(page) {
  await page.goto(baseUrl + "/investigator");
  await page.getByLabel("Question").fill("Why did B20's CAC jump in October?");
  await page.getByLabel("Question").press("Control+Enter");
  await page.waitForURL(/\/investigator\/\d+$/, { timeout: 90_000 });
  return new URL(page.url()).pathname;
}

(async () => {
  const browser = await chromium.launch();

  // The ids the routes need: an open incident (as the engineer who can act on it), and a guest's
  // own upload and question, made in one visitor's context that the guest rows reuse.
  const engineer = await contextFor(browser, "engineer");
  const ep = await engineer.newPage();
  await ep.goto(baseUrl + "/exceptions");
  const incident = await ep.locator('a[href^="/exceptions/"]').evaluateAll((as) => as.map((a) => a.getAttribute("href")).find((h) => /^\/exceptions\/\d+$/.test(h ?? "")));
  await engineer.close();
  if (!incident) throw new Error("no open incident is listed on /exceptions");

  const visitor = await browser.newContext({ viewport: VIEWPORTS[0].viewport });
  const vp0 = await visitor.newPage();
  const uploadPath = await workspaceUpload(vp0);
  const questionPath = await workspaceQuestion(vp0);
  const visitorCookies = await visitor.cookies();
  await visitor.close();

  // role: who acts there; one: whether that role has exactly one next step (§6 "Next action").
  const ROUTES = [
    { route: "/", roles: [["guest", true], ["marketing", true]] },
    { route: "/branches/B09/trace?period=oct&metric=paid_cac", roles: [["guest", true], ["marketing", true]] },
    { route: incident, roles: [["guest", false], ["engineer", true]] },
    // B09: its coverage gap holds the decision on every copy of the data (the browser suite fixes B20's).
    { route: "/decisions?branch=B09&period=oct", roles: [["guest", true], ["marketing", true]] },
    { route: "/onboarding", roles: [["guest", true], ["marketing", true]] },
    { route: uploadPath, roles: [["guest", true]] },
    { route: "/investigator", roles: [["guest", true], ["marketing", true]] },
    { route: questionPath, roles: [["guest", false]] },
  ];

  lines.push("| State | Route | Role | Width | Result | Detail | Screenshot |", "|---|---|---|---|---|---|---|");

  // ── loaded ──
  for (const { route, roles } of ROUTES) {
    for (const [role, one] of roles) {
      for (const vp of VIEWPORTS) {
        const context = await contextFor(browser, role, vp);
        if (role === "guest") await context.addCookies(visitorCookies);
        const page = await context.newPage();
        const res = await page.goto(baseUrl + route, { waitUntil: "load", timeout: 120_000 });
        const seen = await inspect(page);
        const shot = `loaded-${slug(route)}-${role}-${vp.name}.png`;
        await page.screenshot({ path: path.join(shots, shot) });
        const count = seen.primaries.length;
        const ok = res.status() === 200 && !seen.sideways && count <= 1 && (!one || count === 1);
        const why = [`${res.status()}`, `h1 "${seen.h1}"`, `primaries ${count}${count ? ` (${seen.primaries.join("; ")})` : ""}`, seen.sideways ? "sideways scroll" : "no sideways scroll"];
        record("loaded", route, role, vp.name, ok, why.join(", "), shot);
        await context.close();
      }
    }
  }

  // ── loading: a client navigation from the Overview with the route's server response held ──
  for (const route of ["/decisions?branch=B09&period=oct", "/exceptions", "/investigator", "/onboarding"]) {
    const context = await contextFor(browser, "marketing");
    const page = await context.newPage();
    await page.goto(baseUrl + "/", { waitUntil: "load" });
    await page.waitForTimeout(800);
    const pathname = route.split("?")[0];
    let held = 0;
    await page.route((url) => url.pathname === pathname && url.searchParams.has("_rsc"), async (r) => {
      held += 1;
      await new Promise((resolve) => setTimeout(resolve, 1500));
      await r.continue();
    });
    const link = page.locator(`nav a[href^="${pathname}"]`).first();
    if (!(await link.count())) {
      record("loading", route, "marketing", "1440", false, "no navigation link to it on the Overview", null);
      await context.close();
      continue;
    }
    await link.click();
    await page.waitForTimeout(700);
    const shot = `loading-${slug(route)}.png`;
    await page.screenshot({ path: path.join(shots, shot) });
    const pending = await page.evaluate(() => ({ url: location.pathname, busy: !!document.querySelector('[aria-busy="true"], [data-skeleton], .animate-pulse, [data-pending]') }));
    await page.waitForURL((u) => u.pathname === pathname, { timeout: 60_000 });
    await page.locator("h1").first().waitFor({ state: "visible", timeout: 60_000 });
    const arrived = await page.locator("h1").first().textContent();
    const ok = held > 0 && arrived !== null;
    record("loading", route, "marketing", "1440", ok, `held ${held} request(s); at 0.7 s the page showed ${pending.url}${pending.busy ? " with a busy or skeleton mark" : ""}; then "${(arrived ?? "").trim().slice(0, 40)}" arrived`, shot);
    await context.close();
  }

  // ── empty: a fresh visitor. Its uploads list is empty; its questions list holds none of its own
  // (company investigations are public demo content; the list marks a visitor's own "yours"). ──
  {
    const context = await browser.newContext({ viewport: VIEWPORTS[0].viewport });
    const page = await context.newPage();
    await page.goto(baseUrl + "/onboarding", { waitUntil: "load" });
    await inspect(page);
    const shot = "empty-onboarding.png";
    await page.screenshot({ path: path.join(shots, shot), fullPage: true });
    const empty = await page.getByText("No uploads yet", { exact: true }).isVisible();
    record("empty", "/onboarding", "guest (new visitor)", "1440", empty, empty ? 'Your uploads says "No uploads yet"' : "no empty state in Your uploads", shot);

    await page.goto(baseUrl + "/investigator", { waitUntil: "load" });
    await inspect(page);
    const shot2 = "empty-investigator.png";
    await page.screenshot({ path: path.join(shots, shot2), fullPage: true });
    const items = page.locator('[data-testid="recent-investigations"] li');
    const listed = await items.count();
    const yours = await items.filter({ hasText: /\byours\b/ }).count();
    const sentence = await page.getByText("No investigations yet in your scope.", { exact: true }).isVisible();
    const ok = yours === 0 && (listed > 0 || sentence);
    const shown = listed ? `${listed} company investigation(s) shown` : sentence ? '"No investigations yet in your scope."' : "no empty state";
    record("empty", "/investigator", "guest (new visitor)", "1440", ok, `${yours} of the visitor's own listed; ${shown}`, shot2);
    await context.close();
  }

  // ── failed: each request answered 500 ──
  const failures = [
    { name: "upload", role: "guest", start: "/onboarding", match: (u, m) => m === "POST" && u.pathname === "/api/onboarding/uploads",
      act: async (page) => (await page.getByTestId("sample-demo-calls.csv").click()) },
    { name: "question", role: "guest", start: "/investigator", match: (u, m) => m === "POST" && u.pathname === "/api/investigations",
      act: async (page) => { await page.getByLabel("Question").fill("Why did B20's CAC jump in October?"); await page.getByLabel("Question").press("Control+Enter"); } },
  ];
  for (const f of failures) {
    const context = await contextFor(browser, f.role);
    const page = await context.newPage();
    await page.goto(baseUrl + f.start, { waitUntil: "load" });
    await inspect(page);
    await page.route((u) => true, async (r) => (f.match(new URL(r.request().url()), r.request().method()) ? r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Injected failure (states harness)" }) }) : r.fallback()));
    const before = page.url();
    await f.act(page);
    const alert = page.locator('[role="alert"], [role="status"]').filter({ hasText: /fail|error|could not|try again|injected/i }).first();
    const shown = await alert.waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false);
    const shot = `failed-${f.name}.png`;
    await page.screenshot({ path: path.join(shots, shot) });
    const stayed = page.url() === before;
    record("failed", f.start, f.role, "1440", shown && stayed, `${f.name} answered 500: ${shown ? `"${((await alert.textContent()) ?? "").trim().slice(0, 80)}"` : "no error message"}; ${stayed ? "stayed on the page" : `moved to ${page.url()}`}`, shot);
    await context.close();
  }
  {
    // The dry run, as the marketing analyst, on a company upload of the same sample.
    const context = await contextFor(browser, "marketing");
    const page = await context.newPage();
    await page.goto(baseUrl + "/onboarding", { waitUntil: "load" });
    await inspect(page);
    await page.getByTestId("sample-demo-calls.csv").click();
    await page.waitForURL(/\/onboarding\/\d+/, { timeout: 60_000 });
    const go = page.getByTestId("propose-and-dry-run");
    const reached = await go.waitFor({ state: "visible", timeout: 60_000 }).then(() => true, () => false);
    if (reached) {
      const questions = page.getByTestId("mapping-questions");
      if (await questions.count()) {
        const mdy = questions.getByLabel("month first (March 4)");
        if (await mdy.count()) await mdy.check();
        const local = questions.getByLabel(/branch local time/);
        if (await local.count()) await local.check();
      }
      await page.route((u) => u.pathname.endsWith("/dry-run"), (r) => r.fulfill({ status: 500, contentType: "application/json", body: JSON.stringify({ error: "Injected failure (states harness)" }) }));
      await go.click();
      const alert = page.locator('[role="alert"], [role="status"]').filter({ hasText: /fail|error|could not|try again|injected/i }).first();
      const shown = await alert.waitFor({ state: "visible", timeout: 15_000 }).then(() => true, () => false);
      const shot = "failed-dry-run.png";
      await page.screenshot({ path: path.join(shots, shot) });
      const result = await page.getByTestId("upload-result").count();
      record("failed", "/onboarding/[id]", "marketing", "1440", shown && result === 0, `dry run answered 500: ${shown ? `"${((await alert.textContent()) ?? "").trim().slice(0, 80)}"` : "no error message"}; ${result ? "a result card appeared" : "no result card"}`, shot);
    } else {
      record("failed", "/onboarding/[id]", "marketing", "1440", false, "the dry-run step never appeared", null);
    }
    await context.close();
  }

  // ── restricted ──
  {
    const context = await contextFor(browser, "guest");
    const page = await context.newPage();
    await page.goto(baseUrl + incident, { waitUntil: "load" });
    await inspect(page);
    const controls = await page.locator('[data-testid="case-controls"] button:visible, [data-testid="propose-form"] button:visible').count();
    const shot = "restricted-incident-guest.png";
    await page.screenshot({ path: path.join(shots, shot) });
    record("restricted", incident, "guest", "1440", controls === 0, `${controls} case control(s) offered`, shot);
    await context.close();
  }
  {
    const context = await contextFor(browser, "partner");
    const page = await context.newPage();
    const res = await page.goto(baseUrl + "/branches/B09/trace?period=oct&metric=paid_cac", { waitUntil: "load" });
    await page.waitForTimeout(1200);
    const text = await page.locator("main").innerText();
    const shot = "restricted-trace-partner.png";
    await page.screenshot({ path: path.join(shots, shot) });
    const refused = /403 — not in your scope/.test(text);
    const leaked = /\$\d/.test(text) && !refused;
    record("restricted", "/branches/B09/trace", "partner (B20 only)", "1440", refused && !leaked, `${res.status()}; ${refused ? "refused in words" : "no refusal shown"}`, shot);
    await context.close();
  }

  await browser.close();
  const head = `# States on the ★ routes (WP-J step 2)\n\nMeasured ${new Date().toISOString()} against ${baseUrl} by \`harness/states.cjs\`. ${lines.length - 2} checks, ${failed} failed.\n\n`;
  fs.writeFileSync(outMd, head + lines.join("\n") + "\n");
  console.log(`${lines.length - 2} checks, ${failed} failed → ${outMd}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
