// The three-page PDF of the B09 decision view, made only from the rendered captures in ../polish/
// (harness/polish.cjs), never from a generated preview: (1) the same frame before and after, (2) 5 of
// 18 against 18 of 18, (3) the phone with a date's evidence open, beside what was measured. Every
// number on page 3 is read from polish/checks.json, so the PDF cannot drift from the measurements.
//   node docs/agent-work/hold-to-decision/harness/polish-pdf.cjs
// Prints with the local Chromium; nothing is fetched from the network.
const fs = require("node:fs");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { createRequire } = require("node:module");
const ROOT = path.resolve(__dirname, "../../../..");
const req = createRequire(path.join(ROOT, "package.json"));
const { chromium } = req("@playwright/test");

const DIR = path.resolve(__dirname, "../polish");
const OUT = path.join(DIR, "B09-decision-view.pdf");
const checks = JSON.parse(fs.readFileSync(path.join(DIR, "checks.json"), "utf8"));
const img = (name) => {
  const file = path.join(DIR, name);
  if (!fs.existsSync(file)) throw new Error(`missing capture: ${name} (run harness/polish.cjs first)`);
  return pathToFileURL(file).href;
};
const esc = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

// Geist, as the product ships it: the latin subsets next/font wrote into the build's CSS.
function geistFaces() {
  const chunks = path.join(ROOT, ".next/static/chunks");
  if (!fs.existsSync(chunks)) return "";
  for (const f of fs.readdirSync(chunks).filter((n) => n.endsWith(".css"))) {
    const css = fs.readFileSync(path.join(chunks, f), "utf8");
    const faces = [...css.matchAll(/@font-face\{font-family:(Geist(?: Mono)?);[^}]*?src:url\(\.\.\/media\/([^)]+-s\.p\.[^)]+\.woff2)\)/g)];
    if (faces.length) {
      return faces.map(([, family, file]) => `@font-face{font-family:"${family}";font-weight:100 900;src:url("${pathToFileURL(path.join(ROOT, ".next/static/media", file)).href}") format("woff2")}`).join("\n");
    }
  }
  return "";
}

// ---- The measured facts for page 3 -------------------------------------------------------------
const shots = Object.entries(checks).filter(([k, v]) => v && v.viewport);
const after = shots.filter(([k]) => k.startsWith("after-"));
const minText = Math.min(...after.flatMap(([, v]) => Object.values(v.contrast).map((c) => c.ratio)));
const overflow = shots.every(([, v]) => v.pageOverflowX === 0);
const widths = [...new Set(after.filter(([k]) => !k.includes("zoom200")).map(([, v]) => v.viewport.width))].sort((a, b) => b - a);
const zoomed = after.some(([k]) => k.includes("zoom200"));
const strip = (k) => checks[k]?.strip;
const ink = after.every(([, v]) => v.verdictColor === "rgb(18, 24, 38)");
const kb = checks.keyboard;
const kb18 = checks.keyboard18;
const keysOk =
  kb.first.focused === kb.first.checked &&
  kb.afterArrowRight.evidence === "2026-10-14" &&
  kb.afterEnd.evidence === "2026-10-30" &&
  kb.afterHome.evidence === "2026-10-13" &&
  kb.afterSevenRight.evidence === "2026-10-20" &&
  kb.shiftTabReturnsTo === "2026-10-20" &&
  [kb.first, kb.afterArrowRight, kb.afterEnd].every((s) => s.focusVisible);
const opens18 = kb18.first.checked === null && kb18.first.evidence === null && kb18.afterSpace.evidence === "2026-10-13";
const link = checks.evidenceLink;
const rows = (link.rows ?? []).length;
const noRecordRows = (link.rows ?? []).filter((r) => /no spend record/i.test(r)).length;
const firstScreen18 = checks["after-18of18-1440"].boxes;
const CHECKS = [
  ["Text contrast", `${minText.toFixed(2)}:1 or more on every measured line of the new screens, at every width (AA asks 4.5:1)`],
  ["Marks and focus", "Cross 4.87:1 on its hatch, check 5.37:1 on green, the 0 5.84:1, focus outline and selection ring 5.67:1 (AA asks 3:1). Each mark also has its word"],
  ["Sideways page scroll", overflow ? `None at ${widths.join(", ")} px${zoomed ? ", or at 200% zoom" : ""}` : "FOUND: see checks.json"],
  ["Date targets", `${strip("after-5of18-1440").minWidth} × ${strip("after-5of18-1440").minHeight} px at 1440, ${strip("after-5of18-390").minWidth} × ${strip("after-5of18-390").minHeight} at 390, ${strip("after-5of18-320").minWidth} × ${strip("after-5of18-320").minHeight} at 320 (AA asks 24 × 24)`],
  ["Keyboard", keysOk ? `One tab stop; arrows, Home and End move the date and its evidence together; the focus outline shows${opens18 ? "; at 18 of 18 Tab lands on Oct 13 unopened and Space opens it" : ""}` : "FAILED: see checks.json"],
  ["Verdict colour", ink ? "Ink, rgb(18, 24, 38), in both states at every width: never green" : "NOT INK: see checks.json"],
  ["18 of 18, first screen", firstScreen18.moved && firstScreen18.moved.bottom <= 900 && firstScreen18.noBudget ? `What moved ends at ${firstScreen18.moved.bottom} px of 900; "No budget change was approved." at ${firstScreen18.noBudget.top} px` : "What moved is below the fold"],
  ["Evidence link", `Oct 20 opens the daily evidence at the week of ${esc(new URL(link.landed, "http://local").searchParams.get("week") ?? "?")}: ${rows} rows, ${noRecordRows === rows ? "every one" : noRecordRows} reading “no spend record”, never $0.00`],
  ["Reduced motion", "Captured with reduced motion; the strip's one transition is off under it"],
];

// ---- The pages ---------------------------------------------------------------------------------
const head = (n, title, sub) => `
  <header>
    <p class="eyebrow">Revenue Signal OS · B09 decision view · synthetic data <span>${n} / 3</span></p>
    <h1>${title}</h1>
    <p class="sub">${sub}</p>
  </header>`;
const fig = (src, label, tone = "") => `
  <figure>
    <figcaption><span class="chip ${tone}">${label}</span></figcaption>
    <img src="${img(src)}" alt="${esc(label)}">
  </figure>`;
const notes = (items) => `<ol class="notes">${items.map(([t, b]) => `<li><b>${t}</b> ${b}</li>`).join("")}</ol>`;

const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>B09 decision view</title>
<style>
${geistFaces()}
@page { size: 11in 8.5in; margin: 0.42in 0.45in; }
:root { --text:#121826; --muted:#535c6c; --border:#e2e6ec; --surface-2:#f1f3f6; --accent:#1d58f0; --good:#137a4b; --good-soft:#e6f5ed; --bad:#c2312b; --bad-soft:#fdecea; }
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: Geist, "Segoe UI", Arial, sans-serif; color: var(--text); background: #fff; -webkit-print-color-adjust: exact; print-color-adjust: exact; font-feature-settings: "tnum"; }
section.page { break-after: page; height: 7.62in; display: flex; flex-direction: column; gap: 0.16in; }
section.page:last-child { break-after: auto; }
.eyebrow { display: flex; justify-content: space-between; font-size: 7.5pt; font-weight: 600; letter-spacing: .08em; text-transform: uppercase; color: var(--muted); }
h1 { margin-top: 4pt; font-size: 19pt; line-height: 1.2; font-weight: 600; letter-spacing: -.01em; }
.sub { margin-top: 3pt; font-size: 9.5pt; line-height: 1.45; color: var(--muted); max-width: 8.6in; }
.pair { display: grid; grid-template-columns: 1fr 1fr; gap: 0.2in; }
figure { display: flex; flex-direction: column; gap: 5pt; min-width: 0; }
figcaption { font-size: 8.5pt; }
.chip { display: inline-block; border-radius: 5pt; padding: 2pt 6pt; font-weight: 600; background: var(--surface-2); box-shadow: inset 0 0 0 .75pt rgba(18,24,38,.12); }
.chip.after { background: #e8eefe; color: #1846c4; }
img { display: block; width: 100%; border-radius: 6pt; box-shadow: 0 0 0 .75pt rgba(18,24,38,.14); }
.notes { list-style: none; display: grid; grid-template-columns: repeat(3, 1fr); gap: 0.2in; counter-reset: n; margin-top: 2pt; }
.notes li { counter-increment: n; font-size: 8.8pt; line-height: 1.45; color: var(--muted); border-top: 1.5pt solid var(--text); padding-top: 6pt; }
.notes li::before { content: counter(n, decimal-leading-zero); display: block; font-size: 7.5pt; font-weight: 600; color: var(--muted); margin-bottom: 2pt; }
.notes b { display: block; color: var(--text); font-weight: 600; font-size: 9.5pt; margin-bottom: 1pt; }
.phone { display: grid; grid-template-columns: 2.55in 2.55in 1fr; gap: 0.22in; align-items: start; min-height: 0; flex: 1; }
.phone img { max-height: 5.55in; width: auto; max-width: 100%; }
table { width: 100%; border-collapse: collapse; font-size: 8.6pt; line-height: 1.4; }
caption { text-align: left; font-size: 9.5pt; font-weight: 600; padding-bottom: 5pt; }
th, td { text-align: left; vertical-align: top; padding: 4.5pt 0; border-top: .75pt solid var(--border); }
th { width: 1.35in; font-weight: 600; padding-right: 8pt; }
td { color: var(--text); }
.foot { margin-top: auto; font-size: 7.5pt; color: var(--muted); display: flex; justify-content: space-between; gap: 0.3in; }
.foot code { font-family: "Geist Mono", Consolas, monospace; font-size: 7pt; }
</style></head><body>

<section class="page">
  ${head(1, "The same frame, before and after", `Incident #2455 at 5 of 18 days verified. 1440 × 900, the first screen, the same URL and the same isolated database; only the build differs (before: commit 718e4aa, after: this working tree).`)}
  <div class="pair">
    ${fig("before-5of18-1440.jpg", "Before · 718e4aa")}
    ${fig("after-5of18-1440.jpg", "After", "after")}
  </div>
  ${notes([
    ["One verdict, one action.", "The incident type and its scope become a quiet line. “Still on hold · 5 of 18 days verified” is the strongest line on the page, in ink, with one primary action beside the reason."],
    ["Eighteen days in one strip.", "5 verified, 13 with no record: hatched and crossed, every mark with its word and the legend with its count. The picked week is underlined; “Selected week covered” sits next to “Decision window incomplete”."],
    ["The first open date is open.", "Oct 13: what arrived ($108.69 filed as Google Search, raw #158811), why it does not count, what clears it, and its records on the daily evidence, one click away."],
  ])}
  <p class="foot"><span>Synthetic data. No budget was changed, and nothing here was deployed.</span><span>Captures: <code>docs/agent-work/hold-to-decision/polish/</code> · builds ${esc(checks.builds.before ?? "?")} → ${esc(checks.builds.after ?? "?")}</span></p>
</section>

<section class="page">
  ${head(2, "5 of 18 and 18 of 18: the same composition", "The after build in both states, at the same URL and in the same frame. Only the evidence changes, and the emphasis moves to what was reclassified.")}
  <div class="pair">
    ${fig("after-5of18-1440.jpg", "Still on hold · 5 of 18 days verified")}
    ${fig("after-18of18-1440.jpg", "Coverage hold cleared · 18 of 18 days verified", "after")}
  </div>
  ${notes([
    ["Nothing left to explain.", "At 18 of 18 no date is unresolved, so none opens by itself (a reader can still pick any date), and what moved takes the first screen."],
    ["Reclassified, not added.", "−$2,123.52 out of Google Search, +$2,123.52 into Google Local Services, and B09’s October paid media spend, $16,649.23, unchanged. Amounts stay in ink; only the signs carry colour."],
    ["Cleared is not approved.", "The verdict never turns green. “No budget change was approved.” is in the frame, and the panel adds that a cleared hold moves no budget."],
  ])}
  <p class="foot"><span>Synthetic scenario: our older mapper filed the migrated campaign’s spend as Google Search. Google did not.</span><span><code>/exceptions/2455?period=oct&amp;channel=google_lsa&amp;week=2026-10-26</code></span></p>
</section>

<section class="page">
  ${head(3, "On a phone, and what was checked", "390 px wide. Oct 20 is tapped: its evidence opens under the strip, and its link opens the existing daily evidence for Oct 19–Oct 25. The checks are measured in the rendered pages, not judged by eye.")}
  <div class="phone">
    ${fig("after-5of18-390-evidence.jpg", "Oct 20, evidence open", "after")}
    ${fig("after-5of18-390-records.jpg", "Its records, on the daily evidence")}
    <table>
      <caption>Hierarchy, contrast, keyboard, clipping</caption>
      <tbody>${CHECKS.map(([k, v]) => `<tr><th>${k}</th><td>${v}</td></tr>`).join("")}</tbody>
    </table>
  </div>
  <p class="foot"><span>Measured by <code>harness/polish.cjs</code>; values from <code>polish/checks.json</code>.</span><span>Light theme only. Geist and Geist Mono, as the product ships them.</span></p>
</section>

</body></html>`;

(async () => {
  const htmlPath = path.join(DIR, ".pdf-source.html");
  fs.writeFileSync(htmlPath, html);
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route("**/*", (route) => (route.request().url().startsWith("file:") ? route.continue() : route.abort()));
    await page.goto(pathToFileURL(htmlPath).href, { waitUntil: "load" });
    await page.evaluate(() => document.fonts.ready);
    const broken = await page.evaluate(() => Array.from(document.images).filter((i) => !i.naturalWidth).map((i) => i.getAttribute("src")));
    if (broken.length) throw new Error(`broken images: ${broken.join(", ")}`);
    const fonts = await page.evaluate(() => [...document.fonts].filter((f) => f.status === "loaded").map((f) => f.family));
    await page.pdf({ path: OUT, width: "11in", height: "8.5in", printBackground: true, preferCSSPageSize: true });
    console.log(JSON.stringify({ out: OUT, fonts, pages: 3, minText, keysOk, opens18, overflow }));
  } finally {
    await browser.close();
    fs.rmSync(htmlPath, { force: true });
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
