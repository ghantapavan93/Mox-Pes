import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { expect, test, type Browser, type Page } from "@playwright/test";
import type { Pool } from "pg";
import { createPool } from "@/lib/db";
import { setRole, type Role } from "../../e2e/action-center";
import { deliver, type Delivery, type Step } from "./deliveries";
import { acceptanceDatabaseName, acceptanceDatabaseUrl, acceptanceOut, acceptancePort, REPO } from "./env";
import { expectedOutcomes, ledgerChecks, worldFacts, type Check, type States, type WorldFacts } from "./ledger";

/**
 * The B09 acceptance proof (docs/agent-work/B09-ACCEPTANCE-RUNNER.md). `npm run acceptance:b09`
 * seeds its own database, builds this checkout and starts its own server, then this walks:
 *
 *   missing → partial (the decision still held) → verified (reclassified, not added)
 *   → a duplicate and two stale replays change nothing → the independent ledger
 *   → scope: every request a restricted role is denied is paired with the analyst's allowed
 *     request for the same resource; routes that carry no evidence for either are counted apart.
 *
 * One test in steps, because each stage builds on the deliveries before it. Every check is
 * recorded and soft-asserted, so one failure still leaves a complete record:
 * <ACCEPTANCE_OUT>/results.json, with the commit, the build, the command and each result.
 */

const golden = JSON.parse(readFileSync(path.join(REPO, "tests/fixtures/b09-golden.json"), "utf8")) as { summaryContains: string };
const WEEK = "2026-10-26";
const CTX = `period=oct&channel=google_lsa&week=${WEEK}`;
const BASE = `http://localhost:${acceptancePort()}`;
const STEPS: Step[] = ["partial", "rest", "duplicate", "older", "stale"];

const checks: Check[] = [];
const errors: Array<{ stage: string; url: string; text: string }> = [];
const deliveries = {} as Record<Step, Delivery>;
const facts = {} as Record<States, WorldFacts>;
let stage = "setup";

function check(name: string, ok: boolean, detail: unknown = "") {
  const d = (typeof detail === "string" ? detail : JSON.stringify(detail)).replace(/\s+/g, " ").slice(0, 600);
  checks.push({ stage, name, ok, detail: d });
  expect.soft(ok, `${stage} · ${name} :: ${d}`).toBe(true);
}

const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);
const visible = (page: Page, selector: string) => page.locator(selector).filter({ visible: true }).first();
const textOf = async (page: Page, selector: string) => (await visible(page, selector).innerText()).replace(/\s+/g, " ").trim();

function watch(page: Page) {
  page.on("console", (m) => {
    if (m.type() === "error") errors.push({ stage, url: page.url().replace(BASE, ""), text: m.text().slice(0, 400) });
  });
  page.on("pageerror", (e) => errors.push({ stage, url: page.url().replace(BASE, ""), text: `pageerror: ${String(e.message).slice(0, 400)}` }));
}

/** What each state must say on each view (B09-CROSS-VIEW.md), as the release walkthrough checked it. */
function expected(gap: number) {
  return {
    missing: {
      overview: ["Decision held. None of the 18 dates in the decision window (Oct 13–Oct 30) has Google Local Services spend at B09."],
      window: "None of the 18 dates in the decision window (Oct 13–Oct 30) has Google Local Services spend, this week's included. The decision stays held.",
      trace: "No day of this week has a spend record for Google Local Services at B09. That is no record, not $0.",
      incident: [
        "Decision held: none of the 18 dates in the decision window (Oct 13–Oct 30) has Google Local Services spend at B09.",
        "Since Oct 13, $2,123.52 has been spent under pmax-lsa-B09, which is filed as Google Search; none of it is filed as Google Local Services.",
      ],
      lab: ["Not ready", `Blocking incident #${gap}`],
    },
    partial: {
      overview: [
        "Google Local Services spend at B09 stopped after Oct 12; since then only Oct 26–Oct 30 have any.",
        "Decision still held. 5 of 18 dates in the decision window (Oct 13–Oct 30) have Google Local Services spend at B09; Oct 13–Oct 25 still have none.",
      ],
      window: "This week's dates in the decision window are covered, but the window (Oct 13–Oct 30) is not: Oct 13–Oct 25 still have no Google Local Services spend. The decision stays held.",
      trace: "All 5 days have a spend record: $597.17 in all.",
      incident: [
        "Decision still held: 5 of 18 dates in the decision window (Oct 13–Oct 30) have Google Local Services spend at B09; Oct 13–Oct 25 still have none.",
        "Originally $2,123.52 was filed as Google Search. Now $597.17 (Oct 26–Oct 30) is filed as Google Local Services; $1,526.35 (Oct 13–Oct 25) is still filed as Google Search.",
      ],
      lab: ["Not ready", "5 of 18 dates in the decision window (Oct 13–Oct 30) have Google Local Services spend at B09; Oct 13–Oct 25 still have none, so it still holds."],
    },
    verified: {
      overview: [
        "Coverage hold cleared. All 18 dates in the decision window (Oct 13–Oct 30) have Google Local Services spend at B09, verified",
        "Reclassified, not added: the $2,123.52 first filed as Google Search is now filed as Google Local Services.",
      ],
      window: "The decision window (Oct 13–Oct 30) has Google Local Services spend on all 18 dates, verified",
      trace: "All 5 days have a spend record: $597.17 in all.",
      incident: [
        "Coverage hold cleared: all 18 dates in the decision window (Oct 13–Oct 30) have Google Local Services spend at B09, verified",
        "Reclassified, not added: the $2,123.52 first filed as Google Search is now filed as Google Local Services.",
      ],
      lab: [
        "Ready for review",
        "Nothing here approves a budget change.",
        `Coverage hold cleared, incident #${gap}.`,
        "Reclassified, not added: the $2,123.52 first filed as Google Search is now filed as Google Local Services.",
        "Other checks need review: 2 of 4 channels.",
        "It is not an approval",
      ],
    },
  };
}

/** One state across the four views, as the analyst sees them. */
async function views(page: Page, gap: number, state: "missing" | "partial" | "verified") {
  const e = expected(gap)[state];
  await page.goto(`/?period=oct&branch=B09&channel=google_lsa&week=${WEEK}#movement`);
  await visible(page, '[data-testid="movement-selection"]').waitFor({ timeout: 60_000 });
  const overview = await textOf(page, '[data-testid="movement"]');
  for (const s of e.overview) check(`Overview says: ${s}`, overview.includes(s), overview);
  const windowNote = await textOf(page, '[data-testid="movement-window"]');
  check("Overview sets the selected week against the decision window", windowNote.startsWith(e.window), windowNote);

  await page.goto(`/branches/B09/trace?period=oct&metric=paid_spend&channel=google_lsa&week=${WEEK}`);
  await visible(page, '[data-testid="overview-selection"]').waitFor({ timeout: 60_000 });
  const summary = await textOf(page, '[data-testid="selection-summary"]');
  check(`daily evidence says: ${e.trace}`, summary === e.trace, summary);
  const days = await page.locator('[data-testid="overview-selection"]:visible tr[data-day]').evaluateAll((rows) => rows.map((r) => (r.textContent ?? "").replace(/\s+/g, " ").trim()));
  if (state === "missing") check("each missing day reads 'no spend record', never a recorded $0.00", days.length === 5 && days.every((t) => /no spend record/i.test(t) && !/\$0\.00/.test(t)), days);
  else check("each day of the week reads as recorded spend", days.length === 5 && days.every((t) => /\$\d/.test(t) && !/no spend record/i.test(t)), days);

  await page.goto(`/exceptions/${gap}?${CTX}#recovery`);
  await visible(page, '[data-testid="gap-recovery"]').waitFor({ timeout: 60_000 });
  check(`the incident's state is ${state}`, (await visible(page, '[data-testid="gap-recovery"]').getAttribute("data-state")) === state);
  const recovery = await textOf(page, "#recovery");
  for (const s of e.incident) check(`incident says: ${s}`, recovery.includes(s), recovery);
  // The incident's CRM card once said "recorded spend is zero" for missing spend (BIVE-ACCEPTANCE.md R2).
  // It streams in after the recovery panel: wait for it, or both checks below would read nothing.
  await visible(page, '[data-testid="crm-outcomes"]').waitFor({ timeout: 60_000 });
  const incidentText = await textOf(page, "main");
  const crm = incidentText.match(/Customers the CRM shows[^.]*\.\s*[^.]*\.(?:[^.]*\.)?/)?.[0] ?? "(no CRM card)";
  check("the incident never calls missing spend zero", !/spend is zero|zero spend|\$0 spend/i.test(incidentText), crm);
  if (state === "verified") check("the incident's CRM card says the spend is now re-filed and verified", crm.includes("That spend is now re-filed and verified"), crm);
  else check("the incident's CRM card says the channel has no spend record, not $0", crm.includes("has no spend record for some or all of those dates"), crm);

  await page.goto(`/decisions?branch=B09&${CTX}`);
  await visible(page, '[data-testid="readiness-summary"]').waitFor({ timeout: 60_000 });
  if (state === "verified") await visible(page, '[data-testid="readiness-other-checks"]').waitFor({ timeout: 60_000 });
  const lab = await textOf(page, '[data-testid="readiness-summary"]');
  for (const s of e.lab) check(`Decision Lab says: ${s}`, lab.includes(s), lab);
  if (state === "verified") {
    const badge = (await visible(page, '[data-testid="readiness-summary"]').locator("span", { hasText: /^Ready/ }).first().innerText()).trim();
    check("Decision Lab's badge says 'Ready for review', never a bare 'Ready'", badge === "Ready for review", badge);
    check("Decision Lab says nothing is approved", !/\bapproved\b/i.test(lab.replace("It is not an approval", "")), lab);
    const other = await textOf(page, '[data-testid="readiness-other-checks"]');
    check("Decision Lab names the two review items: #970 and the door-to-door conflicts", /#970/.test(other) && /has spend but no branch mapping/.test(other) && /door-to-door/i.test(other), other);
  }
}

/** A run's row on the ingestion pipeline, by column header (headers are CSS-uppercased: read textContent). */
async function runRow(page: Page, id: number): Promise<Record<string, string>> {
  await page.goto(`/integrations?view=pipeline&run=${id}#run-${id}`);
  const row = page.locator(`tr#run-${id}`);
  await row.waitFor({ timeout: 60_000 });
  const headers = (await page.locator(`table:has(tr#run-${id})`).first().locator("thead th").allTextContents()).map((h) => h.replace(/\s+/g, " ").trim());
  const cells = (await row.locator("td").allInnerTexts()).map((c) => c.replace(/\s+/g, " ").trim());
  return Object.fromEntries(headers.map((h, i) => [h, cells[i] ?? ""]));
}

/** Scope: the analyst's request for a resource, then each restricted role's, in fresh contexts. */
async function scope(browser: Browser, pool: Pool, gap: number, verificationRun: number) {
  const one = async (sql: string) => (await pool.query(sql)).rows[0] ?? {};
  const ids = {
    customer: String((await one("select c.crm_customer_id as id from crm_customers c join branches b on b.crm_office_id = c.office_id where b.id = 'B09' order by 1 limit 1")).id),
    rawEvent: String((await one("select id from raw_events where source = 'ads' and payload ->> 'campaignId' = 'pmax-lsa-B09' order by id desc limit 1")).id),
    change: String((await one("select id from config_changes order by id limit 1")).id ?? "1"),
    job: String((await one("select id from sync_jobs order by id limit 1")).id ?? "1"),
    connector: String((await one("select id from connectors order by id limit 1")).id ?? "1"),
    case: Number((await one(`select id from cases where exception_id = ${Number(gap)}`)).id),
  };
  const roles: Role[] = ["marketing", "partner", "brand"];
  const contexts = Object.fromEntries(
    await Promise.all(
      roles.map(async (role) => {
        const context = await browser.newContext({ baseURL: BASE });
        const page = await context.newPage();
        await setRole(page, role);
        return [role, { context, page }] as const;
      }),
    ),
  ) as Record<Role, { context: import("@playwright/test").BrowserContext; page: Page }>;

  // The analyst records two answer checks through the product's API: one about B09, one about the Moxie brand.
  const answer = async (text: string) => {
    const res = await contexts.marketing.page.request.post("/api/shadow", { data: { kind: "answer", input: { system: "Atlas BI (synthetic)", asOf: "2026-10-31T14:00:00.000Z", question: "", answer: text } } });
    return Number(((await res.json()) as { check?: { id: number } }).check?.id);
  };
  const shadow = [await answer("B09's paid spend was $16,649.23 in October."), await answer("Moxie Pest Control paid CAC was $250.00 in October.")];

  /** B09 evidence: names, campaign ids, amounts and links only a viewer of B09, or of its brand, may receive. */
  const markers = ["pmax-lsa-B09", "lsa-B09", "B09 Coral", "at B09", "$597.17", "$1,526.35", "$2,123.52", "$16,649.23", `/exceptions/${gap}`, `#${gap}`, `Case #${ids.case}`, "Moxie Pest Control paid CAC"];
  /**
   * The B09 resources the proof must show the analyst receiving, so that refusing them is a real
   * refusal: the incident, the daily evidence, Decision Lab, the verification's run, the trace API
   * (its lines name the source records) and both answer checks. The trace API takes `branch`; the
   * `branchId` variant in the route list answers 404 to everyone and proves nothing.
   */
  const core = [
    `/exceptions/${gap}?period=oct`,
    `/branches/B09/trace?period=oct&metric=paid_spend&channel=google_lsa&week=${WEEK}`,
    "/decisions?branch=B09&period=oct",
    `/integrations?view=pipeline&run=${verificationRun}`,
    "/api/metrics/trace?branch=B09&period=oct&metric=paid_spend",
    `/api/shadow/${shadow[0]}`,
    `/api/shadow/${shadow[1]}`,
  ];
  const routes = [
    // pages
    "/", `/?period=oct&branch=B09&channel=google_lsa&week=${WEEK}`, "/assurance", ...shadow.map((id) => `/assurance/${id}`), "/audit", `/audit?subject=case:${ids.case}`,
    "/branches/B09", `/branches/B09/trace?period=oct&metric=paid_spend&channel=google_lsa&week=${WEEK}`, "/changes", `/changes/${ids.change}`,
    "/customers", "/customers?branch=B09", `/customers/${ids.customer}`, "/decisions", "/decisions?branch=B09&period=oct", "/decisions/opportunities",
    "/definitions", "/demo", "/exceptions", "/exceptions?owner=engineer&state=all", "/exceptions?branch=B09&state=all", `/exceptions/${gap}`, `/exceptions/${gap}?period=oct`,
    "/feedback", "/integrations", `/integrations?view=pipeline&run=${verificationRun}`, `/integrations/jobs/${ids.job}`, "/investigator", "/onboarding",
    // read APIs
    "/api/shadow", ...shadow.map((id) => `/api/shadow/${id}`), "/api/changes", `/api/changes/${ids.change}`, `/api/changes/${ids.change}/rollout`,
    `/api/connectors/${ids.connector}/compare`, `/api/connectors/${ids.connector}/jobs`, "/api/connectors/faults", `/api/connectors/jobs/${ids.job}`,
    "/api/currency-rules", "/api/customers?branch=B09", "/api/customers", `/api/customers/${ids.customer}`, `/api/customers/${ids.customer}/raw-events/${ids.rawEvent}`,
    "/api/decisions/experiments", "/api/decisions/scenarios", "/api/decisions/verdicts?branch=B09&period=oct", "/api/decisions/verdicts?branchId=B09&period=oct",
    "/api/identity/conflicts", "/api/inquiries", "/api/investigations", "/api/metrics?branch=B09&period=oct", "/api/metrics?period=oct",
    "/api/metrics/trace?branch=B09&period=oct&metric=paid_spend", "/api/metrics/trace?branchId=B09&period=oct&metric=paid_spend", "/api/opportunities",
    "/api/search?q=B09", "/api/search?q=Coral", `/api/search?q=${gap}`, "/api/onboarding/uploads",
  ];
  type Got = { role: Role; status: number; evidence: string[] };
  const get = async (role: Role, url: string): Promise<Got> => {
    const res = await contexts[role].page.request.get(url, { maxRedirects: 0 });
    const body = await res.text();
    return { role, status: res.status(), evidence: markers.filter((m) => body.includes(m)) };
  };
  const pairs: Array<{ route: string; allowed: Got; denied: Got[]; proves: boolean }> = [];
  for (const route of routes) {
    const allowed = await get("marketing", route);
    const denied = [await get("partner", route), await get("brand", route)];
    pairs.push({ route, allowed, denied, proves: allowed.evidence.length > 0 });
  }
  for (const { context } of Object.values(contexts)) await context.close();

  const proving = pairs.filter((p) => p.proves);
  const vacuous = pairs.filter((p) => !p.proves && p.denied.every((d) => d.evidence.length === 0));
  const leaks = pairs.flatMap((p) => p.denied.filter((d) => d.evidence.length > 0).map((d) => ({ route: p.route, role: d.role, status: d.status, evidence: d.evidence })));
  check(`the analyst receives B09 evidence on every core resource (${core.length})`, core.every((c) => pairs.find((p) => p.route === c)?.proves), core.filter((c) => !pairs.find((p) => p.route === c)?.proves));
  check(`every denied request on a route that carries B09 evidence for the analyst is paired with that allowed request and received none: ${proving.length} routes, ${proving.length * 2} pairs`, proving.every((p) => p.denied.every((d) => d.evidence.length === 0)), leaks.filter((l) => proving.some((p) => p.route === l.route)));
  check(`routes with no B09 evidence for either role are counted apart, never as refusals: ${vacuous.length} of ${pairs.length}`, vacuous.length + proving.length + new Set(leaks.map((l) => l.route)).size >= pairs.length, vacuous.map((p) => p.route));
  check("no restricted request on any route received B09 evidence", leaks.length === 0, leaks);
  return {
    ids,
    answerChecks: shadow,
    markers,
    routes: pairs.length,
    allowedRole: "marketing",
    deniedRoles: ["partner", "brand"],
    provingRoutes: proving.length,
    pairedDeniedRequests: proving.length * 2,
    routesWithNoEvidenceForEitherRole: vacuous.length,
    leaks,
    pairs,
  };
}

test("B09 acceptance: missing → partial hold → verified reclassification, replays, ledger, scope", async ({ page, browser }) => {
  test.setTimeout(30 * 60_000);
  const started = new Date().toISOString();
  const pool = createPool(acceptanceDatabaseUrl());
  let ledger: Awaited<ReturnType<typeof ledgerChecks>> | null = null;
  let scoped: Awaited<ReturnType<typeof scope>> | null = null;
  let gap = 0;
  try {
    watch(page);
    await setRole(page, "marketing");

    await test.step("missing: the decision is held, and no record is not $0", async () => {
      stage = "missing";
      const gaps = (await pool.query("select id from exceptions where kind = 'channel_coverage_gap' and status = 'open' and branch_id = 'B09'")).rows;
      const corrections = Number((await pool.query("select count(*)::int as n from raw_events where source = 'ads' and payload ->> 'campaignId' = 'pmax-lsa-B09' and payload ->> 'fetchedAt' >= '2026-10-31T13:00:00Z'")).rows[0].n);
      check("a freshly seeded world: one open coverage gap at B09, and no correction delivered yet", gaps.length === 1 && corrections === 0, { gaps, corrections });
      gap = Number(gaps[0]?.id);
      facts.missing = await worldFacts(pool, gap);
      await page.goto("/?period=oct");
      const hold = visible(page, '[data-testid="decision-holds"]').locator("li", { hasText: golden.summaryContains });
      await hold.first().waitFor({ timeout: 60_000 });
      check("the Overview, opened with no ids, lists B09's hold (tests/fixtures/b09-golden.json)", (await hold.count()) === 1, await hold.first().innerText());
      await views(page, gap, "missing");
    });

    await test.step("partial: 5 of 18 dates, the decision still held", async () => {
      stage = "partial";
      deliveries.partial = await deliver(pool, "partial");
      facts.partial = await worldFacts(pool, gap);
      check("the same incident, still open", facts.partial.incident.id === gap && facts.partial.incident.status === "open", facts.partial.incident);
      await views(page, gap, "partial");
    });

    await test.step("verified: 18 of 18, $2,123.52 reclassified from Search to Local Services, nothing added", async () => {
      stage = "verified";
      deliveries.rest = await deliver(pool, "rest");
      facts.rest = await worldFacts(pool, gap);
      check("the same incident, now resolved by its verification", facts.rest.incident.id === gap && facts.rest.incident.status === "resolved" && !!facts.rest.incident.verifiedAt, facts.rest.incident);
      const was = facts.missing.acceptedSpend.successor;
      const now = facts.rest.acceptedSpend.successor;
      check(
        "reclassified, not added: each of pmax-lsa-B09's 18 accepted days moved from Google Search to Google Local Services with the same cents, $2,123.52 in all",
        was.length === 18 && now.length === 18 && was.every((w, i) => w.date === now[i].date && w.cents === now[i].cents && w.channel === "google_search" && now[i].channel === "google_lsa") && was.reduce((t, w) => t + w.cents, 0) === 212_352,
        { was: was.map((w) => `${w.date}:${w.channel}:${w.cents}`), now: now.map((n) => `${n.date}:${n.channel}:${n.cents}`) },
      );
      check("company-wide accepted spend is the same total before and after: nothing added", facts.rest.acceptedSpend.cents === facts.missing.acceptedSpend.cents && facts.rest.acceptedSpend.days === facts.missing.acceptedSpend.days, { missing: facts.missing.acceptedSpend.cents, verified: facts.rest.acceptedSpend.cents });
      await views(page, gap, "verified");
      const r = await runRow(page, deliveries.rest.runId);
      check(`the verification's run (#${deliveries.rest.runId}) says what it stored, changed and was used for`, r.Stored === "13" && r.Outcome === expectedOutcomes(gap).rest.join(" "), r);
    });

    await test.step("replays: a duplicate, an older revision and a stale Search revision change nothing", async () => {
      stage = "replays";
      for (const s of ["duplicate", "older", "stale"] as const) {
        deliveries[s] = await deliver(pool, s);
        facts[s] = await worldFacts(pool, gap);
      }
      const before = facts.rest;
      const after = facts.stale;
      const digest = (s: States) => ({ days: facts[s].acceptedSpend.days, cents: facts[s].acceptedSpend.cents, md5: facts[s].acceptedSpend.md5 });
      for (const s of ["duplicate", "older", "stale"] as const) {
        check(
          `after the ${s} replay the accepted spend evidence is identical, row for row: ${facts[s].acceptedSpend.days} accepted days company-wide, and pmax-lsa-B09's 18 days keep their channel, cents and source version`,
          same(facts[s].acceptedSpend, before.acceptedSpend),
          { verified: digest("rest"), [s]: digest(s) },
        );
      }
      check("no change to money, customers or cash at B09 or company-wide", same([before.b09, before.company], [after.b09, after.company]), { before: [before.b09, before.company], after: [after.b09, after.company] });
      check("the same incident, still resolved, with its single verification", same(before.incident, after.incident) && after.incident.previousVerifications === 0, after.incident);
      check("no second case and no case transition", same(before.case, after.case) && after.casesForGaps === 1 && after.coverageGaps.length === 1, { before: before.case, after: after.case });
      check("nothing opened anywhere", same(before.exceptionsByKind, after.exceptionsByKind), { before: before.exceptionsByKind, after: after.exceptionsByKind });
      check("the campaign record is still what the newest fetch said", same(before.campaign, after.campaign) && after.campaign.channel === "google_lsa", after.campaign);
      const want = expectedOutcomes(gap);
      for (const s of STEPS) {
        const r = await runRow(page, deliveries[s].runId);
        check(`pipeline #${deliveries[s].runId} (${s}): ${want[s].join(" ").slice(0, 70)}`, r.Outcome === want[s].join(" "), r);
      }
      const unrecorded = (await pool.query("select id from ingestion_runs where status = 'failed' and rows_changed is null order by id limit 1")).rows[0];
      const failed = unrecorded ? await runRow(page, Number(unrecorded.id)) : {};
      check(`a run whose effect was not recorded says so, never 'no change' (#${unrecorded?.id}, failed)`, !!unrecorded && failed.Outcome === "Effect not recorded" && failed.Status === "failed", failed);
      await page.goto(`/exceptions/${gap}?${CTX}#recovery`);
      await visible(page, '[data-testid="gap-recovery"]').waitFor({ timeout: 60_000 });
      const recovery = await textOf(page, "#recovery");
      for (const s of expected(gap).verified.incident) check(`after the replays the incident still says: ${s}`, recovery.includes(s), recovery);
    });

    await test.step("ledger: what the source sent against what the product recorded", async () => {
      stage = "ledger";
      ledger = await ledgerChecks(pool, gap, deliveries, facts);
      for (const c of ledger.checks) check(c.name, c.ok, c.detail);
    });

    await test.step("scope: every denied request paired with an allowed request for the same resource", async () => {
      stage = "scope";
      scoped = await scope(browser, pool, gap, deliveries.rest.runId);
    });

    stage = "errors";
    check("no console or page errors in the walk", errors.length === 0, errors);
  } finally {
    const out = acceptanceOut();
    mkdirSync(out, { recursive: true });
    const git = (args: string[]) => execFileSync("git", args, { cwd: REPO, encoding: "utf8" }).trim();
    const failed = checks.filter((c) => !c.ok);
    const record = {
      proof: "B09 acceptance runner (docs/agent-work/B09-ACCEPTANCE-RUNNER.md)",
      sha: git(["rev-parse", "HEAD"]),
      trackedChanges: git(["status", "--porcelain", "--untracked-files=no"]).split("\n").filter(Boolean),
      command: process.env.npm_lifecycle_event ? `npm run ${process.env.npm_lifecycle_event}` : process.argv.slice(1).join(" "),
      build: readFileSync(path.join(REPO, ".next", "BUILD_ID"), "utf8").trim(),
      server: BASE,
      database: acceptanceDatabaseName(),
      postgres: String((await pool.query("show server_version")).rows[0].server_version),
      node: process.version,
      playwright: (JSON.parse(readFileSync(path.join(REPO, "node_modules", "@playwright", "test", "package.json"), "utf8")) as { version: string }).version,
      started,
      finished: new Date().toISOString(),
      summary: { checks: checks.length, passed: checks.length - failed.length, failed: failed.length, consoleOrPageErrors: errors.length },
      failed,
      gap,
      runs: Object.fromEntries(Object.entries(deliveries).map(([s, d]) => [s, d.runId])),
      checks,
      errors,
      facts,
      // Both are assigned inside test.step callbacks, which control-flow analysis does not follow.
      ledger: (ledger as Awaited<ReturnType<typeof ledgerChecks>> | null)?.records ?? null,
      scope: scoped as Awaited<ReturnType<typeof scope>> | null,
    };
    writeFileSync(path.join(out, "results.json"), JSON.stringify(record, null, 2));
    console.log(`[acceptance] ${record.summary.passed} of ${record.summary.checks} checks passed at ${record.sha.slice(0, 7)} (build ${record.build}); record: ${path.relative(REPO, path.join(out, "results.json"))}`);
    await pool.end();
  }
});
