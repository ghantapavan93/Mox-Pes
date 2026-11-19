// The prototype walkthrough for the VPs: about two and a half minutes, captioned so it works without
// audio, recorded as the public-demo guest. A title card in the candidate's words, then the product
// the way a reviewer would test it: what it is, the held decision (stop the line), one incident's root
// cause and verified repair, who approved what, the investigator, the reviewer's own file moving
// their own dashboard, a configuration change checked before it lands, how it is built, and a closing
// card with the link.
//
// Frames are captured only once a page is ready and piped as JPEGs to ffmpeg (H.264 MP4), so no
// loading wait is in the video. Read-only apart from the visitor's own question and upload, both
// deleted at the end.
//
//   node record-vp-walkthrough.cjs <baseUrl> <out.mp4> <node_modules dir> <ffmpeg.exe>
const path = require("node:path");
const { spawn } = require("node:child_process");

const [, , baseUrl, outFile, modulesDir, ffmpegExe] = process.argv;
const { chromium } = require(path.join(modulesDir, "playwright"));

const FPS = 15;
const VIEWPORT = { width: 1280, height: 800 };
const SCALE = 1.5; // 1920x1200 frames: body text stays legible at full size
const QUESTION = "Why did B20's CAC jump in October?";
const SITE = baseUrl.replace(/^https?:\/\//, "");

const CAPTION_CSS = `
  #rso-caption-wrap { position: fixed; left: var(--rso-left, 0px); right: 0; bottom: 24px; z-index: 2147483647;
    display: flex; justify-content: center; padding: 0 28px; pointer-events: none; }
  #rso-caption { max-width: 1000px; box-sizing: border-box; padding: 14px 24px; border-radius: 12px;
    background: rgba(15, 23, 42, 0.95); color: #fff; box-shadow: 0 10px 30px rgba(15, 23, 42, 0.35);
    font: 600 23px/1.38 Inter, ui-sans-serif, system-ui, sans-serif; letter-spacing: -0.005em;
    text-align: center; text-wrap: balance; }
  #rso-caption .rso-kicker { display: block; font-size: 15px; font-weight: 600; letter-spacing: 0.06em;
    text-transform: uppercase; color: #93c5fd; margin-bottom: 4px; }
  .rso-focus { outline: 3px solid #f59e0b !important; outline-offset: 5px !important; border-radius: 6px; }
`;

/** A full-frame card in the product's own look: the opening and the closing. */
const card = (kicker, title, lines, foot) => `<!doctype html><html><head><meta charset="utf-8"><style>
  html,body{margin:0;height:100%;background:#0f172a;font-family:Inter,ui-sans-serif,system-ui,sans-serif;color:#e2e8f0}
  .wrap{height:100%;display:flex;flex-direction:column;justify-content:center;padding:0 110px;box-sizing:border-box}
  .logo{display:flex;align-items:center;gap:14px;margin-bottom:34px}
  .mark{width:44px;height:44px;border-radius:10px;background:#2563eb;color:#fff;font-weight:700;font-size:17px;display:grid;place-items:center}
  .name{font-weight:600;font-size:22px;color:#fff}
  .kicker{font-size:15px;font-weight:600;letter-spacing:.08em;text-transform:uppercase;color:#93c5fd;margin-bottom:12px}
  h1{font-size:44px;line-height:1.15;margin:0 0 22px;color:#fff;letter-spacing:-.02em;max-width:980px}
  p{font-size:23px;line-height:1.5;margin:0 0 10px;color:#cbd5e1;max-width:980px}
  .foot{margin-top:34px;font-size:17px;color:#94a3b8}
  .link{color:#93c5fd;font-weight:600}
</style></head><body><div class="wrap">
  <div class="logo"><div class="mark">RS</div><div class="name">Revenue Signal OS</div></div>
  <div class="kicker">${kicker}</div><h1>${title}</h1>${lines.map((l) => `<p>${l}</p>`).join("")}
  <div class="foot">${foot}</div></div></body></html>`;

(async () => {
  const ff = spawn(
    ffmpegExe,
    ["-hide_banner", "-loglevel", "error", "-y", "-f", "image2pipe", "-c:v", "mjpeg", "-framerate", String(FPS), "-i", "pipe:0",
      // JPEG frames are full-range; players expect limited-range yuv420p (Safari and iOS show yuvj420p
      // with crushed contrast), so the range is converted, not just relabelled.
      "-an", "-vf", "scale=in_range=pc:out_range=tv,format=yuv420p", "-color_range", "tv", "-c:v", "libx264", "-preset", "slow", "-crf", "20", "-movflags", "+faststart", outFile],
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
  const at = (p) => `${baseUrl}${p}`;

  // Warm every page once, unrecorded: no loading frame reaches the video.
  for (const p of ["/start", "/?period=oct", "/decisions?branch=B09&period=oct", "/exceptions/1063", "/investigator", "/onboarding", "/changes"]) {
    await page.goto(at(p), { waitUntil: "networkidle" });
  }

  const ready = async () => {
    await page.waitForLoadState("networkidle");
    await page.evaluate(() => document.fonts.ready);
    await page.addStyleTag({ content: CAPTION_CSS });
    await page.waitForTimeout(300);
  };
  const shot = () => page.screenshot({ type: "jpeg", quality: 93 });
  const hold = async (seconds) => write(await shot(), Math.round(seconds * FPS));
  const caption = (text, kicker = "") =>
    page.evaluate(
      ([t, k]) => {
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
        el.innerHTML = "";
        if (k) {
          const s = document.createElement("span");
          s.className = "rso-kicker";
          s.textContent = k;
          el.appendChild(s);
        }
        el.appendChild(document.createTextNode(t));
      },
      [text, kicker],
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
  const scene = async (p) => {
    await page.goto(at(p), { waitUntil: "networkidle" });
    await ready();
  };

  // 0. The opening card, in the candidate's words.
  await page.setContent(
    card(
      "Built before the interview",
      "A working prototype of what I would build for your marketing and data teams.",
      [
        "It makes sure ad spend, call tracking and CRM records agree before anyone moves marketing budget.",
        "About two minutes. Then try it yourself: the link is at the end.",
      ],
      "Pavankalyan Ghanta · independent prototype · all data is synthetic",
    ),
  );
  await page.waitForTimeout(400);
  await hold(6);

  // 1. What it is: the Start page.
  await scene("/start");
  await focus(page.getByTestId("start-summary"));
  await caption("When the systems disagree, it holds the decision, shows the evidence, and sends the fix through a test run and a separate approval.", "What it does");
  await hold(6.5);

  // 2. The dashboard: where the conversions went.
  await scene("/?period=oct");
  const bridge = page.locator("main p", { hasText: "Ad platforms claimed" }).first();
  await focus(bridge);
  await caption("Ad platforms claimed 7,776 conversions in October. 4,753 paid prospects reached the business, and 1,386 are serviced customers so far.", "The dashboard");
  await hold(7);
  const holds = page.getByTestId("decision-holds").filter({ visible: true }).first();
  await focus(null);
  await glide(holds, 150, 1);
  await focus(holds);
  await caption("Where the records disagree, it stops the line: two branches' budget decisions are on hold.", "Stop the line");
  await hold(5.5);

  // 3. Decision Lab: the hold, and what holds it.
  await scene("/decisions?branch=B09&period=oct");
  const readiness = page.getByTestId("readiness-summary");
  await page.evaluate((y) => window.scrollTo(0, y), await readiness.evaluate((el) => Math.max(0, el.getBoundingClientRect().top + window.scrollY - 170)));
  await focus(readiness);
  await caption("B09 is held until the incident behind it is resolved: no channel comparison is a safe basis for moving budget yet.", "Decision Lab");
  await hold(6.5);

  // 4. One incident, root cause to verified repair.
  await scene("/exceptions/1063");
  await focus(page.getByTestId("fix-result-cac"));
  await caption("B20's October cost per paid customer was reported at $490.11. A verified repair corrected it to $271.31.", "Root cause and repair");
  await hold(6.5);
  await focus(null);
  const evidence = page.locator("#evidence");
  await glide(evidence, 96, 1.2);
  await focus(evidence.locator("dl").first());
  await caption("The cause: the call feed renamed a field. 119 calls failed validation and were held, not guessed.", "Root cause and repair");
  await hold(6);
  await focus(null);
  await glide(page.locator("h1").first(), 120, 1.2);
  await focus(page.getByTestId("fix-result-unchanged"));
  await caption("Replayed through the corrected mapper: the same $15,193.47 of spend and the same 109 customers. Only the attribution moved.", "Root cause and repair");
  await hold(6.5);
  await focus(null);
  const audit = page.getByTestId("case-audit");
  await glide(audit, 130, 1.4);
  await focus(audit);
  await caption("One role proposed it, another tested it in a dry run that saved nothing, and a different role approved it. Every step is audited.", "Safe changes");
  await hold(6.5);

  // 5. The investigator.
  await scene("/investigator");
  const box = page.getByLabel("Question");
  await box.click();
  await caption("Ask why a number moved.", "AI investigator");
  await hold(0.6);
  for (const ch of QUESTION) {
    await box.pressSequentially(ch);
    await write(await shot(), 1);
  }
  await hold(0.5);
  await box.press("Control+Enter");
  await page.waitForURL(/\/investigator\/\d+$/, { timeout: 90_000 });
  await page.getByTestId("findings").waitFor({ state: "visible" });
  const investigation = page.url();
  await ready();
  const findings = page.getByTestId("findings");
  await page.evaluate((y) => window.scrollTo(0, y), await findings.evaluate((el) => el.getBoundingClientRect().top + window.scrollY - 150));
  await focus(findings.locator("p").first());
  await caption("It answers from stored records with read-only tools, and every finding cites the record it rests on.", "AI investigator");
  await hold(6.5);

  // 6. The reviewer's own file, on the reviewer's own dashboard.
  await scene("/onboarding");
  const sample = page.getByRole("button", { name: /Calls the feed missed/ });
  await focus(sample);
  await caption("Now your own data. Upload an export, or this sample: calls a feed never delivered for B01's customers.", "Your data");
  await hold(5.5);
  await sample.click();
  await page.waitForURL(/\/onboarding\/\d+$/, { timeout: 60_000 });
  const upload = page.url();
  await page.getByTestId("propose-and-dry-run").waitFor({ timeout: 60_000 });
  const questions = page.getByTestId("mapping-questions");
  await questions.getByLabel("month first (March 4)").check();
  await questions.getByText(/branch local time/).first().click();
  await page.getByTestId("propose-and-dry-run").click();
  await page.getByTestId("upload-result").waitFor({ timeout: 90_000 });
  await ready();
  const result = page.getByTestId("upload-result");
  await page.evaluate((y) => window.scrollTo(0, y), await result.evaluate((el) => Math.max(0, el.getBoundingClientRect().top + window.scrollY - 90)));
  await focus(page.getByTestId("count-privately"));
  await caption("Every row is checked with the rules the live feed uses. Then count it in a private copy.", "Your data");
  await hold(5.5);
  await page.getByTestId("count-privately").click();
  await page.waitForURL(/\/onboarding\/\d+\/dashboard$/, { timeout: 90_000 });
  await page.getByTestId("your-headline").waitFor();
  await ready();
  await focus(page.getByTestId("your-headline"));
  await caption("Your dashboard moves with your file: B01's cost per paid customer, $392.50 to $322.73. Nobody else's numbers change.", "Your dashboard");
  await hold(7);
  await focus(null);
  const tiles = page.getByTestId("your-tiles");
  await glide(tiles, 110, 1);
  await focus(tiles);
  await caption("Counted through the real intake and reconciliation, in a transaction that is rolled back. Spend did not change; attribution did.", "Your dashboard");
  await hold(6.5);

  // 7. A configuration change, checked before it lands (shown when the hosted copy has one).
  await scene("/changes");
  const changeRow = page.locator("main tbody tr").first();
  if (await changeRow.count()) {
    await focus(changeRow);
    await caption("Configuration changes are run through the production write path in a rolled-back transaction, then approved by someone else.", "ChangeGuard");
    await hold(6);
  }

  // 8. How it is built.
  await scene("/start");
  const built = page.getByTestId("start-built");
  await glide(built, 120, 1.2);
  await focus(built);
  await caption("Next.js and Postgres. Every source lands once per version, every metric is defined once in SQL, and over a thousand tests run before each release.", "How it is built");
  await hold(7);

  // 9. The closing card.
  await page.setContent(
    card(
      "Thank you",
      "Rather than only describe how I would contribute, I built it first.",
      [
        `Try it: <span class="link">${SITE}/start</span>`,
        "Take the two-minute tour, ask the investigator, and count a file of your own.",
      ],
      "Pavankalyan Ghanta · independent prototype, not affiliated with any company · all data is synthetic",
    ),
  );
  await page.waitForTimeout(400);
  await hold(7);

  ff.stdin.end();
  await done;

  // The visitor's question and upload are theirs to delete; delete both so nothing is left behind.
  await page.goto(investigation, { waitUntil: "networkidle" });
  await page.getByRole("button", { name: "Delete it now" }).first().click();
  await page.waitForURL(/\/investigator$/, { timeout: 30_000 });
  await page.goto(upload, { waitUntil: "networkidle" });
  await page.getByTestId("delete-now").first().click();
  await page.waitForURL(/\/onboarding\?deleted=1$/, { timeout: 30_000 });
  await browser.close();
  console.log(`${outFile}: ${frames} frames, ${(frames / FPS).toFixed(1)} s; the question and the upload were deleted`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
