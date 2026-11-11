import { expect, test, type Page } from "@playwright/test";
import { setRole } from "./action-center";
import { reseedDemo } from "./db";
import { stageSample } from "./onboarding";

/**
 * Layout regressions for the redesign (docs/design-system.md, behaviour rule 5).
 *
 *   * Every page (and each Integrations view), at 1440 / 1280 / 768 / 390 px: no horizontal page scroll. Wide tables scroll
 *     inside their panel; the page never does. (The first redesign build failed this at 1440 and
 *     390 because grid panels could not shrink below their tables.)
 *   * Shell: the sidebar collapses to an icon rail and keeps every link's accessible name; the
 *     top bar shows scope and data freshness.
 *   * Pixel comparisons (`toHaveScreenshot`) run only with VISUAL=1: Playwright keeps one baseline
 *     per platform, and fonts render differently on Windows and Linux CI. They reseed first, so
 *     the pages show the freshly seeded scenario whatever earlier specs changed. Baselines live in
 *     tests/e2e/__screenshots__/ (playwright.config.ts snapshotPathTemplate); refresh them with
 *     `VISUAL=1 npx playwright test z-layout --update-snapshots` against a production build.
 */

const WIDTHS = [1440, 1280, 768, 390] as const;

async function b09IncidentHref(page: Page): Promise<string> {
  const res = await page.request.get(`/api/search?q=${encodeURIComponent("spend at B09 stopped")}`);
  const { hits } = (await res.json()) as { hits: Array<{ kind: string; href: string }> };
  return hits.find((h) => h.kind === "incident")?.href ?? "/exceptions";
}

const PAGES = (incident: string, upload: string): Array<[string, string]> => [
  ["overview", "/?period=oct"],
  ["incidents", "/exceptions"],
  ["incident", incident],
  ["investigator", "/investigator"],
  ["customers", "/customers"],
  ["decisions", "/decisions?branch=B09&period=oct"],
  ["feedback", "/feedback?period=oct"],
  ["definitions", "/definitions"],
  ["integrations", "/integrations"],
  ["integrations-mapping", "/integrations?view=mapping"],
  ["integrations-pipeline", "/integrations?view=pipeline"],
  ["incidents-filtered", "/exceptions?state=all&severity=high&kind=channel_coverage_gap"],
  ["audit", "/audit"],
  ["onboarding", "/onboarding"],
  ["onboarding-upload", upload],
  ["branch", "/branches/B09?period=oct"],
  ["demo", "/demo"],
];

test.describe("layout · no horizontal page scroll", () => {
  for (const width of WIDTHS) {
    test(`every page fits ${width}px`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.setViewportSize({ width, height: 900 });
      await setRole(page, "engineer");
      const incident = await b09IncidentHref(page);
      const upload = await stageSample(page, "demo-crm-payments.csv", { dryRun: true, answers: { moneyMeaning: { amount: "collected_payment" } } });
      await setRole(page, "engineer");
      const overflowing: string[] = [];
      for (const [name, url] of PAGES(incident, upload)) {
        await page.goto(url);
        await page.waitForLoadState("networkidle");
        const { scroll, client } = await page.evaluate(() => ({ scroll: document.documentElement.scrollWidth, client: document.documentElement.clientWidth }));
        if (scroll > client + 1) overflowing.push(`${name} (${url}): ${scroll}px wide in a ${client}px viewport`);
      }
      expect(overflowing, overflowing.join("\n")).toEqual([]);
    });
  }
});

test.describe("shell", () => {
  test("the top bar shows the viewer's scope and data freshness", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/");
    await expect(page.getByTestId("scope-indicator")).toContainText("All brands · 44 branches");
    await expect(page.getByTestId("freshness-indicator")).toContainText("Data as of");
    await setRole(page, "partner");
    await page.reload();
    await expect(page.getByTestId("scope-indicator")).toContainText("Branch B20 only");
  });

  test("the sidebar collapses to an icon rail, keeps link names, and remembers the choice", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/");
    const toggle = page.getByTestId("sidebar-collapse");
    await expect(toggle).toHaveAttribute("aria-pressed", "false");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-pressed", "true");
    // The width animates (150 ms): poll until it settles on the rail.
    await expect.poll(() => page.locator("[data-sidebar-root]").evaluate((el) => el.getBoundingClientRect().width)).toBeLessThanOrEqual(64);
    // Labels are hidden visually; each link still has its name (title + text for assistive tech).
    await expect(page.getByRole("navigation", { name: "Main" }).getByRole("link", { name: "Incidents" })).toBeVisible();
    await page.reload();
    await expect(page.getByTestId("sidebar-collapse")).toHaveAttribute("aria-pressed", "true");
    await page.getByTestId("sidebar-collapse").click(); // leave it expanded for later specs
  });
});

test.describe("visual regression (VISUAL=1)", () => {
  test.skip(!process.env.VISUAL, "pixel baselines are per platform; run with VISUAL=1 (update with --update-snapshots)");
  test.beforeAll(async () => {
    test.setTimeout(600_000);
    await reseedDemo();
  });
  for (const width of [1440, 390] as const) {
    test(`overview and incident at ${width}px match their baselines`, async ({ page }) => {
      await page.setViewportSize({ width, height: 900 });
      await setRole(page, "marketing");
      await page.goto("/?period=oct");
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveScreenshot(`overview-${width}.png`, { fullPage: true, maxDiffPixelRatio: 0.01 });
      await page.goto(await b09IncidentHref(page));
      await page.waitForLoadState("networkidle");
      await expect(page).toHaveScreenshot(`incident-${width}.png`, { fullPage: true, maxDiffPixelRatio: 0.01 });
    });
  }
});
