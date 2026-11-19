import { expect, test, type Browser, type BrowserContextOptions, type Page } from "@playwright/test";
import { unseenCallsCsv } from "../fixtures/onboarding/unseen";
import { fixThroughActionCenter, setRole } from "./action-center";
import { clearWorkspace, expireWorkspaceItem, incidentOf, ledgerCalls, seedReplayableIncident } from "./db";

/**
 * The release journeys (docs/agent-work/release/RELEASE-DESIGN.md §6), each as a cold reviewer
 * walks it. The e2e server runs with PUBLIC_WORKSPACE=1, so a browser without a role cookie is the
 * hosted demo's visitor: a guest with its own workspace.
 *
 * J1 · The Overview chart: select a point, open its evidence, come back to the same point with
 * focus where it was, by mouse, keyboard and touch, with and without motion.
 *
 * J2 · Upload to result, twice: one visitor uploads an export the app has never seen and reads what
 * was read, what counted, what did not and why; another visitor cannot open it, and nothing either
 * of them sees as shared moves.
 *
 * J3 · Incidents and the Decision Lab: an engineer's dry run says nothing was saved; B20's stored
 * receipt leads with October and names its approval; a guest sees why, and no action; B09's held
 * decision offers no approval. It needs staff roles (demo mode), so it is not @core.
 *
 * J4 · The investigator, as a visitor: a question asked by keyboard, answered by the deterministic
 * evidence path in the visitor's own workspace, citing records that open.
 *
 * J5 · Start here and the visitor tour: the page a link opens first says what the product does and
 * plays its walkthrough; the tour walks B20's finished repair in seven steps, its bar always in
 * view, with no role and no action; the guided demo offers a role step only where roles switch
 * (sharing review, 2026-11-19: on the hosted site the B09 path stopped at "Use this role").
 */

test.describe.configure({ mode: "serial" });
/**
 * Against a deployment with no database access (Preview, Production: tests/e2e/hosted.config.ts
 * with BASE_URL and no DATABASE_URL) only the journeys that need no database run: J1, J2's
 * two-visitor core and J4. The rehearsal sets DATABASE_URL to its own database and runs them all.
 */
const NO_DATABASE = Boolean(process.env.BASE_URL) && !process.env.DATABASE_URL;

/**
 * Two calls the seeded world holds that a file without a campaign column matches exactly (the two
 * latest such calls on a fresh seed). Every run uses them, so a deployment the test cannot query
 * gets the same file; the database runs check the ledger still holds them as stated, so a changed
 * seed fails here first.
 */
const SEEDED_CALLS = [
  { id: "CAL00024886", branch: "Hazel", startedLocal: "10/30/2026 18:53", source: "Direct", phone: "(206) 555-0140" },
  { id: "CAL00024832", branch: "Canyon", startedLocal: "10/30/2026 16:50", source: "Direct", phone: "(206) 555-0141" },
];

test.beforeAll(async () => {
  if (!NO_DATABASE) await clearWorkspace();
});
test.afterAll(async () => {
  if (!NO_DATABASE) await clearWorkspace();
});

/**
 * The Overview's one figure and the four data times on Audit & Health, as a visitor reads them.
 * Each is read once it shows (React reveals streamed sections after the load event), and the times
 * as words: the innerText of a block still hidden has no line breaks, so equal times read unequal.
 */
async function sharedFigures(page: Page) {
  await page.goto("/?period=oct");
  const figure = page.getByTestId("at-risk-figure");
  await expect(figure).toBeVisible();
  const atRisk = (await figure.textContent())?.trim() ?? "";
  await page.goto("/audit");
  const block = page.getByTestId("data-times");
  await expect(block).toBeVisible();
  const times = ((await block.textContent()) ?? "").replace(/\s+/g, " ").trim();
  return { atRisk, times };
}

/** Picks a file in the chooser and sends it, as a visitor does. */
async function upload(page: Page, name: string, buffer: Buffer) {
  await page.goto("/onboarding");
  await page.getByLabel("Export file").setInputFiles({ name, mimeType: "text/csv", buffer });
  await page.getByTestId("upload-submit").click();
}

/** Answers the two questions the file cannot (month or day first; branch-local times) and dry-runs it. */
async function answerAndCompare(page: Page) {
  const questions = page.getByTestId("mapping-questions");
  await questions.getByLabel("month first (March 4)").check();
  await questions.getByText(/branch local time/).click();
  await page.getByTestId("propose-and-dry-run").click();
  await expect(page.getByTestId("upload-result")).toBeVisible({ timeout: 90_000 });
}

/**
 * Visible primaries only: Next keeps the page a visitor came from mounted but hidden, so Back
 * restores it, and its controls stay in the document.
 */
const PRIMARY = '[data-variant="primary"]:visible';

/** The result card's top edge lies inside the first screen. */
async function resultOnFirstScreen(page: Page, height: number) {
  await page.reload();
  // The page streams: the card is in the document, hidden, until its content has arrived.
  await expect(page.getByTestId("upload-result")).toBeVisible();
  const box = await page.getByTestId("upload-result").boundingBox();
  expect(box, "the result card is rendered").not.toBeNull();
  expect(box!.y, `the result starts inside the first ${height} px`).toBeLessThan(height - 40);
}

/** B09, October: Google Local Services stops on Oct 13 (an open coverage gap); Oct 5–11 has 7 days of records. */
const B09 = "/?period=oct&branch=B09";
const POINT = '[data-point="google_lsa|2026-10-05"]';
const TRACE = /\/branches\/B09\/trace\?period=oct&metric=paid_spend&channel=google_lsa&week=2026-10-05$/;
const SELECTED = /\/\?period=oct&branch=B09&channel=google_lsa&week=2026-10-05#movement$/;

const visible = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });

/** Tab forward until the focused element matches, as a keyboard user would. */
async function tabUntil(page: Page, matches: () => Promise<boolean>, limit = 120) {
  for (let i = 0; i < limit; i++) {
    if (await matches()) return;
    await page.keyboard.press("Tab");
  }
  throw new Error("the keyboard never reached the target");
}

/** Back from the evidence: the same URL and selection, and focus on "Open evidence". */
async function backRestores(page: Page, sentence: string) {
  await page.goBack();
  await expect(page).toHaveURL(SELECTED);
  await expect(visible(page, "movement-selection")).toHaveAttribute("data-selected", "google_lsa|2026-10-05");
  await expect(visible(page, "movement-sentence")).toHaveText(sentence);
  await expect(page.locator("#movement-open-evidence")).toBeFocused();
}

async function newPage(browser: Browser, options: BrowserContextOptions = {}) {
  return (await browser.newContext(options)).newPage();
}

/**
 * B20's held-calls incident, repaired: golden-path.spec.ts repairs it earlier in the suite, and the
 * hosted copy carries the repair (lib/demo/hosted-correction.ts). Run alone, it is repaired here the
 * same way, through the Action Center. Returns its id; leaves the approver role active.
 */
async function ensureB20Repaired(page: Page): Promise<number> {
  const b20 = await incidentOf("B20", "quarantined_source_records");
  expect(b20, "the seeded world has B20's quarantine incident").not.toBeNull();
  if (b20!.status !== "resolved") {
    await page.goto(`/exceptions/${b20!.id}`);
    await fixThroughActionCenter(page, {
      kind: "replay_quarantine",
      mapper: "1.1",
      rationale: "calls@1.1 reads the renamed caller field; replay the held records",
      approval: "Dry run projects every held record and conserves the ledger",
    });
  }
  return b20!.id;
}

test.describe("J1 · the Overview chart: select, then open; Back restores", () => {
  test("@core hover a point: the tooltip says what the panel says once it is selected", async ({ page }) => {
    await page.goto(B09);
    await page.locator(POINT).hover();
    const tip = visible(page, "movement-tooltip");
    await expect(tip).toBeVisible();
    const words = (await tip.innerText()).trim();
    expect(words).toMatch(/^Google Local Services at B09 · Oct 5–Oct 11: \$[\d,]+\.\d{2}, from spend records on all 7 days/);
    await page.locator(POINT).click();
    await expect(visible(page, "movement-sentence")).toHaveText(words);
    await expect(page).toHaveURL(SELECTED);
  });

  test("@core keyboard only: a week, its evidence, and Back to the same week with focus on Open evidence", async ({ page }) => {
    await page.goto(B09);
    const weeks = visible(page, "movement-weeks");
    await tabUntil(page, () => weeks.evaluate((group) => group.contains(document.activeElement)));
    // One tab stop for the row: the period's first week; the arrow moves to the next.
    await expect(weeks.locator('[data-week="2026-09-28"]')).toBeFocused();
    await page.keyboard.press("ArrowRight");
    await expect(weeks.locator('[data-week="2026-10-05"]')).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(SELECTED);
    const sentence = (await visible(page, "movement-sentence").innerText()).trim();
    await tabUntil(page, async () => (await page.evaluate(() => document.activeElement?.id)) === "movement-open-evidence");
    await page.keyboard.press("Enter");
    await expect(page).toHaveURL(TRACE);
    await backRestores(page, sentence);
  });

  test("@core a phone with a touch screen: tap a point, tap Open evidence, Back", async ({ browser }) => {
    const page = await newPage(browser, { viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
    await page.goto(B09);
    await page.locator(POINT).tap();
    await expect(visible(page, "movement-selection")).toHaveAttribute("data-selected", "google_lsa|2026-10-05");
    const sentence = (await visible(page, "movement-sentence").innerText()).trim();
    await visible(page, "open-evidence").tap();
    await expect(page).toHaveURL(TRACE);
    await backRestores(page, sentence);
  });

  test("@core with reduced motion the same journey holds and nothing animates", async ({ browser }) => {
    const page = await newPage(browser, { reducedMotion: "reduce" });
    await page.goto(B09);
    await page.locator(POINT).hover();
    const words = (await visible(page, "movement-tooltip").innerText()).trim();
    await page.locator(POINT).click();
    await expect(visible(page, "movement-sentence")).toHaveText(words);
    await visible(page, "open-evidence").click();
    await expect(page).toHaveURL(TRACE);
    await backRestores(page, words);
    await page.waitForLoadState("networkidle");
    expect(await page.evaluate(() => document.getAnimations().filter((a) => a.playState === "running").length)).toBe(0);
  });

  test("@core one primary action, and on a 720 × 450 screen the verdict and its action are in view", async ({ browser }) => {
    const page = await newPage(browser, { viewport: { width: 720, height: 450 }, deviceScaleFactor: 2 });
    await page.goto("/?period=oct");
    await expect(page.locator(PRIMARY)).toHaveCount(1);
    for (const id of ["headline-answer", "headline-action"]) {
      const box = await visible(page, id).boundingBox();
      expect(box, id).not.toBeNull();
      expect(box!.y, `${id} starts in view`).toBeGreaterThanOrEqual(0);
      expect(box!.y, `${id} starts inside 450 px`).toBeLessThan(450);
    }
    const action = await visible(page, "headline-action").boundingBox();
    expect(action!.y + action!.height, "the action is wholly in view").toBeLessThanOrEqual(450);
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
  });
});

test.describe("J3 · incidents and the Decision Lab", () => {
  test.skip(NO_DATABASE, "seeds an incident and needs staff roles");
  test("a dry run saves nothing; B20's receipt leads with October; a guest sees why and no action; a held decision offers no approval", async ({ page }) => {
    test.setTimeout(240_000);
    const replayable = await seedReplayableIncident();

    // An integration engineer previews the replay: busy while it runs, then nothing was saved.
    await setRole(page, "engineer");
    await page.goto(`/exceptions/${replayable}`);
    const panel = page.getByTestId("replay-panel");
    const dryRun = panel.getByRole("button", { name: /Dry run \(rolled back\)|Running…/ });
    const answered = page.waitForResponse((r) => r.url().endsWith("/api/replays") && r.request().method() === "POST");
    await dryRun.click();
    await expect(dryRun).toHaveAttribute("aria-disabled", "true");
    expect((await answered).status()).toBe(200);
    await expect(panel.getByTestId("replay-result")).toContainText("Dry run — nothing was saved");
    expect(await page.locator(PRIMARY).count()).toBeLessThanOrEqual(1);

    // A guest on the same incident: why it is open, and no action.
    await setRole(page, "guest");
    await page.goto(`/exceptions/${replayable}`);
    await expect(page.getByTestId("exception-summary")).toBeVisible();
    // The public-demo guest may ask in their own workspace (J4), so the page offers it, as a
    // secondary link: it no longer says guests cannot investigate.
    await expect(page.getByTestId("investigate-link")).toBeVisible();
    await expect(page.getByRole("button", { name: /Dry run|Propose fix|Approve|Execute/ })).toHaveCount(0);
    expect(await page.locator(PRIMARY).count()).toBe(0);

    // B20's receipt, from its stored execution: Corrected and Approved, October first, the window below.
    const b20 = await ensureB20Repaired(page);
    await setRole(page, "marketing");
    await page.goto(`/exceptions/${b20}`);
    const receipt = page.getByTestId("fix-result");
    await expect(receipt.getByTestId("fix-result-corrected")).toContainText("Corrected");
    await expect(receipt.getByTestId("fix-result-approved")).toContainText(/Approved.*by .+, [A-Z][a-z]{2} \d{1,2}, \d{1,2}:\d{2} [AP]M UTC/);
    await expect(receipt).toContainText("Paid-media CAC at B20, Oct 1–30, 2026 (UTC)");
    await expect(receipt.getByTestId("fix-result-cac")).toContainText("$490.11");
    await expect(receipt.getByTestId("fix-result-cac")).toContainText("$271.31");
    await expect(receipt.getByTestId("fix-result-why")).toContainText("paid customers 31 → 56");
    // The spend to the cent, so the reader can check both CACs: $15,193.47 ÷ 31 and ÷ 56.
    await expect(receipt.getByTestId("fix-result-arithmetic")).toContainText("Both divide the same $15,193.47 of paid spend: by 31 paid customers before the repair, by 56 after.");
    await expect(receipt.getByTestId("fix-result-unchanged")).toContainText("paid-media spend ($15,193.47) and serviced customers on all channels (109) did not change");
    // A completed repair, approved as a repair: not a budget move, and the decision one link away.
    await expect(receipt.getByTestId("fix-result-approval")).toContainText("The repair only, not a budget move");
    await expect(receipt.getByTestId("fix-result-decision")).toHaveAttribute("href", "/decisions?branch=B20&period=oct");
    await expect(page.getByText("Until they are replayed")).toHaveCount(0);
    await expect(page.getByText(/While they were held, every downstream number that depended on them was understated/)).toBeVisible();
    // The replay's whole window, kept apart from October.
    await expect(receipt.getByTestId("fix-result-window")).toContainText("Replay window");
    await expect(receipt.getByTestId("fix-result-window")).toContainText("September and October together, not the October figure above");
    await expect(receipt.getByTestId("fix-result-window")).toContainText("$364.75 → $284.06");
    expect(await page.locator(PRIMARY).count()).toBeLessThanOrEqual(1);

    // A held decision in the Decision Lab: held, its incident one action away, and no approval
    // anywhere. B09's on a fresh seed; earlier specs may have fixed it, so the Overview names one.
    await page.goto("/?period=oct");
    // An incident hold (not an evidence hold, which has no incident to open).
    const incidentHolds = page.getByTestId("decision-holds").filter({ visible: true }).locator("li:not([data-testid='evidence-hold'])");
    const anyHeld = (await incidentHolds.count()) > 0;
    const heldBranch = anyHeld ? ((await incidentHolds.first().locator("a").first().textContent())?.trim() ?? "B09") : "B09";
    await page.goto(`/decisions?branch=${heldBranch}&period=oct`);
    const readiness = page.getByTestId("readiness-summary");
    if (anyHeld) {
      await expect(readiness.getByTestId("readiness-held")).toContainText("Held");
      await expect(readiness.getByTestId("readiness-next")).toBeVisible();
    }
    await expect(page.getByRole("button", { name: /approve/i })).toHaveCount(0);
    expect(await page.locator(PRIMARY).count()).toBeLessThanOrEqual(1);
  });
});

test.describe("J4 · the investigator, as a visitor", () => {
  test("@core a guest asks by keyboard; the answer names its path and cites records; a cited record opens", async ({ page }) => {
    test.setTimeout(120_000);
    await page.goto("/investigator");
    await expect(page.getByTestId("investigator-mode-note")).toContainText("deterministic evidence path");
    const question = page.getByLabel("Question");
    await tabUntil(page, () => question.evaluate((el) => el === document.activeElement));
    await page.keyboard.type("Why did B20's CAC jump in October?");
    await page.keyboard.press("Control+Enter");
    await page.waitForURL(/\/investigator\/\d+$/, { timeout: 90_000 });

    await expect(page.getByTestId("mode-badge")).toHaveText("Answered by the deterministic evidence path (no model)");
    await expect(page.getByTestId("investigation-workspace")).toContainText(/Your question on the public demo\. Available until .+ UTC/);
    await expect(page.getByTestId("findings")).toBeVisible();
    // B20's quarantine is resolved on the hosted copy (its approved correction) and after J3 here:
    // what happened comes from the correction's stored receipt, what CAC is now from the
    // scorecard, and the answer says the correction approved no budget move.
    if (NO_DATABASE || (await incidentOf("B20", "quarantined_source_records"))?.status === "resolved") {
      const findings = page.getByTestId("findings");
      // What happened: the receipt, stored when the repair ran, whatever ran since.
      await expect(findings).toContainText("read $490.11: $15,193.47 of paid spend divided by 31 new customers");
      await expect(findings).toContainText("paid attribution moved from 31 to 56 customers, while the $15,193.47 in paid spend and the 109 serviced customers stayed unchanged");
      // What it is now: the scorecard. $271.31 on the hosted copy; here earlier specs sync more B20
      // customers after the repair (os-modules), so only the sentence is checked.
      await expect(findings).toContainText(`B20, Oct 1–30, 2026 (UTC): paid-media CAC $${NO_DATABASE ? "271.31" : ""}`);
      // The recommended next action (the claim check repeats it, collapsed).
      await expect(page.locator("dd", { hasText: "a verified repair is not permission to move budget" })).toBeVisible();
    }
    const cite = page.getByTestId("citation").first();
    await expect(cite).toBeVisible();
    await cite.focus();
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("evidence-drawer")).toBeVisible();
    await page.keyboard.press("Escape");
    await expect(cite).toBeFocused();
    expect(await page.locator(PRIMARY).count()).toBeLessThanOrEqual(1);
  });
});

test.describe("J5 · Start here and the visitor tour", () => {
  /** Whether this deployment switches roles (demo mode): only then does the header offer the picker. */
  async function rolesSwitch(page: Page): Promise<boolean> {
    await expect(page.getByTestId("viewer-label")).toBeAttached();
    return (await page.getByTestId("role-switcher").count()) > 0;
  }

  test("@core a visitor reads Start here and walks the tour to its end, the bar in view at every step", async ({ page, browser }) => {
    test.setTimeout(240_000);
    if (!NO_DATABASE) await ensureB20Repaired(page);
    const visitor = await newPage(browser);
    let question: string | null = null;
    try {
      // Start here: two sentences, the walkthrough and its words, three ways in.
      await visitor.goto("/start");
      await expect(visitor.getByRole("heading", { level: 1 })).toHaveText("Revenue Signal OS");
      await expect(visitor.getByTestId("start-summary")).toContainText("before anyone moves marketing budget");
      await expect(visitor.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Start here" })).toHaveAttribute("aria-current", "page");
      await expect(visitor.getByTestId("start-video").locator("video source")).toHaveAttribute("src", "/media/b20-receipt-walkthrough.mp4");
      const mp4 = await visitor.request.get("/media/b20-receipt-walkthrough.mp4", { headers: { range: "bytes=0-1023" } });
      expect([200, 206], "the walkthrough is served").toContain(mp4.status());
      expect(mp4.headers()["content-type"]).toBe("video/mp4");
      expect((await visitor.request.get("/media/b20-receipt-walkthrough.jpg")).status(), "its poster is served").toBe(200);
      await expect(visitor.getByTestId("start-transcript").locator("li")).toHaveCount(9);
      expect(await visitor.locator(PRIMARY).count()).toBe(1);

      // The tour: seven steps, the bar in view at each, and no action a visitor could take.
      await visitor.getByTestId("start-tour").click();
      await expect(visitor).toHaveURL(/\/exceptions\/\d+\?guide=b20&step=1&incident=\d+#fix-result$/);
      const bar = visitor.getByTestId("tour-bar");
      const at = async (n: number, title: string) => {
        await expect(visitor.getByTestId("tour-step")).toHaveText(`Step ${n} of 7 · ${title}`);
        await expect(bar).toBeInViewport();
        await expect(visitor.getByRole("button", { name: /Dry run|Propose fix|Approve|Execute/ })).toHaveCount(0);
      };
      const next = async (n: number, title: string) => {
        await visitor.getByTestId("tour-next").click();
        await at(n, title);
      };
      await at(1, "The result");
      await expect(visitor.getByTestId("fix-result-cac")).toBeInViewport();
      await next(2, "Why it moved");
      await expect(visitor.getByTestId("fix-result-why")).toBeVisible();
      await expect(visitor.getByTestId("fix-result-unchanged")).toBeVisible();
      await next(3, "Evidence");
      await expect(visitor.locator("#evidence")).toBeInViewport();
      await expect(visitor.locator("#evidence")).toContainText("MISSING_FIELD");
      await next(4, "Held records");
      await expect(visitor.locator("#records")).toBeInViewport();
      await next(5, "Approval");
      const audit = visitor.getByTestId("case-audit");
      await expect(audit).toBeInViewport();
      for (const action of ["proposal_create", "proposal_dry_run", "proposal_approve", "proposal_execute"]) await expect(audit).toContainText(action);

      // The investigator, pre-filled; the answer opens on the same step, bar and all.
      await next(6, "Ask the investigator");
      await expect(visitor.getByLabel("Question")).toHaveValue("Why did B20's CAC jump in October?");
      await visitor.getByTestId("investigate-submit").click();
      await visitor.waitForURL(/\/investigator\/\d+\?guide=b20&step=6&incident=\d+$/, { timeout: 90_000 });
      question = new URL(visitor.url()).pathname;
      await at(6, "Ask the investigator");
      await expect(visitor.getByTestId("tour-say")).toContainText("Each finding cites the stored record it rests on");
      await expect(visitor.getByTestId("findings")).toBeVisible();

      await next(7, "The budget decision");
      await expect(visitor).toHaveURL(/\/decisions\?branch=B20&period=oct&guide=b20&step=7&incident=\d+$/);
      await expect(visitor.getByTestId("readiness-summary")).toBeVisible();
      await expect(visitor.getByRole("button", { name: /approve/i })).toHaveCount(0);
      await visitor.getByTestId("tour-done").click();
      await expect(visitor).toHaveURL(/\/start$/);
      await expect(visitor.getByTestId("tour-bar")).toHaveCount(0);
    } finally {
      // The visitor's question is theirs: delete it, so a run against a deployment leaves nothing.
      if (question) {
        await visitor.goto(question);
        await visitor.getByRole("button", { name: "Delete it now" }).first().click();
        await visitor.waitForURL(/\/investigator$/, { timeout: 30_000 });
      }
      await visitor.context().close();
    }
  });

  test("@core on a phone the tour's bar stays in view and leaves the page most of the screen", async ({ page, browser }) => {
    if (!NO_DATABASE) await ensureB20Repaired(page);
    const phone = await newPage(browser, { viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    try {
      await phone.goto("/start");
      await expect(phone.getByTestId("start-video")).toBeVisible();
      await phone.getByTestId("start-tour").click();
      await expect(phone.getByTestId("tour-step")).toHaveText("Step 1 of 7 · The result");
      // The figure the step is about is above the bar, not under it (it was, before the step opened
      // the receipt). Measured once both are shown: streamed text is in the document before it is.
      const bar = phone.getByTestId("tour-bar");
      const figure = phone.getByTestId("fix-result-cac");
      await expect(bar).toBeInViewport();
      await expect(figure).toBeInViewport();
      await expect
        .poll(async () => {
          const [f, b] = [await figure.boundingBox(), await bar.boundingBox()];
          return f !== null && b !== null && f.y >= 0 && f.y + f.height <= b.y;
        }, { message: "the figure is in the window, above the tour bar" })
        .toBe(true);
      await phone.getByTestId("tour-next").click();
      await expect(phone.getByTestId("tour-step")).toHaveText("Step 2 of 7 · Why it moved");
      await phone.getByTestId("tour-next").click();
      await expect(phone.getByTestId("tour-step")).toHaveText("Step 3 of 7 · Evidence");
      await expect(phone.locator("#evidence")).toBeInViewport();
      await expect(bar).toBeInViewport();
      const box = await bar.boundingBox();
      expect(box!.height, "the bar takes under a third of the screen").toBeLessThan(844 / 3);
      const { scroll, client } = await phone.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
      expect(scroll, "no sideways scroll").toBeLessThanOrEqual(client + 1);
    } finally {
      await phone.context().close();
    }
  });

  test("@core the guided demo offers the tour, and a role step only where roles switch", async ({ page, browser }) => {
    if (!NO_DATABASE) await ensureB20Repaired(page);
    const visitor = await newPage(browser);
    try {
      await visitor.goto("/demo");
      await expect(visitor.getByTestId("tour-card")).toBeVisible();
      await expect(visitor.getByTestId("tour-start")).toHaveAttribute("href", /\/exceptions\/\d+\?guide=b20&step=1&incident=\d+#fix-result$/);
      const switching = await rolesSwitch(visitor);
      if (switching) {
        // A presenter's copy (demo mode): the B09 path is there as well.
        await expect(visitor.getByTestId("demo-steps")).toBeVisible();
      } else {
        // The hosted site: no step a visitor cannot take, and one way in.
        await expect(visitor.getByTestId("hands-on-note")).toBeVisible();
        await expect(visitor.getByTestId("demo-steps")).toHaveCount(0);
        expect(await visitor.locator(PRIMARY).count()).toBe(1);
      }
      // An old link into the B09 presenter path: its role button only where it works.
      await visitor.goto("/?period=oct&guide=b09&step=4&gap=1");
      await expect(visitor.getByTestId("guide-bar")).toBeVisible();
      await expect(visitor.getByTestId("guide-use-role")).toHaveCount(switching ? 1 : 0);
      if (!switching) await expect(visitor.getByTestId("guide-role-off")).toBeVisible();
    } finally {
      await visitor.context().close();
    }
  });
});

test.describe("J2 · upload to result, twice", () => {
  test("@core two visitors: A reads its result and follows the ledger; B cannot open it, and nothing shared moves", async ({ browser }) => {
    test.setTimeout(240_000);
    const known = SEEDED_CALLS;
    if (!NO_DATABASE) expect(await ledgerCalls(2, known.map((c) => c.id)), "the ledger still holds the calls the file states").toEqual(SEEDED_CALLS);
    expect(known, "the demo ledger holds calls to compare with").toHaveLength(2);
    const file = Buffer.from(unseenCallsCsv(known));

    const b = await (await browser.newContext()).newPage();
    const before = await sharedFigures(b);

    const a = await (await browser.newContext()).newPage();
    await a.goto("/onboarding");
    // What a file may be and what happens to it, before anything is sent.
    const terms = a.getByTestId("upload-terms");
    await expect(terms).toContainText("CSV or TSV");
    await expect(terms).toContainText("Tracked phone calls");
    await expect(terms).toContainText("US dollars only");
    await expect(a.getByTestId("upload-limits")).toContainText("Up to 4 MB and 10,000 rows");
    await expect(a.getByTestId("upload-retention")).toContainText("never added to it or sent to a model");
    expect(await a.locator(PRIMARY).count()).toBeLessThanOrEqual(1);

    await upload(a, "unseen-calls.csv", file);
    await a.waitForURL(/\/onboarding\/\d+$/);
    const resultUrl = new URL(a.url()).pathname;
    await expect(a.getByTestId("step-rail")).toContainText("Suggested: Tracked phone calls");
    await answerAndCompare(a);

    // The result names the mode and never claims the rows were counted.
    const result = a.getByTestId("upload-result");
    await expect(a.getByTestId("workspace-label")).toContainText("Nothing was added to the ledger.");
    await expect(a.getByTestId("workspace-label")).toContainText(/Available until .+ UTC, then deleted within a day/);
    const words = await result.innerText();
    expect(words).not.toMatch(/\bbooked\b|\bpublished\b/i);
    expect(words.replace(/Nothing was added to the ledger/g, "")).not.toMatch(/added to the ledger/i);
    await expect(a.getByTestId("dry-run-counts")).toContainText("Would count after staff approval (local demo only)");
    expect(await a.locator(PRIMARY).count()).toBeLessThanOrEqual(1);

    await resultOnFirstScreen(a, 900);
    await a.setViewportSize({ width: 390, height: 844 });
    await resultOnFirstScreen(a, 844);
    await a.setViewportSize({ width: 1440, height: 900 });

    // A compared row opens the ledger record it was compared with, and Back returns to the result.
    const link = a.getByTestId("ledger-link").first();
    await expect(link).toBeVisible();
    await link.click();
    await a.waitForURL(/\/customers\/[^/]+$/);
    await a.goBack();
    await a.waitForURL((u) => u.pathname === resultUrl);
    await expect(a.getByTestId("upload-result")).toBeVisible();

    // The workspace keeps the upload across a reload: the list opens it again.
    await a.goto("/onboarding");
    await a.reload();
    await a.getByRole("link", { name: "unseen-calls.csv" }).click();
    await a.waitForURL((u) => u.pathname === resultUrl);
    await expect(a.getByTestId("upload-result")).toBeVisible();

    // B: A's upload is not available, B's workspace is empty, and the shared figures are unchanged.
    await b.goto(resultUrl);
    await expect(b.getByTestId("workspace-not-available")).toContainText("This workspace item is not available.");
    expect((await b.request.get(`/api${resultUrl.replace("/onboarding", "/onboarding/uploads")}`)).status()).toBe(404);
    await b.goto("/onboarding");
    await expect(b.getByText("No uploads yet")).toBeVisible();
    expect(await sharedFigures(b)).toEqual(before);
  });

  test("@edge a malformed file, a file over 4 MB, the same file twice, and an expired upload", async ({ page }) => {
    test.skip(NO_DATABASE, "expires an upload in the database");
    test.setTimeout(180_000);
    // Malformed: refused with the parser's reason; nothing opens.
    await upload(page, "broken.csv", Buffer.from([0, 159, 146, 150, 0, 1, 2, 3]));
    await expect(page.getByTestId("upload-error")).not.toBeEmpty();
    expect(new URL(page.url()).pathname).toBe("/onboarding");

    // Over 4 MB: refused by the browser from the file's size, before a byte is sent.
    let sent = 0;
    page.on("request", (r) => {
      if (r.method() === "POST" && new URL(r.url()).pathname === "/api/onboarding/uploads") sent++;
    });
    await upload(page, "big.csv", Buffer.alloc(Math.round(4.5 * 1_048_576), 0x61));
    await expect(page.getByTestId("upload-error")).toHaveText("This file is 4.5 MB; the public demo takes files up to 4 MB.");
    expect(sent).toBe(0);

    // The same file twice: the second opens the first's result, with the same counts.
    const file = Buffer.from(unseenCallsCsv(SEEDED_CALLS));
    await upload(page, "twice.csv", file);
    await page.waitForURL(/\/onboarding\/\d+$/);
    const url = new URL(page.url()).pathname;
    await answerAndCompare(page);
    const conclusion = await page.getByTestId("result-conclusion").innerText();
    await upload(page, "twice-again.csv", file);
    await page.waitForURL(/\/onboarding\/\d+\?repeat=1$/);
    expect(new URL(page.url()).pathname).toBe(url);
    await expect(page.getByTestId("repeat-notice")).toContainText("You uploaded this exact file on");
    await expect(page.getByTestId("result-conclusion")).toHaveText(conclusion);

    // Expired: after its 24 hours the upload is not available.
    await expireWorkspaceItem(Number(url.split("/").pop()));
    await page.goto(url);
    await expect(page.getByTestId("workspace-not-available")).toContainText("Items last 24 hours");
  });
});
