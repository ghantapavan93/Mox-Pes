// The B20 receipt walkthrough: 40-60 seconds, captioned so it works without audio, recorded as the
// public-demo guest. It starts on the receipt, shows the held-call evidence, returns to what did not
// change, asks the investigator, and ends on Decision Lab.
//
// Frames are captured only once a page is ready and piped as JPEGs to Playwright's ffmpeg (VP8
// WebM), so no loading wait is in the video. Read-only apart from the visitor's own question, which
// is deleted at the end. The investigation's id is never on screen.
//
//   node record-b20-receipt.cjs <baseUrl> <out.webm> <node_modules dir> <ffmpeg.exe> [incidentId]
const path = require("node:path");
const { spawn } = require("node:child_process");

const [, , baseUrl, outFile, modulesDir, ffmpegExe, incidentId = "1063"] = process.argv;
const { chromium } = require(path.join(modulesDir, "playwright"));

const FPS = 15;
const VIEWPORT = { width: 1280, height: 800 };
const SCALE = 1.5; // 1920x1200 frames: body text stays legible at full size
const QUESTION = "Why did B20's CAC jump in October?";

// The caption sits over the content column, centred there, so the sidebar's "all data synthetic"
// notice is never covered.
const CAPTION_CSS = `
  #rso-caption-wrap { position: fixed; left: var(--rso-left, 0px); right: 0; bottom: 24px; z-index: 2147483647;
    display: flex; justify-content: center; padding: 0 28px; pointer-events: none; }
  #rso-caption { max-width: 980px; box-sizing: border-box; padding: 14px 24px; border-radius: 12px;
    background: rgba(15, 23, 42, 0.95); color: #fff; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.35);
    font: 600 23px/1.38 Inter, ui-sans-serif, system-ui, sans-serif; letter-spacing: -0.005em;
    text-align: center; text-wrap: balance; }
  #rso-caption.rso-final { font-size: 30px; padding: 18px 30px; }
  .rso-focus { outline: 3px solid #f59e0b !important; outline-offset: 5px !important; border-radius: 6px; }
`;

(async () => {
  const ff = spawn(
    ffmpegExe,
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(FPS), "-i", "pipe:0",
      "-an", "-c:v", "libvpx", "-qmin", "0", "-qmax", "28", "-crf", "6", "-b:v", "5M", "-deadline", "good", "-cpu-used", "1", "-threads", "4", outFile],
    { stdio: ["pipe", "inherit", "inherit"] },
  );
  const done = new Promise((resolve, reject) => ff.on("close", (code) => (code === 0 ? resolve() : reject(new Error(`ffmpeg exited ${code}`)))));
  let frames = 0;
  const write = async (buf, n) => {
    for (let i = 0; i < n; i += 1) {
      frames += 1;
      if (!ff.stdin.write(buf)) await new Promise((r) => ff.stdin.once("drain", r));
    }
  };

  const browser = await chromium.launch();
  const context = await browser.newContext({ viewport: VIEWPORT, deviceScaleFactor: SCALE, reducedMotion: "reduce" });
  const page = await context.newPage();

  const receipt = `${baseUrl}/exceptions/${incidentId}`;
  const decisions = `${baseUrl}/decisions?branch=B20&period=oct`;
  // Warm every page once, unrecorded: no loading frame reaches the video.
  for (const url of [receipt, decisions, `${baseUrl}/investigator`]) {
    await page.goto(url, { waitUntil: "networkidle" });
  }

  const ready = async () => {
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: CAPTION_CSS });
    await page.waitForTimeout(300);
  };
  const shot = () => page.screenshot({ type: "jpeg", quality: 93 });
  const hold = async (seconds) => write(await shot(), Math.round(seconds * FPS));
  const caption = (text, final = false) =>
    page.evaluate(
      ([t, f]) => {
        let el = document.getElementById("rso-caption");
        if (!el) {
          const wrap = document.createElement("div");
          wrap.id = "rso-caption-wrap";
          wrap.setAttribute("aria-hidden", "true");
          el = document.createElement("div");
          el.id = "rso-caption";
          wrap.appendChild(el);
          document.body.appendChild(wrap);
        }
        const main = document.querySelector("main");
        document.documentElement.style.setProperty("--rso-left", `${main ? Math.round(main.getBoundingClientRect().left) : 0}px`);
        el.textContent = t;
        el.className = f ? "rso-final" : "";
      },
      [text, final],
    );
  const focus = (locator) =>
    page.evaluate(() => document.querySelectorAll(".rso-focus").forEach((el) => el.classList.remove("rso-focus"))).then(async () => {
      if (locator) await locator.evaluateAll((els) => els.forEach((el) => el.classList.add("rso-focus")));
    });
  /** Scrolls so `locator`'s top sits `offset` px below the viewport top, over `seconds`, one frame per step. */
  const glide = async (locator, offset, seconds) => {
    const target = await locator.evaluate((el, off) => Math.max(0, el.getBoundingClientRect().top + window.scrollY - off), offset);
    const from = await page.evaluate(() => window.scrollY);
    const steps = Math.max(1, Math.round(seconds * FPS));
    for (let i = 1; i <= steps; i += 1) {
      const t = i / steps;
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      await page.evaluate((y) => window.scrollTo(0, y), Math.round(from + (target - from) * eased));
      await write(await shot(), 1);
    }
  };

  // 1. The receipt, first frame: October's paid CAC before and after the repair.
  await page.goto(receipt, { waitUntil: "networkidle" });
  await ready();
  const fix = page.getByTestId("fix-result");
  await fix.waitFor({ state: "visible" });
  await focus(page.getByTestId("fix-result-cac"));
  await caption("B20's October paid CAC was reported at $490.11. An approved, verified repair corrected it to $271.31.");
  await hold(7.5);

  // 2. Why: one spend, two denominators.
  await focus(page.locator("[data-testid=fix-result-arithmetic], [data-testid=fix-result-why]"));
  await caption("Same $15,193.47 of paid spend. While 119 call records were held, 25 paid customers had no paid touch on record: 31 before, 56 after.");
  await hold(8);

  // 3. The held-call evidence: what failed, then the records themselves.
  await focus(null);
  await caption("The evidence: 119 call records failed validation (MISSING_FIELD) and were held instead of guessed.");
  const evidenceCard = page.locator("#evidence");
  await glide(evidenceCard, 96, 1.2);
  await focus(evidenceCard.locator("dl, table").first());
  await hold(4.5);
  await caption("Replayed through calls@1.1, each held call attached to the customer it produced, with its paid source.");
  const records = page.locator("#records");
  await focus(null);
  await glide(records, 96, 1.4);
  // The first held call: now projected by calls@1.1, and the customer it attached to.
  const firstCall = records.locator("tbody tr").first().locator("td");
  await focus(firstCall.nth(2).locator(":scope > *").first().or(firstCall.nth(4).locator(":scope > div").first()));
  await hold(5);

  // 4. Back to what did not change.
  await focus(null);
  await glide(page.locator("h1").first(), 120, 1.4);
  await focus(page.getByTestId("fix-result-unchanged").locator("xpath=preceding-sibling::dt[1]").or(page.getByTestId("fix-result-unchanged")));
  await caption("Unchanged: the same $15,193.47 of paid spend and the same 109 serviced customers. Only attribution moved.");
  await hold(6.5);

  // 5. The investigator: asked by the guest, answered from the stored receipt and today's scorecard.
  await page.goto(`${baseUrl}/investigator`, { waitUntil: "networkidle" });
  await ready();
  const box = page.getByLabel("Question");
  await box.click();
  await caption("Ask the investigator the same question.");
  await hold(0.6);
  for (const ch of QUESTION) {
    await box.pressSequentially(ch);
    await write(await shot(), 1);
  }
  await hold(0.6);
  await box.press("Control+Enter");
  // The wait for the answer is not recorded.
  await page.waitForURL(/\/investigator\/\d+$/, { timeout: 90_000 });
  await page.getByTestId("findings").waitFor({ state: "visible" });
  const investigation = page.url();
  await ready();
  const findings = page.getByTestId("findings");
  // The breadcrumb (the visitor's investigation id) stays above the frame.
  await page.evaluate((y) => window.scrollTo(0, y), await findings.evaluate((el) => el.getBoundingClientRect().top + window.scrollY - 150));
  await focus(findings.locator("p").first());
  await caption("It answers from the stored receipt for what happened and from today's scorecard for now, and cites both.");
  await hold(6);
  // The recommended next action (the claim check repeats it, collapsed).
  const next = page.locator("dd", { hasText: "a verified repair is not permission to move budget" });
  await focus(next);
  await caption("Its next step: a verified repair is not permission to move budget.");
  await hold(4.5);

  // 6. Decision Lab: the budget decision is still its own.
  await page.goto(decisions, { waitUntil: "networkidle" });
  await ready();
  const summary = page.getByTestId("readiness-summary");
  await summary.waitFor({ state: "visible" });
  await page.evaluate((y) => window.scrollTo(0, y), await summary.evaluate((el) => Math.max(0, el.getBoundingClientRect().top + window.scrollY - 160)));
  await focus(summary);
  await caption("Correction verified. Budget move not approved.", true);
  await hold(6);

  ff.stdin.end();
  await done;
  // The visitor's question is theirs to delete; delete it so nothing is left behind.
  await page.goto(investigation, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Delete it now" }).first().click();
  await page.waitForURL(/\/investigator$/, { timeout: 30_000 });
  await browser.close();
  console.log(`${outFile}: ${frames} frames, ${(frames / FPS).toFixed(1)} s; the question was deleted`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
