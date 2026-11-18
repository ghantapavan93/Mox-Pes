/**
 * Route audit (release WP-C step 0): for every route in RELEASE-DESIGN.md §6, at 1440 × 900 and
 * 390 × 844, as the guest and as a role that can act, records what the first screen shows:
 *
 *   node route-audit.cjs <baseUrl> <out.md> [nodeModulesDir]
 *
 * Per row: HTTP status, the h1, whether the h1 starts inside the first screen, the first visible
 * primary action (data-variant="primary") and where it starts, how many primary actions are
 * visible, and whether the page scrolls sideways. Ids for detail routes are taken from the list
 * pages. The server runs with DEMO_MODE=1 so roles can be chosen. Reads only.
 */
const path = require("node:path");
const fs = require("node:fs");

const [, , baseUrl, outMd, modulesDir] = process.argv;
if (!baseUrl || !outMd) {
  console.error("usage: node route-audit.cjs <baseUrl> <out.md> [nodeModulesDir]");
  process.exit(2);
}
const { chromium } = require(path.join(modulesDir ?? path.resolve("node_modules"), "playwright"));

const VIEWPORTS = { desktop: { width: 1440, height: 900 }, phone: { width: 390, height: 844 } };

/** The first link on `listPath` whose href matches `pattern`, or null. */
async function firstHref(page, listPath, pattern) {
  await page.goto(baseUrl + listPath, { waitUntil: "networkidle", timeout: 120_000 });
  const hrefs = await page.locator("a[href]").evaluateAll((as) => as.map((a) => a.getAttribute("href")));
  return hrefs.find((h) => h && pattern.test(h)) ?? null;
}

async function setRole(context, role) {
  if (role === "guest") return;
  const res = await context.request.post(baseUrl + "/api/role", { data: { role } });
  if (!res.ok()) throw new Error(`role ${role}: ${res.status()}`);
}

(async () => {
  const browser = await chromium.launch();
  const discover = await browser.newContext();
  await setRole(discover, "engineer");
  const p = await discover.newPage();
  const ids = {
    exception: await firstHref(p, "/exceptions?status=open", /^\/exceptions\/\d+/),
    job: await firstHref(p, "/integrations", /^\/integrations\/jobs\/\d+/),
    investigation: await firstHref(p, "/investigator", /^\/investigator\/\d+/),
    inquiry: await firstHref(p, "/investigator", /^\/investigator\/inquiries\/\d+/),
    change: await firstHref(p, "/changes", /^\/changes\/\d+$/),
    assurance: await firstHref(p, "/assurance", /^\/assurance\/\d+/),
    customer: await firstHref(p, "/customers", /^\/customers\/(\d+|P-\d+)/),
    upload: await firstHref(p, "/onboarding", /^\/onboarding\/\d+/),
  };
  await discover.close();

  const routes = [
    ["/", "marketing"],
    ["/branches/B09?period=oct", "marketing"],
    ["/branches/B09/trace?period=oct&metric=paid_cac", "marketing"],
    ["/exceptions", "marketing"],
    [ids.exception, "engineer"],
    ["/decisions?branch=B20&period=oct", "marketing"],
    ["/decisions/opportunities", "marketing"],
    ["/integrations", "engineer"],
    [ids.job, "engineer"],
    ["/onboarding", "marketing"],
    [ids.upload, "marketing"],
    ["/investigator", "marketing"],
    [ids.investigation, "marketing"],
    [ids.inquiry, "marketing"],
    ["/changes", "engineer"],
    [ids.change, "engineer"],
    ["/assurance", "marketing"],
    [ids.assurance, "marketing"],
    ["/audit", "engineer"],
    ["/customers", "marketing"],
    [ids.customer, "marketing"],
    ["/definitions", "marketing"],
    ["/demo", "marketing"],
    ["/feedback", "marketing"],
  ].filter(([route]) => route);

  const rows = [];
  for (const [route, actor] of routes) {
    for (const role of ["guest", actor]) {
      for (const [size, viewport] of Object.entries(VIEWPORTS)) {
        const context = await browser.newContext({ viewport });
        await setRole(context, role);
        const page = await context.newPage();
        let status = 0;
        try {
          const res = await page.goto(baseUrl + route, { waitUntil: "networkidle", timeout: 120_000 });
          status = res ? res.status() : 0;
          await page.waitForTimeout(300);
        } catch (e) {
          rows.push({ route, role, size, status: "timeout", h1: "", h1Top: null, primary: "", primaryTop: null, primaries: 0, sideways: false });
          await context.close();
          continue;
        }
        const facts = await page.evaluate((vh) => {
          const h1 = document.querySelector("h1");
          const visible = (el) => {
            const r = el.getBoundingClientRect();
            const s = getComputedStyle(el);
            return r.width > 0 && r.height > 0 && s.visibility !== "hidden" && s.display !== "none";
          };
          const prim = [...document.querySelectorAll('[data-variant="primary"]')].filter(visible);
          const first = prim[0];
          return {
            h1: h1 ? h1.textContent.trim().replace(/\s+/g, " ").slice(0, 70) : "",
            h1Top: h1 ? Math.round(h1.getBoundingClientRect().top + scrollY) : null,
            primary: first ? first.textContent.trim().replace(/\s+/g, " ").slice(0, 40) : "",
            primaryTop: first ? Math.round(first.getBoundingClientRect().top + scrollY) : null,
            primaries: prim.length,
            sideways: document.documentElement.scrollWidth > innerWidth,
            vh,
          };
        }, viewport.height);
        rows.push({ route, role, size, status, ...facts });
        await context.close();
      }
    }
    console.log("audited", route);
  }
  await browser.close();

  const fold = (top, size) => (top === null ? "—" : `${top} px${top < VIEWPORTS[size].height ? "" : " (below)"}`);
  const lines = [
    "# Route audit (release WP-C step 0)",
    "",
    `Measured ${new Date().toISOString()} against ${baseUrl}. One row per route, role and width: the h1 and where it starts, the first visible primary action and where it starts, how many primary actions are visible, sideways scroll. "Below" means it starts past the first screen (900 px desktop, 844 px phone).`,
    "",
    "| Route | Role | Width | Status | h1 | h1 top | First primary action | Its top | Primaries | Sideways |",
    "|---|---|---|---|---|---|---|---|---|---|",
    ...rows.map((r) => `| \`${r.route}\` | ${r.role} | ${r.size} | ${r.status} | ${r.h1.replace(/\|/g, "\\|")} | ${fold(r.h1Top, r.size)} | ${r.primary.replace(/\|/g, "\\|") || "—"} | ${fold(r.primaryTop, r.size)} | ${r.primaries} | ${r.sideways ? "**yes**" : "no"} |`),
    "",
  ];
  fs.mkdirSync(path.dirname(outMd), { recursive: true });
  fs.writeFileSync(outMd, lines.join("\n"));
  console.log("wrote", outMd, rows.length, "rows");
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
