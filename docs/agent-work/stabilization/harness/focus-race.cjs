// Repeat the drift review's refused save against the real build and count where focus lands.
//   node C:/Temp/stab/focus-race.cjs <baseURL> <exceptionId> <iterations> <cpuThrottle> <out.jsonl>
// The 409 comes from a route handler (the server's own conflict body shape), so the case's stored
// state never changes; everything after it (setConflict, router.replace, the rAF) is the shipped
// component on the shipped build. Diagnostics: C:/Temp/stab/diag-init.js.
const { createRequire } = require("node:module");
const fs = require("node:fs");
const req = createRequire("C:/Temp/rso-rc/package.json");
const { chromium } = req("@playwright/test");

const [baseURL, exceptionId, iterationsArg, throttleArg, outPath] = process.argv.slice(2);
const iterations = Number(iterationsArg);
const throttle = Number(throttleArg);
const diag = fs.readFileSync("C:/Temp/stab/diag-init.js", "utf8");
const conflictBody = JSON.stringify({
  error: "New evidence arrived while you were reviewing: check #5 found a contradiction that check #4 did not show. Nothing was saved; your note is kept. Read the new evidence, then save again.",
  conflict: { latestRunId: 5, reviewedRunId: 4, newFacts: 1 },
});

(async () => {
  for (let tries = 0; ; tries++) {
    try {
      const r = await fetch(`${baseURL}/api/health`).catch(() => fetch(baseURL));
      if (r) break;
    } catch {
      if (tries > 120) throw new Error("server never answered");
      await new Promise((r) => setTimeout(r, 1000));
    }
  }
  const browser = await chromium.launch();
  const out = fs.createWriteStream(outPath, { flags: "a" });
  let missed = 0;
  for (let i = 1; i <= iterations; i++) {
    const context = await browser.newContext({ baseURL, viewport: { width: 1440, height: 900 } });
    await context.addInitScript({ content: diag });
    const page = await context.newPage();
    if (throttle > 1) {
      const cdp = await context.newCDPSession(page);
      await cdp.send("Emulation.setCPUThrottlingRate", { rate: throttle });
    }
    const lines = [];
    page.on("console", (m) => {
      if (m.text().startsWith("[diag]")) lines.push(m.text());
    });
    await page.request.post("/api/role", { data: { role: "marketing" } });
    await page.route("**/api/exceptions/*/review", (route) =>
      route.fulfill({ status: 409, contentType: "application/json", body: conflictBody }),
    );
    await page.goto(`/exceptions/${exceptionId}`);
    await page.getByTestId("record-decision").filter({ visible: true }).click();
    const form = page.getByRole("form", { name: "Record a decision" });
    await form.getByTestId("decision-rationale").fill("Both tracking numbers moved at the vendor; reviewed with the change log.");
    await form.getByTestId("save-decision").click();
    await page.getByTestId("stale-conflict").filter({ visible: true }).waitFor();
    // A measurement pause, not a test wait: let any pending frame, effect or refresh settle.
    await page.waitForTimeout(600);
    const focused = await page.evaluate(() => {
      const a = document.activeElement;
      return a ? (a.getAttribute("data-testid") || a.tagName.toLowerCase()) : null;
    });
    const rafLines = lines.filter((l) => l.includes("rAF#2") || l.includes("stale-conflict") || l.includes("fetch done"));
    const ranBeforeNotice = lines.some((l) => /rAF#2 runs conflict in DOM: false/.test(l));
    const ok = focused === "stale-conflict";
    if (!ok) missed++;
    out.write(JSON.stringify({ i, throttle, focused, ok, ranBeforeNotice, lines: rafLines }) + "\n");
    process.stdout.write(ok ? "." : ranBeforeNotice ? "R" : "X");
    await context.close();
  }
  out.end();
  await browser.close();
  console.log(`\nthrottle ${throttle}: ${missed} of ${iterations} missed focus`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
