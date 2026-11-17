// Captures what the running app says about one branch's budget decision, on every surface that
// states it: the branch page's budget card and channel table, the Decision Lab (readiness summary,
// verdicts, budget note, scenario builder defaults) and the Overview (hold callout, hold list,
// "what changed" takeaway). Texts go to proof/<label>/<branch>.json, with screenshots beside them.
// Usage: node capture.cjs <label> <branch> [base url] [role]
// The app must run on an isolated revenue_signal_audit_boundary* copy, never the demo database.
const path = require("node:path");
const fs = require("node:fs");
const REPO = path.resolve(__dirname, "../../../../..");
const { chromium } = require(path.join(REPO, "node_modules", "@playwright/test"));

const [label = "before", branch = "B03", base = "http://localhost:3990", role = "marketing"] = process.argv.slice(2);
const out = path.join(__dirname, "proof", label);
fs.mkdirSync(out, { recursive: true });
const tidy = (s) => s.replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();

(async () => {
  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1440, height: 1000 } });
  const host = new URL(base).hostname;
  await context.addCookies([{ name: "rs_role", value: role, domain: host, path: "/" }]);
  const page = await context.newPage();
  const texts = {};
  const grab = async (name, locator, shot = true) => {
    if ((await locator.count()) === 0) {
      texts[name] = null;
      return;
    }
    const el = locator.first();
    await el.scrollIntoViewIfNeeded();
    texts[name] = tidy(await el.innerText());
    if (shot) await el.screenshot({ path: path.join(out, `${branch}-${name}.png`) });
  };
  const open = async (url, ready) => {
    await page.goto(`${base}${url}`, { waitUntil: "networkidle", timeout: 240_000 });
    if (ready) await page.locator(ready).first().waitFor({ timeout: 240_000 });
  };

  await open(`/branches/${branch}?period=oct`, '[data-testid="budget-signal"]');
  await grab("branch-budget-card", page.locator("section, div").filter({ has: page.locator('[data-testid="budget-signal"]') }).last());
  await grab("branch-channels", page.locator("table", { hasText: "Attributed cost per customer" }), false);

  await open(`/decisions?branch=${branch}&period=oct`, '[data-testid="readiness-summary"]');
  await page.locator('[data-testid="readiness-other-checks"], [data-testid="readiness-summary"][data-state="not_ready"]').first().waitFor({ timeout: 240_000 }).catch(() => {});
  await grab("lab-readiness", page.locator('[data-testid="readiness-summary"]'));
  await grab("lab-verdicts", page.locator("#verdicts"));
  await grab("lab-builder", page.locator("#scenarios"), false);
  // The builder's preselected move, as the form holds it.
  texts["lab-builder-defaults"] = await page
    .locator("#scenarios select")
    .evaluateAll((els) => els.map((e) => `${e.getAttribute("name") ?? e.getAttribute("aria-label") ?? "select"}=${e.value || "(none)"}`).join("; "))
    .catch(() => null);

  await open(`/?period=oct`, '[data-testid="decision-holds"], [data-testid="decision-holds-empty"]');
  await grab("overview-callout", page.locator('[role="status"], [role="note"], div').filter({ hasText: /budget decisions? (on hold|in your scope)/i }).filter({ hasNot: page.locator("#holds") }).last(), false);
  await grab("overview-holds", page.locator("#holds"));
  await page.locator('[data-testid="movement-trust"]').first().waitFor({ timeout: 120_000 }).catch(() => {});
  await grab("overview-movement-trust", page.locator('[data-testid="movement-trust"]'), false);
  // The same panel scoped to the branch (?branch=): its takeaway for that branch alone.
  await open(`/?period=oct&branch=${branch}`, '[data-testid="movement-trust"]');
  await grab("overview-branch-movement-trust", page.locator('[data-testid="movement-trust"]'), false);

  fs.writeFileSync(path.join(out, `${branch}.json`), JSON.stringify(texts, null, 2));
  console.log(JSON.stringify(texts, null, 2));
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
