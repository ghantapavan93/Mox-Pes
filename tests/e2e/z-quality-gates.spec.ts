import { expect, test, type Page } from "@playwright/test";
import { setRole, type Role } from "./action-center";
import { stageSample } from "./onboarding";

/**
 * Quality gates (docs/testing.md, "Hardening pass"). Each one started as a diagnostic sweep that
 * found real defects; these specs keep them found.
 *
 *   * Accessibility: axe-core, WCAG 2.0/2.1/2.2 A + AA and best practice, every page at 1440,
 *     1280, 768 and 390 px. Zero violations, and no horizontal page scroll. (First run: 6 rules
 *     failing; 1280 and 768 and the investigation workspace added 2026-11-12.)
 *   * Layout shift: cumulative layout shift under 0.1, Google's "good" threshold, on every page at
 *     1440 and 390 px, measured from the first load. (First run: 0.25-0.39 on every desktop page.)
 *   * Hostile inputs: hostile query values and path ids on every page and read API, as two roles.
 *     No 5xx, and no error rendered behind a 200: a streamed page that fails after its headers are
 *     sent still answers 200, and its error reaches the client as a numeric digest.
 */

const DIGEST = /\\?"digest\\?":\\?"\d+/;

async function incidentHref(page: Page): Promise<string> {
  const res = await page.request.get(`/api/search?q=${encodeURIComponent("spend at B09 stopped")}`);
  const { hits } = (await res.json()) as { hits: Array<{ kind: string; href: string }> };
  return hits.find((h) => h.kind === "incident")?.href ?? "/exceptions";
}

async function customerHref(page: Page): Promise<string> {
  const res = await page.request.get("/api/customers?lifecycle=serviced");
  const body = (await res.json()) as { rows?: Array<{ kind: string; crmCustomerId: number | null }> };
  const first = body.rows?.find((r) => r.kind === "customer" && r.crmCustomerId);
  return first ? `/customers/${first.crmCustomerId}` : "/customers";
}

/** [name, url, role]: every page, as a role allowed to see it. */
async function pages(page: Page): Promise<Array<[string, string, Role]>> {
  await setRole(page, "engineer");
  const incident = await incidentHref(page);
  const customer = await customerHref(page);
  const upload = await stageSample(page, "demo-crm-payments.csv", { dryRun: true, answers: { moneyMeaning: { amount: "collected_payment" } } });
  // A preflight-only change (a source contract check), so no campaign mapping is held in review.
  await page.request.post("/api/role", { data: { role: "engineer" } });
  const sample = { id: "AXE-1", branch_tag: "B01", start_time: "2026-10-14T15:00:00.000Z", tracking_phone_number: "+12025550199", source: "Google Ads", gclid: null, campaign: null, agent_note: null, customer_phone_number: "+12125550123", call_score: 80 };
  const changeRes = await page.request.post("/api/changes", { data: { kind: "source_contract", payload: { source: "calls", entity: "call", samples: [sample] }, reason: "Accessibility gate fixture" } });
  expect(changeRes.status()).toBe(201);
  const change = `/changes/${(await changeRes.json()).change.id}`;
  // An investigation workspace (six hypotheses, versions, notes).
  await page.request.post("/api/role", { data: { role: "marketing" } });
  const inquiryRes = await page.request.post("/api/inquiries", { data: { kind: "cac_change", branchId: "B09" } });
  expect(inquiryRes.status()).toBe(201);
  const inquiry = `/investigator/inquiries/${(await inquiryRes.json()).id}`;
  return [
    ["overview", "/?period=oct", "marketing"],
    ["incidents", "/exceptions", "marketing"],
    ["incident", incident, "engineer"],
    ["investigator", "/investigator", "marketing"],
    ["customers", "/customers", "marketing"],
    ["customer", customer, "marketing"],
    ["decisions", "/decisions?branch=B09&period=oct", "marketing"],
    ["feedback", "/feedback?period=oct", "marketing"],
    ["definitions", "/definitions", "marketing"],
    ["integrations", "/integrations", "engineer"],
    ["integrations-mapping", "/integrations?view=mapping", "engineer"],
    ["integrations-pipeline", "/integrations?view=pipeline", "engineer"],
    ["audit", "/audit", "approver"],
    ["onboarding", "/onboarding", "marketing"],
    ["onboarding-upload", upload, "approver"],
    ["branch", "/branches/B09?period=oct", "marketing"],
    ["trace", "/branches/B09/trace?period=oct&metric=paid_cac", "marketing"],
    ["cash-trace", "/branches/B09/trace?period=oct&metric=collected", "approver"],
    // The refusal a branch partner sees for another branch's guided path.
    ["forbidden", "/demo", "partner"],
    ["demo", "/demo", "marketing"],
    ["changes", "/changes", "marketing"],
    ["change", change, "approver"],
    ["inquiry", inquiry, "marketing"],
  ];
}

test("a keyboard-only user skips the navigation and opens the trace's primary action", async ({ page }) => {
  await setRole(page, "approver");
  await page.goto("/branches/B09/trace?period=oct&metric=collected");
  await expect(page.getByTestId("cash-reproduced")).toBeVisible();

  // The first Tab lands on the skip link; Enter moves focus into the page's main region.
  await page.keyboard.press("Tab");
  await expect(page.getByTestId("skip-link")).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page.locator("main#main")).toBeFocused();

  // From there the primary action is a few Tabs away (breadcrumbs first), never behind the sidebar.
  const action = page.getByRole("link", { name: "Investigate this number" });
  for (let i = 0; i < 8 && !(await action.evaluate((el) => el === document.activeElement)); i++) await page.keyboard.press("Tab");
  await expect(action).toBeFocused();
  await page.keyboard.press("Enter");
  await expect(page).toHaveURL(/\/investigator\?branch=B09&q=/);
  await expect(page.getByRole("textbox", { name: "Question" })).toHaveValue(/collected/i);
});

test.describe("quality gate · accessibility (axe, WCAG 2.2 AA)", () => {
  for (const width of [1440, 1280, 768, 390] as const) {
    test(`every page has zero axe violations at ${width}px`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width, height: 900 });
      const axePath = require.resolve("axe-core/axe.min.js");
      const failures: string[] = [];
      for (const [name, url, role] of await pages(page)) {
        await setRole(page, role);
        await page.goto(url);
        await page.waitForLoadState("networkidle");
        await page.addScriptTag({ path: axePath });
        const violations = await page.evaluate(async () => {
          const axe = (window as unknown as { axe: { run: (ctx: Document, opts: unknown) => Promise<{ violations: Array<{ id: string; impact: string; nodes: Array<{ target: string[] }> }> }> } }).axe;
          const result = await axe.run(document, { runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"] } });
          return result.violations.map((v) => `${v.id} (${v.impact}) ×${v.nodes.length}: ${v.nodes[0]?.target.join(" ")}`);
        });
        for (const v of violations) failures.push(`${name} ${url}: ${v}`);
        // Long ids and figures must wrap, not push the page sideways.
        const overflow = await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
        if (overflow > 1) failures.push(`${name} ${url}: the page scrolls sideways by ${overflow}px`);
        // WCAG 2.4.2: each page names itself; a tab list of identical titles cannot be told apart.
        const title = await page.title();
        if (!/^.+ · Revenue Signal OS$/.test(title)) failures.push(`${name} ${url}: the title "${title}" does not name the page`);
      }
      expect(failures, failures.join("\n")).toEqual([]);
    });
  }
});

test.describe("quality gate · layout shift", () => {
  for (const width of [1440, 390] as const) {
    test(`every page's first load shifts less than 0.1 (CLS) at ${width}px`, async ({ page }) => {
      test.setTimeout(240_000);
      await page.setViewportSize({ width, height: 900 });
      await page.addInitScript(() => {
        const w = window as unknown as { __cls: number; __shifts: string[] };
        w.__cls = 0;
        w.__shifts = [];
        new PerformanceObserver((list) => {
          for (const entry of list.getEntries() as Array<PerformanceEntry & { value: number; hadRecentInput: boolean; sources?: Array<{ node?: Node }> }>) {
            if (entry.hadRecentInput) continue;
            w.__cls += entry.value;
            const node = entry.sources?.[0]?.node;
            w.__shifts.push(`${entry.value.toFixed(3)} ${node instanceof Element ? `${node.tagName.toLowerCase()}.${String(node.className).slice(0, 60)}` : "?"}`);
          }
        }).observe({ type: "layout-shift", buffered: true });
      });
      const over: string[] = [];
      for (const [name, url, role] of await pages(page)) {
        await setRole(page, role);
        await page.goto(url);
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(500); // late streamed boundaries and fonts
        const { cls, shifts } = await page.evaluate(() => {
          const w = window as unknown as { __cls: number; __shifts: string[] };
          return { cls: w.__cls, shifts: w.__shifts };
        });
        if (cls >= 0.1) over.push(`${name} ${url}: CLS ${cls.toFixed(3)} (${shifts.join("; ")})`);
      }
      expect(over, over.join("\n")).toEqual([]);
    });
  }
});

test.describe("quality gate · hydration", () => {
  // R-20: `getViewer` decided demo mode before reading the request. A build without DEMO_MODE
  // never touched cookies there, so Next prerendered the viewer into every static shell as
  // the guest; the request-time payload named the real role, and React threw #418 (text
  // mismatch) on every page for any non-guest role. Only a production build shows it: the
  // dev server prerenders nothing. Run this suite with CI=1.
  test("every page hydrates without an error as a non-guest role, and its HTML names that role", async ({ page }) => {
    test.setTimeout(240_000);
    const errors: string[] = [];
    let current = "";
    page.on("pageerror", (e) => errors.push(`${current}: ${e.message.slice(0, 160)}`));
    page.on("console", (m) => {
      if (m.type() === "error" && /hydrat|#418|#423|#425/i.test(m.text())) errors.push(`${current}: ${m.text().slice(0, 160)}`);
    });
    const guestLabel = 'data-testid="viewer-label">Guest';
    const wrongShell: string[] = [];
    for (const [name, url, role] of await pages(page)) {
      await setRole(page, role);
      current = `${name} ${url} as ${role}`;
      const html = await (await page.request.get(url)).text();
      if (html.includes(guestLabel)) wrongShell.push(current);
      await page.goto(url);
      await page.waitForLoadState("networkidle");
      await page.waitForTimeout(300); // a late streamed boundary hydrates after networkidle
    }
    expect(wrongShell, `HTML served a guest viewer to: ${wrongShell.join(", ")}`).toEqual([]);
    expect(errors, errors.join("\n")).toEqual([]);
  });
});

test.describe("quality gate · hostile inputs", () => {
  const HOSTILE = ["", "%00", "<script>alert(1)</script>", "'; drop table cases;--", "__proto__", "toString", "x".repeat(3000), "-1", "1e9", "99999999999999999999", "NaN", "Ｂ０９", "2026-02-30"];
  const QUERY: Record<string, string[]> = {
    "/": ["period", "brand"],
    "/exceptions": ["state", "severity", "kind", "owner", "branch", "page"],
    "/investigator": ["q", "exception", "branch"],
    "/customers": ["q", "branch", "lifecycle", "page"],
    "/decisions": ["branch", "period"],
    "/feedback": ["period"],
    "/integrations": ["view"],
    "/audit": ["actor", "action", "subject", "from", "to", "before"],
    "/onboarding/1": ["rows", "page"],
    "/api/onboarding/uploads/1/rows": ["disposition", "page"],
    "/api/search": ["q"],
    "/api/customers": ["q", "branch", "lifecycle", "page"],
    "/api/metrics": ["period", "branch", "brand"],
    "/api/decisions/verdicts": ["branch", "period"],
    "/api/identity/conflicts": ["status", "limit"],
  };
  const PATHS = ["/exceptions/{v}", "/customers/{v}", "/branches/{v}", "/investigator/{v}", "/integrations/jobs/{v}", "/api/customers/{v}", "/api/investigations/{v}", "/api/connectors/jobs/{v}", "/onboarding/{v}", "/api/onboarding/uploads/{v}", "/api/onboarding/uploads/{v}/rows"];

  // One test per route and role: about 600 requests in a single test ran into its time budget once
  // the Decision Lab (about 4 s a request on the seeded world) and the Overview (about 3 s) were
  // both requested 27 times (2026-11-12). Same requests, each route with its own budget.
  const broken = async (page: Page, urls: string[]) => {
    const out: string[] = [];
    for (const url of urls) {
      const res = await page.request.get(url, { maxRedirects: 0 });
      const body = await res.text();
      if (res.status() >= 500 || DIGEST.test(body) || body.includes('data-testid="global-error"')) out.push(`${res.status()} ${url.slice(0, 120)}`);
    }
    return out;
  };
  for (const role of ["marketing", "partner"] as const) {
    for (const [path, params] of Object.entries(QUERY)) {
      test(`no hostile query value breaks ${path} · ${role}`, async ({ page }) => {
        test.setTimeout(240_000);
        await setRole(page, role);
        const urls = params.flatMap((key) => HOSTILE.map((value) => `${path}?${key}=${encodeURIComponent(value)}`));
        if (params[0]) urls.push(`${path}?${params[0]}=a&${params[0]}=b`);
        const out = await broken(page, urls);
        expect(out, out.join("\n")).toEqual([]);
      });
    }
    test(`no hostile path id breaks a page or API · ${role}`, async ({ page }) => {
      test.setTimeout(240_000);
      await setRole(page, role);
      const out = await broken(page, PATHS.flatMap((template) => HOSTILE.filter(Boolean).map((value) => template.replace("{v}", encodeURIComponent(value)))));
      expect(out, out.join("\n")).toEqual([]);
    });
  }
});
