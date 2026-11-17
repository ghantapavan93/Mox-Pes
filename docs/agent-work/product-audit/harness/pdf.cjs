// Builds the three-page external PDF from the walk's element crops (docs/agent-work/product-audit/
// harness/walk.cjs). Text is real text (selectable); every image is a crop of the running app.
// Usage: node docs/agent-work/product-audit/harness/pdf.cjs <walk output folder> <pdf path>
const path = require("node:path");
const fs = require("node:fs");
const { chromium } = require(path.join(process.cwd(), "node_modules", "@playwright/test"));

const DIR = path.resolve(process.argv[2] ?? "docs/agent-work/product-audit/final");
const PDF = path.resolve(process.argv[3] ?? path.join(DIR, "revenue-signal-b20.pdf"));
const facts = JSON.parse(fs.readFileSync(path.join(DIR, "walk.json"), "utf8"));
const img = (name) => `crops/${name}.png`;
const LABEL = "Independent prototype · synthetic data · no Moxie systems connected";

const page = (n, title, lede, body) => `
<section class="page">
  <header><span class="kicker">${n} of 3</span><h1>${title}</h1><p class="lede">${lede}</p></header>
  <div class="body">${body}</div>
  <footer>${LABEL}</footer>
</section>`;
const fig = (name, caption, cls = "") => `<figure class="${cls}"><img src="${img(name)}" alt=""><figcaption>${caption}</figcaption></figure>`;

const html = `<!doctype html><html><head><meta charset="utf-8"><title>Revenue Signal: one fix, verified</title>
<style>
  @page { size: Letter; margin: 0; }
  * { box-sizing: border-box; }
  body { margin: 0; font-family: "Segoe UI", system-ui, sans-serif; color: #18181b; background: #fff; }
  .page { width: 8.5in; height: 11in; padding: 0.55in 0.6in 0.5in; display: flex; flex-direction: column; page-break-after: always; }
  .page:last-child { page-break-after: auto; }
  .kicker { font-size: 9pt; letter-spacing: .08em; text-transform: uppercase; color: #71717a; }
  h1 { font-size: 19pt; line-height: 1.2; margin: 4pt 0 6pt; letter-spacing: -0.01em; }
  .lede { font-size: 10.5pt; line-height: 1.45; color: #3f3f46; margin: 0 0 10pt; max-width: 6.6in; }
  .body { flex: 1; display: flex; flex-direction: column; gap: 10pt; min-height: 0; }
  figure { margin: 0; border: 1px solid #e4e4e7; border-radius: 8px; padding: 8px; background: #fafafa; }
  figure img { display: block; max-width: 100%; max-height: 3.1in; margin: 0 auto; object-fit: contain; }
  figure.tall img { max-height: 4.4in; }
  figure.short img { max-height: 2.18in; }
  figure.xtall img { max-height: 5.1in; }
  figcaption { font-size: 9pt; color: #52525b; margin-top: 6px; line-height: 1.35; }
  .facts { display: grid; grid-template-columns: 1.1in 1fr; gap: 4pt 10pt; font-size: 10pt; line-height: 1.4; margin: 0; }
  .facts dt { font-weight: 600; } .facts dd { margin: 0; color: #3f3f46; }
  footer { font-size: 8.5pt; color: #71717a; border-top: 1px solid #e4e4e7; padding-top: 6pt; margin-top: 8pt; }
</style></head><body>
${page(
  1,
  "B20's acquisition cost jumped. Cut its paid media, or hold?",
  "October paid-media CAC at B20 read $490.11, against $296.58 in September, and the plausible reading is that paid search got expensive. Before anyone moves budget, the product marks the comparison unsafe and names the incident behind it.",
  fig("p1-headline", "The Overview leads with revenue tied up in open exceptions, and where to start.", "short") +
    fig("p1-holds", "Three budget decisions are on hold, each with the incident that holds it.", "short") +
    fig("p1-budget-signal", "At B20 the budget signal reads <b>Not trustworthy yet</b>: an open incident changes which customers each channel produced.", "short"),
)}
${page(
  2,
  "The evidence a reviewer can inspect",
  "119 call records were held back because the caller field moved; nothing was guessed. A dry run, rolled back, shows exactly what the fix would change before anyone approves it.",
  fig("p2-evidence", "The held records, with contact details hashed before storage.", "short") +
    fig("p2-dry-run", "The dry run: what is expected to move, then five ledger totals that must not. Each reads <i>conserved</i>.", "xtall"),
)}
${page(
  3,
  "What changed, what did not, what is still open",
  "After a second role approved, the application ran the fix once and verified it.",
  fig("p3-fix-result", "The resolved incident leads with its result.", "tall") +
    fig("p3-headline-after", "The Overview afterwards: B20 is no longer where to start.", "short") +
    `<dl class="facts">
      <dt>Decision</dt><dd>Hold, then fix the feed: the jump was measurement. After the replay, B20's October CAC is $271.31, below September's $296.58, with the same spend and the same 109 customers.</dd>
      <dt>Changed</dt><dd>B20 paid-media CAC, Sep 1 – Oct 30: $364.75 → $284.06, because 25 more new customers were credited to paid media (88 → 113).</dd>
      <dt>Unchanged</dt><dd>Paid-media spend ($32,098), new customers on all channels (246), and the five ledger totals.</dd>
      <dt>Still open</dt><dd>The replay opened 3 door-to-door / paid conflicts at B20 ($148 at stake), with a link to review them.</dd>
      <dt>Not claimed</dt><dd>No budget move was approved: "trustworthy" means the inputs agree. Attributed cost says nothing about effectiveness.</dd>
    </dl>`,
)}
</body></html>`;

(async () => {
  fs.writeFileSync(path.join(DIR, "pdf.html"), html);
  const browser = await chromium.launch();
  const p = await browser.newPage();
  await p.goto(`file:///${path.join(DIR, "pdf.html").replace(/\\/g, "/")}`);
  await p.waitForLoadState("networkidle");
  await p.pdf({ path: PDF, format: "Letter", printBackground: true, preferCSSPageSize: true });
  await browser.close();
  console.log(`wrote ${PDF} (facts from ${facts.receipt ? "the walk" : "missing walk facts"})`);
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
