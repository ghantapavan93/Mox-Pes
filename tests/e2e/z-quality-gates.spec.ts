import { expect, test, type Page } from "@playwright/test";
import { setRole, type Role } from "./action-center";

/**
 * Quality gates (docs/testing.md, "Hardening pass"). Each one started as a diagnostic sweep that
 * found real defects; these specs keep them found.
 *
 *   * Accessibility: axe-core, WCAG 2.0/2.1/2.2 A + AA and best practice, every page at 1440 and
 *     390 px. Zero violations. (First run: 6 rules failing.)
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
    ["branch", "/branches/B09?period=oct", "marketing"],
    ["demo", "/demo", "marketing"],
  ];
}

test.describe("quality gate · accessibility (axe, WCAG 2.2 AA)", () => {
  for (const width of [1440, 390] as const) {
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
    "/api/search": ["q"],
    "/api/customers": ["q", "branch", "lifecycle", "page"],
    "/api/metrics": ["period", "branch", "brand"],
    "/api/decisions/verdicts": ["branch", "period"],
    "/api/identity/conflicts": ["status", "limit"],
  };
  const PATHS = ["/exceptions/{v}", "/customers/{v}", "/branches/{v}", "/investigator/{v}", "/integrations/jobs/{v}", "/api/customers/{v}", "/api/investigations/{v}", "/api/connectors/jobs/{v}"];

  for (const role of ["marketing", "partner"] as const) {
    test(`no hostile query value or path id breaks a page or API · ${role}`, async ({ page }) => {
      test.setTimeout(300_000);
      await setRole(page, role);
      const broken: string[] = [];
      const check = async (url: string) => {
        const res = await page.request.get(url, { maxRedirects: 0 });
        const body = await res.text();
        if (res.status() >= 500 || DIGEST.test(body) || body.includes('data-testid="global-error"')) broken.push(`${res.status()} ${url.slice(0, 120)}`);
      };
      for (const [path, params] of Object.entries(QUERY)) {
        for (const key of params) for (const value of HOSTILE) await check(`${path}?${key}=${encodeURIComponent(value)}`);
        if (params[0]) await check(`${path}?${params[0]}=a&${params[0]}=b`);
      }
      for (const template of PATHS) for (const value of HOSTILE.filter(Boolean)) await check(template.replace("{v}", encodeURIComponent(value)));
      expect(broken, broken.join("\n")).toEqual([]);
    });
  }
});
