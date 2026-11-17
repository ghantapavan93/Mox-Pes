// Walks the B20 repair journey and the scoped roles through the real UI (role picker, buttons,
// links; no API shortcuts), capturing each state at 1440 and the receipt at 390.
// Usage: BASE=http://localhost:3988 OUT=<folder> node docs/agent-work/product-audit/harness/walk.cjs
// Expects a freshly seeded database whose B20 replay proposal has been dry-run but not approved.
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require(path.join(process.cwd(), "node_modules", "@playwright/test"));

const BASE = process.env.BASE ?? "http://localhost:3988";
const OUT = process.env.OUT ?? path.join(process.cwd(), "docs/agent-work/product-audit/walk");
fs.mkdirSync(OUT, { recursive: true });
const facts = {};

async function settle(page) {
  await page.waitForLoadState("domcontentloaded");
  await page.waitForFunction(() => !/^\s*Loading…\s*$/.test(document.querySelector("main")?.innerText ?? "Loading…"), null, { timeout: 30_000 });
  // The Overview's figure counts up once (components/CountUp.tsx): capture its final value only.
  await page.waitForFunction(() => !document.querySelector(".count-up:not([data-counted])"), null, { timeout: 8_000 }).catch(() => {});
  await page.waitForTimeout(400);
}

async function setRole(page, role) {
  await page.getByLabel("Viewing as").selectOption(role);
  await page.waitForFunction((r) => document.cookie.includes(`rs_role=${r}`) || true, role);
  await page.waitForTimeout(1500);
  await page.reload();
  await settle(page);
}

const shot = (page, name) => page.screenshot({ path: path.join(OUT, `${name}.png`) });
// Element crops for the PDF (selectable-text pages are built from these, nothing re-typed).
fs.mkdirSync(path.join(OUT, "crops"), { recursive: true });
/** The Overview's headline: from its page title through the answer below it. */
async function cropHeadline(page, name) {
  try {
    const title = await page.getByRole("heading", { name: "Where did the conversions go?" }).boundingBox();
    const answer = await page.locator('[data-testid="headline-answer"]').boundingBox();
    const x = Math.min(title.x, answer.x) - 12;
    const y = title.y - 34;
    const width = Math.max(title.x + title.width, answer.x + answer.width) - x + 12;
    const height = answer.y + answer.height - y + 12;
    await page.screenshot({ path: path.join(OUT, "crops", `${name}.png`), clip: { x, y, width, height }, fullPage: true });
  } catch (error) {
    facts[`cropFailed_${name}`] = String(error).slice(0, 160);
  }
}

async function crop(locator, name) {
  try {
    // A sticky section bar would otherwise overlap the top of a scrolled-to element.
    await locator.page().addStyleTag({ content: ".sticky { position: static !important; }" });
    await locator.first().scrollIntoViewIfNeeded();
    await locator.first().screenshot({ path: path.join(OUT, "crops", `${name}.png`) });
  } catch (error) {
    facts[`cropFailed_${name}`] = String(error).slice(0, 160);
  }
}
const text = async (page, selector) => ((await page.locator(selector).first().innerText().catch(() => "")) || "").replace(/\s+/g, " ").trim();

(async () => {
  const browser = await chromium.launch();
  const desk = await browser.newContext({ viewport: { width: 1440, height: 900 }, deviceScaleFactor: 1 });
  const page = await desk.newPage();

  // 1. First-time reviewer, as a guest: Overview, then the link the headline offers.
  await page.goto(`${BASE}/`);
  await settle(page);
  await setRole(page, "guest");
  facts.overviewBefore = await text(page, '[data-testid="headline-answer"]');
  await shot(page, "01-overview-guest");
  await cropHeadline(page, "p1-headline");
  await crop(page.locator("#holds"), "p1-holds");
  await page.locator('[data-testid="headline-answer"] a', { hasText: "B20 Heron" }).click();
  await settle(page);
  facts.b20LinkTarget = page.url().replace(BASE, "");
  facts.b20BranchKpis = await text(page, "main");
  facts.b20BranchKpis = facts.b20BranchKpis.slice(0, 600);
  await shot(page, "02-b20-branch-guest");
  await crop(page.locator('[data-testid="budget-signal"]').locator("xpath=ancestor::section[1] | ancestor::div[contains(@class,'ring-1')][1]"), "p1-budget-signal");

  // 2. Engineer: propose the replay with the form's default mapper, then dry-run it.
  if (process.env.SKIP_PROPOSE !== "1") {
    await setRole(page, "engineer");
    await page.goto(`${BASE}/exceptions/1063?period=oct`);
    await settle(page);
    facts.defaultMapper = await page.locator("form", { hasText: "Propose fix" }).locator("select").nth(1).inputValue();
    await page.locator("form", { hasText: "Propose fix" }).locator("textarea").fill("Replay the 119 held calls through the deployed mapper; the phone field moved.");
    await page.getByRole("button", { name: "Propose fix" }).click();
    await page.getByRole("button", { name: "Run dry run (rolled back)" }).waitFor({ timeout: 30_000 });
    await page.getByRole("button", { name: "Run dry run (rolled back)" }).click();
    await page.getByText("Dry run verified and rolled back").first().waitFor({ timeout: 60_000 });
    await page.waitForTimeout(800);
    facts.dryRunChanges = await text(page, '[data-testid="receipt-exception-changes"]');
    await page.locator('[data-testid="receipt-headline"]').first().scrollIntoViewIfNeeded();
    await shot(page, "03a-dry-run-engineer");
    await crop(page.getByText("Structured facts the classification rests on").locator("xpath=ancestor::section[1] | ancestor::div[contains(@class,'ring-1')][1]"), "p2-evidence");
    await crop(page.locator("details").filter({ has: page.locator('[data-testid="receipt-headline"]') }), "p2-dry-run");
  }

  // 3. Approver: the dry-run receipt awaiting approval, then approve and execute.
  await setRole(page, "approver");
  await page.goto(`${BASE}/exceptions/1063?period=oct`);
  await settle(page);
  await page.getByRole("button", { name: "Approve" }).scrollIntoViewIfNeeded();
  await shot(page, "03-incident-awaiting-approval");
  await page.getByLabel("Decision reason").fill("Dry run conserved the ledger; replay is the documented fix.");
  await page.getByRole("button", { name: "Approve" }).click();
  await page.getByText(/Approved|approved/).first().waitFor({ timeout: 30_000 });
  await page.waitForTimeout(800);
  facts.afterApprove = (await page.locator('[role="status"]').allInnerTexts()).filter(Boolean);
  const execute = page.getByRole("button", { name: /^Execute/ });
  await execute.scrollIntoViewIfNeeded();
  await shot(page, "04-approved-ready-to-execute");
  await execute.click();
  const receipt = page.locator('[data-testid="execution-result"]');
  await receipt.waitFor({ timeout: 60_000 });
  await page.waitForTimeout(800);
  facts.focusAfterExecute = await page.evaluate(() => document.activeElement?.getAttribute("data-testid") ?? document.activeElement?.tagName);
  facts.receipt = (await receipt.innerText()).replace(/\s+/g, " ").slice(0, 1200);
  facts.executeButtonsAfter = await page.getByRole("button", { name: /^Execute/ }).count();
  await receipt.scrollIntoViewIfNeeded();
  await shot(page, "05-receipt-executed");
  // The resolved incident, opened again as a reader would: does it lead with the result?
  await page.goto(`${BASE}/exceptions/1063?period=oct`);
  await settle(page);
  facts.fixResult = await text(page, '[data-testid="fix-result"]');
  facts.fixResultNext = await page.locator('[data-testid="fix-result-next"]').getAttribute("href").catch(() => null);
  await shot(page, "05b-incident-resolved-top");
  await crop(page.locator('[data-testid="fix-result"]'), "p3-fix-result");
  await crop(page.locator('[data-testid="execution-result"]'), "p3-receipt");

  // 3. After the fix: Overview and the B20 page, same guest view as the start.
  await setRole(page, "guest");
  await page.goto(`${BASE}/`);
  await settle(page);
  facts.overviewAfter = await text(page, '[data-testid="headline-answer"]');
  await shot(page, "06-overview-after-guest");
  await cropHeadline(page, "p3-headline-after");
  await page.goto(`${BASE}/branches/B20?period=oct`);
  await settle(page);
  facts.b20BranchAfter = (await text(page, "main")).slice(0, 600);
  await shot(page, "07-b20-branch-after-guest");

  // 4. Scoped roles: the B20 partner and the brand lead.
  await setRole(page, "partner");
  await page.goto(`${BASE}/`);
  await settle(page);
  facts.partnerOverview = (await text(page, "main")).slice(0, 500);
  await shot(page, "08-overview-partner");
  await setRole(page, "brand");
  await page.goto(`${BASE}/`);
  await settle(page);
  facts.brandOverview = (await text(page, "main")).slice(0, 500);
  facts.brandHoldLinks = await page.locator("#holds a").evaluateAll((as) => as.map((a) => `${a.textContent.trim().slice(0, 40)} -> ${a.getAttribute("href")}`));
  facts.brandHoldUnavailable = await text(page, '#holds [data-testid="incident-unavailable"]');
  await shot(page, "09-overview-brand");
  await crop(page.locator("#holds"), "p3-brand-hold");
  const firstHold = page.locator("#holds a[href^='/exceptions/']").first();
  if (await firstHold.count()) {
    const href = await firstHold.getAttribute("href");
    const res = await page.goto(`${BASE}${href}`);
    await page.waitForTimeout(1500);
    facts.brandHoldTarget = { href, status: res?.status(), heading: (await text(page, "main")).slice(0, 200) };
    await shot(page, "10-brand-hold-target");
  }

  // 5. The receipt at phone width, as the approver who ran it.
  const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2, isMobile: true, hasTouch: true });
  const mp = await phone.newPage();
  await mp.goto(`${BASE}/`);
  await settle(mp);
  await setRole(mp, "approver");
  await mp.goto(`${BASE}/exceptions/1063?period=oct`);
  await settle(mp);
  // On a phone the verdict comes first: the result panel right under the title.
  await mp.locator('[data-testid="fix-result"]').scrollIntoViewIfNeeded().catch(() => {});
  await shot(mp, "12-incident-result-390");
  facts.phoneFixResultTop = await mp.evaluate(() => Math.round(document.querySelector('[data-testid="fix-result"]')?.getBoundingClientRect().top + window.scrollY));
  const mReceipt = mp.locator('[data-testid="execution-result"]');
  if (await mReceipt.count()) await mReceipt.scrollIntoViewIfNeeded();
  facts.phoneOverflow = await mp.evaluate(() => document.documentElement.scrollWidth - document.documentElement.clientWidth);
  await shot(mp, "11-receipt-390");

  fs.writeFileSync(path.join(OUT, "walk.json"), JSON.stringify(facts, null, 2));
  await browser.close();
  console.log(JSON.stringify(facts, null, 2).slice(0, 6000));
})().catch((error) => {
  fs.writeFileSync(path.join(OUT, "walk.json"), JSON.stringify({ ...facts, error: String(error) }, null, 2));
  console.error(error);
  process.exit(1);
});
