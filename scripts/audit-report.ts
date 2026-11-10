import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Machine-verifiable audit report: `npm run audit:report` (add `-- --skip-e2e`, `--skip-build`,
 * or `--reuse` to evaluate the JSON results already in the output directory).
 *
 * Runs typecheck, lint, every vitest test (JSON reporter), the production build and every
 * Playwright spec (JSON reporter), then checks the audit ledger against the results:
 *
 *   * every finding marked "fixed" must name regression tests, and each must exist and pass;
 *   * every interview claim marked "safe" must name evidence tests, and each must exist and pass.
 *
 * Writes <out>/verification.json and exits 1 on any failed command or unmet rule, so the report
 * cannot say "verified" about something no passing test shows. A test reference matches a result
 * when the file is the same and the result's full name contains the reference name ("" = every
 * test in the file).
 */

const ROOT = path.resolve(__dirname, "..");
const args = new Set(process.argv.slice(2));
const outArg = process.argv.slice(2).find((a) => a.startsWith("--out="));
const OUT = path.resolve(ROOT, outArg ? outArg.slice("--out=".length) : "docs/audit/2026-11-09");
const VITEST_JSON = path.join(OUT, "vitest-results.json");
const PLAYWRIGHT_JSON = path.join(OUT, "playwright-results.json");

/**
 * The results files are committed, so they must not carry the machine they ran on. Playwright's
 * JSON reporter serialises the whole config, including `webServer.env`, which is the shell
 * environment of whoever ran it (tokens, e-mail, paths). Keep only the variable names this repo
 * sets, and replace the home directory with "~".
 */
export function redactResultsText(text: string, home = os.homedir()): string {
  const json = JSON.parse(text) as { config?: { webServer?: { env?: Record<string, string> } } };
  const env = json.config?.webServer?.env;
  if (env) json.config!.webServer!.env = Object.fromEntries(Object.entries(env).filter(([k]) => k === "DEMO_MODE"));
  let out = JSON.stringify(json, null, 2);
  for (const form of [home, home.replaceAll("\\", "\\\\"), home.replaceAll("\\", "/")]) out = out.split(form).join("~");
  return `${out}
`;
}

function redactResultsFile(file: string) {
  if (existsSync(file)) writeFileSync(file, redactResultsText(readFileSync(file, "utf8")));
}

interface TestRef { runner: "vitest" | "playwright"; file: string; name: string }
interface Result { runner: TestRef["runner"]; file: string; name: string; status: "passed" | "failed" | "skipped" }
interface Command { name: string; command: string; rc: number | null; seconds: number }

const rel = (file: string) => path.relative(ROOT, path.resolve(ROOT, file)).split(path.sep).join("/");

function run(name: string, command: string, env: Record<string, string> = {}): Command {
  const started = Date.now();
  console.log(`\n▶ ${name}: ${command}`);
  const r = spawnSync(command, { cwd: ROOT, shell: true, stdio: "inherit", env: { ...process.env, ...env } });
  return { name, command, rc: r.status, seconds: Math.round((Date.now() - started) / 1000) };
}

function vitestResults(): Result[] {
  if (!existsSync(VITEST_JSON)) return [];
  const json = JSON.parse(readFileSync(VITEST_JSON, "utf8")) as {
    testResults: Array<{ name: string; assertionResults: Array<{ fullName: string; status: string }> }>;
  };
  return json.testResults.flatMap((f) =>
    f.assertionResults.map((a) => ({
      runner: "vitest" as const,
      file: rel(f.name),
      name: a.fullName,
      status: a.status === "passed" ? "passed" : a.status === "failed" ? "failed" : "skipped",
    })),
  );
}

interface PwSuite { title: string; file?: string; specs?: Array<{ title: string; file: string; tests: Array<{ status: string }> }>; suites?: PwSuite[] }

function playwrightResults(): Result[] {
  if (!existsSync(PLAYWRIGHT_JSON)) return [];
  const json = JSON.parse(readFileSync(PLAYWRIGHT_JSON, "utf8")) as { suites: PwSuite[] };
  const out: Result[] = [];
  const walk = (suite: PwSuite, titles: string[]) => {
    for (const spec of suite.specs ?? []) {
      const statuses = spec.tests.map((t) => t.status);
      const status = statuses.every((s) => s === "skipped") ? "skipped" : statuses.every((s) => s === "expected" || s === "skipped") ? "passed" : "failed";
      out.push({ runner: "playwright", file: rel(path.join("tests/e2e", spec.file)), name: [...titles, spec.title].join(" › "), status });
    }
    for (const child of suite.suites ?? []) walk(child, [...titles, child.title]);
  };
  for (const fileSuite of json.suites) walk(fileSuite, []);
  return out;
}

function check(refs: TestRef[], results: Result[]) {
  return refs.map((ref) => {
    const matched = results.filter((r) => r.runner === ref.runner && r.file === rel(ref.file) && r.name.includes(ref.name));
    const ran = matched.filter((r) => r.status !== "skipped");
    return { ...ref, matched: matched.length, passed: ran.filter((r) => r.status === "passed").length, ok: ran.length > 0 && ran.every((r) => r.status === "passed") };
  });
}

const tally = (rs: Result[]) => ({
  total: rs.length,
  passed: rs.filter((r) => r.status === "passed").length,
  failed: rs.filter((r) => r.status === "failed").length,
  skipped: rs.filter((r) => r.status === "skipped").length,
});

function git(cmd: string): string {
  const r = spawnSync(`git ${cmd}`, { cwd: ROOT, shell: true, encoding: "utf8" });
  return (r.stdout ?? "").trim();
}

function main() {
  mkdirSync(OUT, { recursive: true });
  const commands: Command[] = [];
  if (!args.has("--reuse")) {
    commands.push(run("typecheck", "npm run typecheck"));
    commands.push(run("lint", "npm run lint"));
    commands.push(run("vitest", `npx vitest run --reporter=default --reporter=json --outputFile.json="${VITEST_JSON}"`));
    if (!args.has("--skip-build")) commands.push(run("build", "npm run build"));
    if (!args.has("--skip-e2e")) {
      commands.push(run("playwright", "npx playwright test --reporter=list,json", { CI: "1", PORT: "3000", PLAYWRIGHT_JSON_OUTPUT_FILE: PLAYWRIGHT_JSON }));
    }
  }

  redactResultsFile(VITEST_JSON);
  redactResultsFile(PLAYWRIGHT_JSON);
  const results = [...vitestResults(), ...playwrightResults()];
  const findings = (JSON.parse(readFileSync(path.join(OUT, "findings.json"), "utf8")) as { findings: Array<{ id: string; severity: string; status: string; title: string; tests: TestRef[] }> }).findings;
  const claims = (JSON.parse(readFileSync(path.join(OUT, "claims.json"), "utf8")) as { claims: Array<{ claim: string; safe: boolean; evidence?: TestRef[]; why?: string }> }).claims;

  const violations: string[] = [];
  for (const c of commands) if (c.rc !== 0) violations.push(`command ${c.name} exited ${c.rc}`);

  const checkedFindings = findings.map((f) => {
    const tests = check(f.tests ?? [], results);
    const needsTests = f.status === "fixed";
    const verified = needsTests ? tests.length > 0 && tests.every((t) => t.ok) : null;
    if (needsTests && tests.length === 0) violations.push(`finding ${f.id} is "fixed" but names no regression test`);
    for (const t of tests) if (needsTests && !t.ok) violations.push(`finding ${f.id}: ${t.runner} ${t.file} "${t.name}" ${t.matched === 0 ? "not found" : "did not pass"}`);
    return { id: f.id, severity: f.severity, status: f.status, title: f.title, verified, tests };
  });

  const checkedClaims = claims.map((c) => {
    const evidence = check(c.evidence ?? [], results);
    const supported = c.safe ? evidence.length > 0 && evidence.every((e) => e.ok) : null;
    if (c.safe && !supported) violations.push(`safe claim not supported by passing tests: "${c.claim.slice(0, 80)}…"`);
    return { claim: c.claim, safe: c.safe, supported, why: c.why ?? null, evidence };
  });

  const report = {
    generatedAt: new Date().toISOString(),
    commit: git("rev-parse HEAD"),
    // The report's own output files do not count as uncommitted work.
    workingTreeDirty: git("status --porcelain").split(/\r?\n/).filter((l) => l.trim() && !/(vitest-results|playwright-results|verification)\.json$/.test(l)).length > 0,
    node: process.version,
    commands,
    tests: { vitest: tally(results.filter((r) => r.runner === "vitest")), playwright: tally(results.filter((r) => r.runner === "playwright")) },
    findings: {
      total: checkedFindings.length,
      byStatus: Object.fromEntries([...new Set(checkedFindings.map((f) => f.status))].map((s) => [s, checkedFindings.filter((f) => f.status === s).length])),
      items: checkedFindings,
    },
    claims: { safe: checkedClaims.filter((c) => c.safe).length, unsafe: checkedClaims.filter((c) => !c.safe).length, items: checkedClaims },
    failedTests: results.filter((r) => r.status === "failed"),
    violations,
    ok: violations.length === 0,
  };
  writeFileSync(path.join(OUT, "verification.json"), `${JSON.stringify(report, null, 2)}\n`);
  console.log(`\nverification: ${report.ok ? "OK" : "FAILED"} · vitest ${report.tests.vitest.passed}/${report.tests.vitest.total} · playwright ${report.tests.playwright.passed}/${report.tests.playwright.total} (skipped ${report.tests.playwright.skipped}) · ${violations.length} violation(s)`);
  for (const v of violations) console.log(`  ✗ ${v}`);
  process.exit(report.ok ? 0 : 1);
}

// Run as a script (`tsx scripts/audit-report.ts`); importing it (the redaction test) runs nothing.
if (typeof require !== "undefined" && require.main === module) main();
