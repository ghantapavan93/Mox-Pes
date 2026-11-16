import { mkdirSync } from "node:fs";
import { expect, test, type Locator, type Page } from "@playwright/test";
import type { Pool } from "pg";
import { mapperFor, referenceContext } from "../../lib/adapters/registry";
import { createPool, DEFAULT_DATABASE_URL, getNow } from "../../lib/db";
import { runStream } from "../../lib/ingest/ingest";
import { InMemorySourceClient } from "../../lib/sim/clients";

/**
 * The Overview's "What changed" journey in the browser (docs/agent-work/OVERVIEW-MOVEMENT.md), on
 * the seeded demo world's B09 story: Google Local Services spend stops on Oct 13 while its calls
 * keep arriving (an open coverage-gap incident). Select B09 and October → read what changed →
 * select a point → open its stored records → come back with the selection intact.
 *
 * Also: a recorded $0.00 week (B07 Meta, revised to zero through the ads feed) against a week
 * with no record; a branch-restricted viewer; 390 and 320 px; keyboard.
 *
 * Runs before zz-b09-four-minute-path, which fixes the B09 incident (after the fix the stop is gone
 * from the chart, correctly). It revises B07's Meta spend for one week to $0.00 and delivers the
 * original figures again at the end, through the same feed.
 * OVERVIEW_SCREENS=<dir> saves labelled screenshots.
 */
const URL_ = process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL;
const SCREENS = process.env.OVERVIEW_SCREENS ?? null;
const BUILD = process.env.OVERVIEW_BUILD ?? "build";
const shown = (page: Page, id: string) => page.getByTestId(id).filter({ visible: true });
const HOUR = 3_600_000;

let pool: Pool;
let originals: Array<Record<string, unknown>> = [];

async function setRole(page: Page, role: string) {
  expect((await page.request.post("/api/role", { data: { role } })).ok()).toBe(true);
}

async function axeViolations(page: Page): Promise<string[]> {
  await page.addScriptTag({ path: require.resolve("axe-core/axe.min.js") });
  return page.evaluate(async () => {
    const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ target: string[] }> }> }> } }).axe;
    const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } });
    return result.violations.map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.nodes[0]?.target.join(" ")}`);
  });
}

const noSideScroll = (page: Page) => page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth + 1);

/** The element lies inside the viewport's width: readable without scrolling the page or its table sideways. */
async function insideWidth(page: Page, target: Locator) {
  const box = (await target.boundingBox())!;
  expect(box.x).toBeGreaterThanOrEqual(0);
  expect(box.x + box.width).toBeLessThanOrEqual(page.viewportSize()!.width + 1);
}

/** The daily evidence's table fits its box: nothing in it is hidden behind a sideways scroll. */
const evidenceTableFits = (page: Page) =>
  page.getByRole("region", { name: "Spend records for the selected week" }).filter({ visible: true }).evaluate((el) => el.scrollWidth <= el.clientWidth + 1);

/** The first day with a record and the first without: their Spend cells. */
const spendCell = (page: Page, record: "present" | "none") => shown(page, "overview-selection").locator(`tr[data-record="${record}"]`).first().locator("td").nth(1);

async function snap(page: Page, state: string, viewport: string, role: string, fullPage = true) {
  if (!SCREENS) return;
  mkdirSync(SCREENS, { recursive: true });
  if (fullPage) await page.evaluate(() => window.scrollTo(0, 0));
  await page.screenshot({ path: `${SCREENS}/final_${state}_${viewport}_${role}_${BUILD}.jpg`, fullPage, type: "jpeg", quality: 70 });
}

/** Cents in the dollars the Overview prints ("$842.34"). */
const usd = (cents: number) => `$${(cents / 100).toLocaleString("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;

/** One channel's spend at one branch in one week, straight from the stored records, or null. */
async function storedWeek(branch: string, channel: string, week: string): Promise<string | null> {
  const { rows } = await pool.query<{ cents: string | null }>(
    `select sum(s.cost_cents) as cents from ad_spend_daily s join campaign_branch_map m on m.campaign_id = s.campaign_id
     where m.branch_id = $1 and s.channel_code = $2 and s.spend_date >= $3::date and s.spend_date < $3::date + 7`,
    [branch, channel, week],
  );
  return rows[0].cents === null ? null : usd(Number(rows[0].cents));
}

/** `n` consecutive ISO dates from `first`. */
const daysFrom = (first: string, n: number) =>
  Array.from({ length: n }, (_, i) => new Date(Date.parse(`${first}T00:00:00Z`) + i * 86_400_000).toISOString().slice(0, 10));

/** The days the daily evidence lists, in order, each once (a day has one row per campaign record). */
async function evidenceDays(page: Page): Promise<string[]> {
  const rows = shown(page, "overview-selection").locator("tr[data-day]");
  await expect(rows.first()).toBeVisible();
  return [...new Set(await rows.evaluateAll((els) => els.map((el) => el.getAttribute("data-day") ?? "")))];
}

/** The daily evidence's amounts added up, in the Overview's dollars. */
async function evidenceTotal(page: Page): Promise<string> {
  const amounts = shown(page, "overview-selection").locator('tr[data-record="present"] td:nth-child(2)');
  await expect(amounts.first()).toBeVisible();
  const cents = await amounts.evaluateAll((els) =>
    els.reduce((t, el) => t + Math.round(Number(/\$([\d,]+\.\d{2})/.exec(el.textContent ?? "")?.[1].replace(/,/g, "") ?? Number.NaN) * 100), 0),
  );
  return usd(cents);
}

// Changed 2026-11-14 (B09-CROSS-VIEW.md): the daily evidence leads with the selected dates, as the
// page's own heading. It was the card's: level 2, "Selected on the Overview: <channel> · <week>".
const evidenceHeading = (page: Page, channelLabel: string, weekLabel: string) =>
  page.getByRole("heading", { level: 1, name: `${channelLabel} · ${weekLabel}`, exact: true });

async function selectBranch(page: Page, branch: string) {
  const scope = shown(page, "movement-scope");
  await scope.getByLabel("Branch").selectOption(branch);
  await scope.getByRole("button", { name: "Show" }).click();
  await expect(page).toHaveURL(new RegExp(`branch=${branch}`));
  await expect(shown(page, "movement")).toHaveAttribute("data-scope", branch);
}

async function selectPoint(page: Page, channelLabel: RegExp, weekLabel: string) {
  await shown(page, "movement-channels").getByRole("button", { name: channelLabel }).click();
  await shown(page, "movement-weeks").getByRole("button", { name: weekLabel }).click();
}

test.describe.configure({ mode: "serial" });

/** One polling run of the demo's ads feed at `when` (the real ingestion path). */
async function deliverSpend(payloads: Array<Record<string, unknown>>, when: Date) {
  const records = payloads.map((payload) => ({ stream: "ads", entity: "spend_day", visibleAt: when.getTime() - 60_000, payload }));
  const res = await runStream(pool, { client: new InMemorySourceClient("ads", "ads", records), mapper: mapperFor("ads"), ctx: referenceContext, now: when, windowEnd: when, overlapMs: 0, initialCursor: new Date(when.getTime() - 24 * HOUR) });
  expect(res.status).toBe("succeeded");
}

test.beforeAll(async () => {
  pool = createPool(URL_);
  // Precondition: the B09 story is still open (zz-b09-four-minute-path, which runs later, fixes it).
  const gap = await pool.query<{ status: string }>("select status from exceptions where kind = 'channel_coverage_gap' and branch_id = 'B09'");
  expect(gap.rows.map((r) => r.status), "the B09 coverage gap must be open: reseed (npm run db:seed)").toEqual(["open"]);
  // A recorded zero: B07's Meta campaign reports $0.00 for each day of Oct 19–25 (a revision through the ads feed).
  const { rows } = await pool.query<{ payload: Record<string, unknown> }>(
    `select distinct on (payload ->> 'date') payload from raw_events
     where source = 'ads' and payload ->> 'campaignId' = 'fb-B07' and payload ->> 'date' between '2026-10-19' and '2026-10-25'
     order by payload ->> 'date', received_at desc`,
  );
  expect(rows).toHaveLength(7);
  originals = rows.map((r) => r.payload);
  const now = await getNow(pool);
  await deliverSpend(originals.map((p) => ({ ...p, costMicros: "0", fetchedAt: new Date(now.getTime() - HOUR).toISOString() })), now);
});

test.afterAll(async () => {
  // The original figures again, as a later revision through the same feed: later specs see B07 as seeded.
  if (originals.length === 7) {
    const when = new Date((await getNow(pool)).getTime() + 5 * 60_000);
    await deliverSpend(originals.map((p) => ({ ...p, fetchedAt: new Date(when.getTime() - 30_000).toISOString() })), when);
    const restored = await pool.query<{ n: string }>(
      `select count(*) as n from ad_spend_daily s join ad_campaigns c on c.id = s.campaign_id
       where c.external_campaign_id = 'fb-B07' and s.spend_date between '2026-10-19' and '2026-10-25' and s.cost_cents > 0`,
    );
    expect(Number(restored.rows[0].n)).toBe(7);
  }
  await pool.end();
});

test("desktop: select B09 and October, read what changed, open the point's records, come back to the same selection", async ({ page }) => {
  test.setTimeout(180_000);
  await setRole(page, "marketing");
  await page.goto("/?period=oct");
  const movement = shown(page, "movement");
  await expect(movement).toHaveAttribute("data-scope", "all");
  await snap(page, "overview-all", "desktop-1440", "marketing");

  // Select B09; the period is the Overview's own tab (October).
  await selectBranch(page, "B09");
  await expect(shown(page, "movement-headline")).toHaveText("Google Local Services spend at B09 stopped after Oct 12 while its leads kept arriving.");
  await expect(shown(page, "movement-detail")).toContainText("which is filed as Google Search");
  await expect(shown(page, "movement-trust")).toHaveAttribute("data-tone", "review");
  // Changed 2026-11-14 (B09-CROSS-VIEW.md): one decision status, the incident's own, and its exact
  // evidence. It read "Investigate before acting", with a link to the bare incident.
  // Changed 2026-11-16 (HOLD-TO-DECISION.md §1.5): the decision first. It read "Decision held. None of …".
  await expect(shown(page, "movement-trust")).toContainText("Hold the budget decision. A required Google Local Services spend record is missing at B09: none of the 18 dates in the decision window (Oct 13–Oct 30) has one.");
  await expect(shown(page, "movement-status-link")).toHaveAttribute("href", /^\/exceptions\/\d+\?period=oct#recovery$/);
  await expect(movement.locator("[data-marker]")).toHaveCount(1);
  await expect(shown(page, "movement-definition")).toContainText("Paid media spend");
  // The chart's values are the stored records'.
  await shown(page, "movement-table").locator("summary").click();
  for (const week of ["2026-10-05", "2026-10-12"]) {
    await expect(movement.locator(`[data-cell="google_lsa|${week}"]`)).toContainText((await storedWeek("B09", "google_lsa", week))!);
  }
  expect(await storedWeek("B09", "google_lsa", "2026-10-19")).toBeNull();
  await expect(movement.locator('[data-cell="google_lsa|2026-10-19"]')).toHaveText("no record");
  // A point that counts fewer than 7 days is hollow: a week with days missing, or cut by the
  // window's edge (Oct 26–30). A full week is solid.
  await expect(shown(page, "movement-chart").locator("figcaption")).toContainText("a hollow point counts fewer than 7 days");
  for (const point of ["google_lsa|2026-10-12", "google_search|2026-10-26", "google_search|2026-08-31"]) {
    await expect(movement.locator(`[data-point="${point}"]`)).toHaveAttribute("fill", "var(--surface)");
  }
  await expect(movement.locator('[data-point="google_search|2026-10-19"]')).not.toHaveAttribute("fill", "var(--surface)");
  expect(await axeViolations(page)).toEqual([]);

  // Select a point: Local Services, the week after the gap opened.
  await selectPoint(page, /Google Local Services/, "Oct 19–Oct 25");
  const panel = shown(page, "movement-selection");
  await expect(panel).toHaveAttribute("data-selected", "google_lsa|2026-10-19");
  await expect(panel).toContainText("Google Local Services at B09 · Oct 19–Oct 25");
  await expect(panel).toContainText("No spend record on any of its 7 days. This is not $0");
  // The selected week is not the decision window: the panel says how the one stands against the other.
  await expect(shown(page, "movement-window")).toHaveText("None of the 18 dates in the decision window (Oct 13–Oct 30) has Google Local Services spend, this week's included. The decision stays held.");
  await expect(page).toHaveURL(/channel=google_lsa&week=2026-10-19#movement$/);
  await snap(page, "point-selected", "desktop-1440", "marketing");

  // Open evidence: the existing trace, carrying the selection.
  await panel.getByTestId("open-evidence").click();
  await expect(page).toHaveURL(/\/branches\/B09\/trace\?period=oct&metric=paid_spend&channel=google_lsa&week=2026-10-19$/);
  const selection = shown(page, "overview-selection");
  // The evidence is exactly the selected week: Mon Oct 19 to Sun Oct 25, each day once, in order.
  await expect(evidenceHeading(page, "Google Local Services", "Oct 19–Oct 25")).toBeVisible();
  await expect(selection).toHaveAttribute("data-week", "2026-10-19");
  expect(await evidenceDays(page)).toEqual(daysFrom("2026-10-19", 7));
  await expect(selection.locator('tr[data-record="none"]')).toHaveCount(7);
  await expect(shown(page, "selection-summary")).toContainText("No day of this week has a spend record");
  // Both facts together: this week's records, and the decision window they belong to.
  await expect(shown(page, "selection-window")).toHaveText("None of the 18 dates in the decision window (Oct 13–Oct 30) has Google Local Services spend, this week's included. The decision stays held.");
  await expect(shown(page, "selection-incident")).toContainText("coverage gap");
  await expect(shown(page, "selection-incident-link")).toHaveAttribute("href", /^\/exceptions\/\d+\?period=oct&channel=google_lsa&week=2026-10-19#recovery$/);
  await expect(shown(page, "selection-limits")).toContainText("do not establish");
  expect(await axeViolations(page)).toEqual([]);
  await snap(page, "evidence-selected-point", "desktop-1440", "marketing");

  // Back: the same branch, period, channel and week, already explained.
  await shown(page, "back-to-overview").click();
  await expect(page).toHaveURL(/\/\?period=oct&branch=B09&channel=google_lsa&week=2026-10-19#movement$/);
  await expect(shown(page, "movement-selection")).toHaveAttribute("data-selected", "google_lsa|2026-10-19");
  await expect(shown(page, "movement-weeks").getByRole("button", { name: "Oct 19–Oct 25" })).toHaveAttribute("aria-pressed", "true");
  await snap(page, "returned", "desktop-1440", "marketing");

  // The browser's own Back works too.
  await panel.getByTestId("open-evidence").click();
  await expect(page).toHaveURL(/\/trace\?/);
  await page.goBack();
  await expect(shown(page, "movement-selection")).toHaveAttribute("data-selected", "google_lsa|2026-10-19");

  // A week with records: the chart's figure is the sum of that week's daily records, same 7 days.
  await selectPoint(page, /Google Local Services/, "Oct 5–Oct 11");
  const recorded = (await storedWeek("B09", "google_lsa", "2026-10-05"))!;
  await expect(panel).toContainText(`${recorded}, from spend records on all 7 days`);
  await panel.getByTestId("open-evidence").click();
  await expect(page).toHaveURL(/\/branches\/B09\/trace\?period=oct&metric=paid_spend&channel=google_lsa&week=2026-10-05$/);
  await expect(evidenceHeading(page, "Google Local Services", "Oct 5–Oct 11")).toBeVisible();
  expect(await evidenceDays(page)).toEqual(daysFrom("2026-10-05", 7));
  await expect(selection.locator('tr[data-record="present"]')).toHaveCount(7);
  expect(await evidenceTotal(page)).toBe(recorded);
  await expect(shown(page, "selection-summary")).toHaveText(`All 7 days have a spend record: ${recorded} in all.`);
  await shown(page, "back-to-overview").click();
  await expect(page).toHaveURL(/\/\?period=oct&branch=B09&channel=google_lsa&week=2026-10-05#movement$/);
  await expect(panel).toHaveAttribute("data-selected", "google_lsa|2026-10-05");
  await expect(shown(page, "movement")).toHaveAttribute("data-scope", "B09");

  // The B09 hold is still one look away.
  await expect(page.getByTestId("decision-holds").filter({ visible: true }).locator("li", { hasText: "B09" })).toBeVisible();

  // Reset clears the selection and the URL.
  await shown(page, "reset-selection").click();
  await expect(shown(page, "movement-selection")).toHaveAttribute("data-selected", "");
  await expect(page).not.toHaveURL(/channel=/);
});

test("a recorded $0.00 is not a missing week", async ({ page }) => {
  await setRole(page, "marketing");
  await page.goto("/?period=oct&branch=B07");
  await selectPoint(page, /Meta/, "Oct 19–Oct 25");
  await expect(shown(page, "movement-selection")).toContainText("$0.00, recorded");
  const movement = shown(page, "movement");
  await shown(page, "movement-table").locator("summary").click();
  await expect(movement.locator('[data-cell="meta|2026-10-19"]')).toContainText("$0.00 (recorded)");
  await expect(movement.locator('[data-point="meta|2026-10-19"]')).toHaveAttribute("data-status", "zero");
  await snap(page, "real-zero", "desktop-1440", "marketing");

  // Its daily evidence: seven stored records, each $0.00 and labelled a recorded zero; no day without one.
  await shown(page, "open-evidence").click();
  await expect(page).toHaveURL(/\/branches\/B07\/trace\?period=oct&metric=paid_spend&channel=meta&week=2026-10-19$/);
  await expect(evidenceHeading(page, "Meta", "Oct 19–Oct 25")).toBeVisible();
  expect(await evidenceDays(page)).toEqual(daysFrom("2026-10-19", 7));
  const days = shown(page, "overview-selection");
  await expect(days.locator('tr[data-zero="true"]')).toHaveCount(7);
  await expect(days.locator('tr[data-record="none"]')).toHaveCount(0);
  await expect(days.getByText("recorded zero", { exact: true })).toHaveCount(7);
  await expect(shown(page, "selection-summary")).toHaveText("All 7 days have a spend record: every one reports $0.00, a recorded zero.");
  await snap(page, "evidence-real-zero", "desktop-1440", "marketing");
  // On a 390 phone each day's "$0.00, recorded zero" reads beside the day, with no sideways scroll.
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await noSideScroll(page)).toBe(true);
  for (const label of await days.getByText("recorded zero", { exact: true }).all()) await insideWidth(page, label);
  expect(await evidenceTableFits(page)).toBe(true);
  await snap(page, "evidence-real-zero", "phone-390", "marketing");
  await page.setViewportSize({ width: 1440, height: 900 });
  await shown(page, "back-to-overview").click();
  await expect(page).toHaveURL(/\/\?period=oct&branch=B07&channel=meta&week=2026-10-19#movement$/);
  await expect(shown(page, "movement-selection")).toHaveAttribute("data-selected", "meta|2026-10-19");
});

test("phone 390 and 320: the same journey reflows, keyboard and touch both select", async ({ page }) => {
  test.setTimeout(180_000);
  await setRole(page, "marketing");
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?period=oct&branch=B09");
  await expect(shown(page, "movement-headline")).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  await selectPoint(page, /Google Local Services/, "Oct 12–Oct 18");
  await expect(shown(page, "movement-selection")).toContainText("from records on 1 of 7 days");
  await snap(page, "point-selected", "phone-390", "marketing");
  await shown(page, "open-evidence").click();
  await expect(shown(page, "overview-selection")).toBeVisible();
  expect(await noSideScroll(page)).toBe(true);
  // The same week, day for day, and both kinds of day: one with a record, six without (not $0).
  await expect(evidenceHeading(page, "Google Local Services", "Oct 12–Oct 18")).toBeVisible();
  expect(await evidenceDays(page)).toEqual(daysFrom("2026-10-12", 7));
  await expect(shown(page, "overview-selection").locator('tr[data-record="present"]')).toHaveCount(1);
  await expect(shown(page, "overview-selection").locator('tr[data-record="none"]')).toHaveCount(6);
  await expect(shown(page, "selection-summary")).toContainText("1 of 7 days has a spend record");
  await expect(shown(page, "selection-summary")).toContainText("the other 6 have none, which is not the same as $0.");
  await expect(spendCell(page, "present")).toHaveText((await storedWeek("B09", "google_lsa", "2026-10-12"))!);
  await expect(spendCell(page, "none")).toHaveText("no spend record");
  await insideWidth(page, spendCell(page, "present"));
  await insideWidth(page, spendCell(page, "none"));
  expect(await evidenceTableFits(page)).toBe(true);
  await snap(page, "evidence-selected-point", "phone-390", "marketing");
  await shown(page, "back-to-overview").click();
  await expect(page).toHaveURL(/\/\?period=oct&branch=B09&channel=google_lsa&week=2026-10-12#movement$/);
  await expect(shown(page, "movement")).toHaveAttribute("data-scope", "B09");
  await expect(shown(page, "movement-selection")).toHaveAttribute("data-selected", "google_lsa|2026-10-12");
  expect(await axeViolations(page)).toEqual([]);

  await page.setViewportSize({ width: 320, height: 640 });
  await page.goto("/?period=oct&branch=B09");
  expect(await noSideScroll(page)).toBe(true);
  for (const id of ["movement-headline", "movement-trust", "movement-weeks", "movement-selection"]) {
    const box = await shown(page, id).boundingBox();
    expect(box!.x).toBeGreaterThanOrEqual(0);
    expect(box!.x + box!.width).toBeLessThanOrEqual(321);
  }
  await snap(page, "branch-selected", "phone-320", "marketing");
  // The evidence at 320: the same week, and its Spend column in view.
  await selectPoint(page, /Google Local Services/, "Oct 12–Oct 18");
  await shown(page, "open-evidence").click();
  expect(await evidenceDays(page)).toEqual(daysFrom("2026-10-12", 7));
  expect(await noSideScroll(page)).toBe(true);
  await insideWidth(page, spendCell(page, "present"));
  await insideWidth(page, spendCell(page, "none"));
  expect(await evidenceTableFits(page)).toBe(true);
  await snap(page, "evidence-selected-point", "phone-320", "marketing");

  // Keyboard only: the channel and the week are buttons in the tab order, with visible focus.
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/?period=oct&branch=B09");
  const channel = shown(page, "movement-channels").getByRole("button", { name: /Google Local Services/ });
  await channel.focus();
  await page.keyboard.press("Enter");
  await expect(channel).toHaveAttribute("aria-pressed", "true");
  const week = shown(page, "movement-weeks").getByRole("button", { name: "Oct 26–Oct 30" });
  await week.focus();
  expect(await week.evaluate((el) => getComputedStyle(el).outlineStyle !== "none")).toBe(true);
  await page.keyboard.press("Enter");
  await expect(shown(page, "movement-selection")).toHaveAttribute("data-selected", "google_lsa|2026-10-26");
  // The window's last week has 5 days in it (Oct 26–30): its evidence lists exactly those.
  await shown(page, "open-evidence").focus();
  await page.keyboard.press("Enter");
  await expect(evidenceHeading(page, "Google Local Services", "Oct 26–Oct 30")).toBeVisible();
  expect(await evidenceDays(page)).toEqual(daysFrom("2026-10-26", 5));
  await shown(page, "back-to-overview").focus();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/\?period=oct&branch=B09&channel=google_lsa&week=2026-10-26#movement$/);
  await expect(shown(page, "movement-selection")).toHaveAttribute("data-selected", "google_lsa|2026-10-26");
});

test("touch: a phone with a touch screen selects by tapping, and opens the evidence", async ({ browser }) => {
  const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage();
  await setRole(page, "marketing");
  await page.goto("/?period=oct&branch=B09");
  await shown(page, "movement-channels").getByRole("button", { name: /Google Local Services/ }).tap();
  await shown(page, "movement-weeks").getByRole("button", { name: "Oct 5–Oct 11" }).tap();
  await expect(shown(page, "movement-selection")).toHaveAttribute("data-selected", "google_lsa|2026-10-05");
  await expect(shown(page, "movement-selection")).toContainText("from spend records on all 7 days");
  await shown(page, "open-evidence").tap();
  await expect(shown(page, "overview-selection").locator('tr[data-record="present"]')).toHaveCount(7);
  await context.close();
});

test("the B09 hold does not jump when the panel arrives after it (1440 and 390)", async ({ browser }) => {
  const HOLD = "Google Local Services spend at B09 stopped";
  for (const viewport of [{ width: 1440, height: 900 }, { width: 390, height: 844 }]) {
    const context = await browser.newContext({ baseURL: test.info().project.use.baseURL, viewport });
    const page = await context.newPage();
    await setRole(page, "marketing");
    // Where the hold item sits the moment it is first shown (the panel may still be loading).
    await page.addInitScript((text) => {
      const w = window as unknown as { __firstTop: number | null };
      w.__firstTop = null;
      new MutationObserver(() => {
        if (w.__firstTop !== null) return;
        const li = [...document.querySelectorAll('[data-testid="decision-holds"] li')].find((l) => l.textContent?.includes(text)) as HTMLElement | undefined;
        if (li && li.offsetParent !== null && li.getBoundingClientRect().height > 0) w.__firstTop = li.getBoundingClientRect().top + window.scrollY;
      }).observe(document, { childList: true, subtree: true, attributes: true });
    }, HOLD);
    await page.goto("/?period=oct");
    await expect(shown(page, "movement-headline")).toBeVisible();
    const moved = await page.evaluate((text) => {
      const li = [...document.querySelectorAll('[data-testid="decision-holds"] li')].find((l) => l.textContent?.includes(text))!;
      return li.getBoundingClientRect().top + window.scrollY - (window as unknown as { __firstTop: number }).__firstTop;
    }, HOLD);
    expect(Math.abs(moved), `the hold moved ${Math.round(moved)} px at ${viewport.width}`).toBeLessThanOrEqual(40);
    await context.close();
  }
});

test("a branch-restricted viewer sees their branch only; another branch is refused, page and evidence", async ({ page }) => {
  await setRole(page, "partner");
  await page.goto("/?period=oct");
  await expect(shown(page, "movement")).toHaveAttribute("data-scope", "B20");
  await expect(shown(page, "movement-scope").getByLabel("Branch").locator("option")).toHaveCount(1);
  await page.goto("/?period=oct&branch=B09");
  await expect(shown(page, "movement-unavailable")).toContainText("B09 is outside your scope");
  await expect(page.locator("main")).not.toContainText("Google Local Services spend at B09");
  await page.goto("/branches/B09/trace?period=oct&metric=paid_spend&channel=google_lsa&week=2026-10-19");
  // Nothing of the selection: not its heading, its records or the window it belongs to.
  for (const text of ["Daily evidence", "Daily records", "Google Local Services · Oct 19–Oct 25", "decision window", "pmax-lsa-B09"]) {
    await expect(page.locator("main")).not.toContainText(text);
  }
  await snap(page, "outside-scope", "desktop-1440", "partner");
});
