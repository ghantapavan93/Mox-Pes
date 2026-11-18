import { expect, test, type Page } from "@playwright/test";
import { setRole } from "./action-center";

/**
 * The shared controls (release WP-A; docs/design-system.md, "Button, ButtonLink, buttonClass"):
 * sizes, the touch hit area, the busy state that keeps focus and refuses a second press, success
 * only after a 2xx, a 409 shown as an error that refreshes the page, and a dropped connection.
 * Requests are answered by `page.route`, so no state changes on the server.
 */

const DROPPED = "The connection dropped before the server answered. The page now shows what the server stored.";
const REFRESHED = "The page now shows what the server stored.";

/** An open incident whose case can be reassigned by the marketing analyst. */
async function openIncidentWithCaseControls(page: Page): Promise<void> {
  await setRole(page, "marketing");
  await page.goto("/exceptions?status=open");
  const links = page.locator('a[href^="/exceptions/"]').filter({ hasNotText: /^$/ });
  const hrefs = (await links.evaluateAll((els) => els.map((e) => e.getAttribute("href") ?? ""))).filter((h) => /^\/exceptions\/\d+/.test(h));
  for (const href of hrefs.slice(0, 8)) {
    await page.goto(href);
    if (await page.getByTestId("case-controls").getByRole("button", { name: "Assign" }).count()) return;
  }
  throw new Error("no open incident offered case controls to the marketing analyst");
}

/** Chooses an owner other than the current one, so Assign is enabled. */
async function chooseAnotherOwner(page: Page): Promise<void> {
  const select = page.getByTestId("case-controls").getByLabel("Owner");
  const values = await select.locator("option").evaluateAll((os) => os.map((o) => (o as HTMLOptionElement).value));
  const current = await select.inputValue();
  await select.selectOption(values.find((v) => v !== current) ?? values[0]);
}

test.describe("controls · sizes and hit area", () => {
  test("a regular button is 32 px tall with a 16 px icon, a compact one 28 px", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/exceptions");
    const regular = page.getByRole("link", { name: "Ask the AI investigator" });
    await expect(regular).toHaveAttribute("data-variant", "secondary");
    expect((await regular.boundingBox())!.height).toBe(32);

    await openIncidentWithCaseControls(page);
    const assign = page.getByTestId("case-controls").getByRole("button", { name: "Assign" });
    expect((await assign.boundingBox())!.height).toBe(28);
  });

  test("on a touch screen the hit area is at least 44 × 44 px and the button keeps its size", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    const page = await context.newPage();
    // Headless Chromium does not report a coarse pointer for touch emulation; say so explicitly, as
    // a phone's browser does.
    const cdp = await context.newCDPSession(page);
    await cdp.send("Emulation.setEmulatedMedia", { features: [{ name: "pointer", value: "coarse" }, { name: "any-pointer", value: "coarse" }] });
    await openIncidentWithCaseControls(page);
    const assign = page.getByTestId("case-controls").getByRole("button", { name: "Assign" });
    const box = (await assign.boundingBox())!;
    expect(box.height).toBe(28);
    const hit = await assign.evaluate((el) => {
      const s = getComputedStyle(el, "::after");
      return { width: parseFloat(s.width), height: parseFloat(s.height), content: s.content };
    });
    expect(hit.content).not.toBe("none");
    expect(hit.width).toBeGreaterThanOrEqual(44);
    expect(hit.height).toBeGreaterThanOrEqual(44);
    await context.close();
  });

  test("keyboard focus shows the outline", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/exceptions");
    const link = page.getByRole("link", { name: "Ask the AI investigator" });
    await link.focus();
    await page.keyboard.press("Shift+Tab");
    await page.keyboard.press("Tab");
    const outline = await link.evaluate((el) => getComputedStyle(el).outlineStyle);
    expect(outline).toBe("solid");
  });
});

test.describe("controls · one request, its states", () => {
  test("busy keeps focus and size, ignores a second press, and success shows only after a 2xx", async ({ page }) => {
    await openIncidentWithCaseControls(page);
    await chooseAnotherOwner(page);
    // By test id: while busy the button's name is its working words.
    const assign = page.getByTestId("case-assign");
    await assign.focus(); // scrolls it into view first, so the box below is measured where it stays
    const before = (await assign.boundingBox())!;

    let calls = 0;
    let release!: () => void;
    const held = new Promise<void>((r) => (release = r));
    await page.route("**/api/cases/*", async (route) => {
      calls++;
      await held;
      await route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify({ message: "Assigned." }) });
    });

    await page.keyboard.press("Enter");
    await expect(assign).toHaveAttribute("aria-busy", "true");
    await expect(assign).toHaveAttribute("aria-disabled", "true");
    await expect(assign).toHaveAccessibleName("Saving…");
    await expect(assign).toBeFocused();
    expect(await assign.boundingBox()).toEqual(before);
    await page.keyboard.press("Enter");
    await expect(page.getByTestId("case-controls").getByText("Assigned.")).toHaveCount(0);

    release();
    await expect(page.getByTestId("case-controls").getByText("Assigned.")).toBeVisible();
    expect(calls).toBe(1);
  });

  test("a 409 is an error in the server's words, and the page refreshes", async ({ page }) => {
    await openIncidentWithCaseControls(page);
    await chooseAnotherOwner(page);
    await page.route("**/api/cases/*", (route) =>
      route.fulfill({ status: 409, contentType: "application/json", body: JSON.stringify({ error: "This case was closed by someone else." }) }),
    );
    await page.getByTestId("case-controls").getByRole("button", { name: "Assign" }).click();
    const alert = page.getByTestId("case-controls").getByRole("alert");
    await expect(alert).toContainText("This case was closed by someone else.");
    await expect(alert).toContainText(REFRESHED);
  });

  test("a dropped connection says so and refreshes", async ({ page }) => {
    await openIncidentWithCaseControls(page);
    await chooseAnotherOwner(page);
    await page.route("**/api/cases/*", (route) => route.abort("connectionreset"));
    await page.getByTestId("case-controls").getByRole("button", { name: "Assign" }).click();
    await expect(page.getByTestId("case-controls").getByRole("alert")).toContainText(DROPPED);
  });
});

test.describe("controls · disclosure", () => {
  test("the sidebar toggle reports aria-expanded under one constant name", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/");
    const toggle = page.getByTestId("sidebar-collapse");
    await expect(toggle).toHaveAttribute("aria-label", "Navigation sidebar");
    await expect(toggle).toHaveAttribute("aria-expanded", "true");
    await toggle.click();
    await expect(toggle).toHaveAttribute("aria-expanded", "false");
    await expect(toggle).toHaveAttribute("aria-label", "Navigation sidebar");
    await toggle.click(); // leave it expanded for later specs
  });
});

test.describe("shell · command menu and drawers", () => {
  test("Ctrl+K opens the menu, a result opens by Enter, and Escape returns focus to the opener", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/exceptions");
    const opener = page.getByRole("link", { name: "Ask the AI investigator" });
    await opener.focus();
    await page.keyboard.press("Control+k");
    const input = page.getByTestId("command-input");
    await expect(input).toBeFocused();
    await page.keyboard.press("Escape");
    await expect(input).toHaveCount(0);
    await expect(opener).toBeFocused();

    await page.keyboard.press("Control+k");
    await input.fill("B09");
    await expect(page.getByTestId("command-results").getByRole("option").first()).toBeVisible();
    await page.keyboard.press("Enter");
    await expect(page).not.toHaveURL(/\/exceptions$/);
    await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  });

  test("on a touch screen the sidebar's search button opens the menu", async ({ browser }) => {
    const context = await browser.newContext({ viewport: { width: 1280, height: 800 }, hasTouch: true });
    const page = await context.newPage();
    await setRole(page, "marketing");
    await page.goto("/exceptions");
    await page.getByRole("button", { name: /Search or jump to/ }).first().tap();
    await expect(page.getByTestId("command-input")).toBeFocused();
    await context.close();
  });

  test("a drawer keeps Tab inside, locks the page's scroll, and returns focus on Escape", async ({ page }) => {
    await setRole(page, "marketing");
    await page.goto("/customers?q=CAL0000838");
    await page.getByTestId("customer-table").getByRole("link").first().click();
    const source = page.getByTestId("journey-timeline").getByRole("button", { name: /^Show source payload for / }).first();
    await source.click();
    const drawer = page.getByRole("dialog");
    await expect(drawer).toBeVisible();
    await expect(drawer.getByRole("button", { name: /Close/ })).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("hidden");
    for (let i = 0; i < 25; i++) await page.keyboard.press("Tab");
    expect(await drawer.evaluate((d) => d.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Escape");
    await expect(drawer).toHaveCount(0);
    await expect(source).toBeFocused();
    expect(await page.evaluate(() => document.body.style.overflow)).toBe("");
  });
});
