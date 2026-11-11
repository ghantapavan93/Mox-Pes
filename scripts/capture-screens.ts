import { mkdirSync } from "node:fs";
import path from "node:path";
import { chromium } from "@playwright/test";

/**
 * Full-page screenshots of every page at four widths, for before/after design review:
 *   npx tsx scripts/capture-screens.ts <out-dir> [base-url]
 * The server must run in demo mode (development, or `next start` with DEMO_MODE=1).
 * Read-only: it switches the demo role and navigates; it changes no data.
 */
const out = process.argv[2] ?? "docs/redesign/screens";
const base = process.argv[3] ?? process.env.BASE_URL ?? "http://localhost:3000";

const WIDTHS = [
  { name: "1440", width: 1440, height: 900 },
  { name: "1280", width: 1280, height: 800 },
  { name: "0768", width: 768, height: 1024 },
  { name: "0390", width: 390, height: 844 },
];

async function main() {
  mkdirSync(out, { recursive: true });
  const browser = await chromium.launch();
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const role = async (r: string) => {
      const res = await page.request.post(`${base}/api/role`, { data: { role: r } });
      if (!res.ok()) throw new Error(`POST /api/role ${res.status()}: is the server in demo mode?`);
    };
    await role("marketing");
    const search = await page.request.get(`${base}/api/search?q=${encodeURIComponent("spend at B09 stopped")}`);
    const hits = ((await search.json()) as { hits: Array<{ kind: string; href: string }> }).hits;
    const incident = hits.find((h) => h.kind === "incident")?.href ?? "/exceptions";
    const pages: Array<[string, string, string]> = [
      ["01-overview", "/?period=oct", "marketing"],
      ["02-incidents", "/exceptions", "marketing"],
      ["03-incident-b09", incident, "engineer"],
      ["04-investigator", "/investigator", "marketing"],
      ["05-customers", "/customers", "marketing"],
      ["06-decisions", "/decisions?branch=B09&period=oct", "marketing"],
      ["07-feedback", "/feedback?period=oct", "marketing"],
      ["08-definitions", "/definitions", "marketing"],
      ["09-integrations", "/integrations", "engineer"],
      ["10-audit", "/audit", "approver"],
      ["11-branch-b09", "/branches/B09?period=oct", "marketing"],
      ["12-demo", "/demo", "marketing"],
      ["13-integrations-mapping", "/integrations?view=mapping", "engineer"],
      ["14-integrations-pipeline", "/integrations?view=pipeline", "engineer"],
    ];
    for (const w of WIDTHS) {
      await page.setViewportSize({ width: w.width, height: w.height });
      for (const [name, url, r] of pages) {
        await role(r);
        await page.goto(`${base}${url}`, { waitUntil: "networkidle" });
        await page.waitForTimeout(300); // fonts and streamed Suspense boundaries settle
        await page.screenshot({ path: path.join(out, `${name}-${w.name}.png`), fullPage: true });
        console.log(`${name} @${w.width}`);
      }
    }
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
