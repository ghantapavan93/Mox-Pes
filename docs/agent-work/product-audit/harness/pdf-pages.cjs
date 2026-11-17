// Renders each page of the PDF's print HTML to a PNG (print media, Letter at 96 dpi), so every
// page can be inspected where no PDF rasterizer is installed, and reports any page that overflows.
// Usage: node docs/agent-work/product-audit/harness/pdf-pages.cjs <walk output folder>
const path = require("node:path");
const { chromium } = require(path.join(process.cwd(), "node_modules", "@playwright/test"));

const DIR = path.resolve(process.argv[2] ?? "docs/agent-work/product-audit/final");

(async () => {
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 816, height: 1056 } });
  await page.goto(`file:///${path.join(DIR, "pdf.html").split(path.sep).join("/")}`);
  await page.emulateMedia({ media: "print" });
  await page.waitForLoadState("networkidle");
  const sections = page.locator("section.page");
  const n = await sections.count();
  for (let i = 0; i < n; i++) await sections.nth(i).screenshot({ path: path.join(DIR, `pdf-page-${i + 1}.png`) });
  // Content running into the footer (a flex body can spill without growing its page).
  const overflow = await page.evaluate(() =>
    [...document.querySelectorAll("section.page")].map((s) => {
      const footerTop = s.querySelector("footer").getBoundingClientRect().top;
      const contentBottom = Math.max(...[...s.querySelectorAll(".body > *")].map((el) => el.getBoundingClientRect().bottom));
      return Math.max(0, Math.round(contentBottom - footerTop));
    }),
  );
  console.log(`pages: ${n}; overflow (px) per page: ${JSON.stringify(overflow)}`);
  await browser.close();
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
