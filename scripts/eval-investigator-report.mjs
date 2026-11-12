// Headline measures of one held-out investigator run (docs/agent-work/investigator-heldout/SCORING.md),
// each over its own denominator, with every critical and high finding listed one by one.
//   node scripts/eval-investigator-report.mjs <result.json> [<previous.json>]
import { readFileSync } from "node:fs";

const load = (f) => JSON.parse(readFileSync(f, "utf8"));
const run = load(process.argv[2]);
const results = run.results;
const errors = results.filter((r) => !r.outcome);
const scored = results.filter((r) => r.outcome);
const inv = scored.filter((r) => r.mode === "investigator");
const claims = scored.filter((r) => r.mode === "claims");
const caseOf = new Map(load(process.argv[3] ?? "docs/agent-work/investigator-heldout/cases.v1.json").cases?.map((c) => [c.id, c]) ?? []);

const pct = (a, b) => (b === 0 ? "—" : `${((100 * a) / b).toFixed(1)}%`);
const line = (label, a, b) => `| ${label} | ${a} / ${b} | ${pct(a, b)} |`;
const out = [];

out.push(`Run: ${run.ranAt ?? "?"} · cases ${results.length} · runner errors ${errors.length} (${errors.map((e) => `${e.id}: ${String(e.error).split(/\r?\n/)[0]}`).join("; ") || "none"})`, "");

// Investigator mode.
const expected = (r) => caseOf.get(r.id)?.expect?.outcome;
const byOutcome = {};
for (const r of inv) {
  const k = `${expected(r)}→${r.outcome}`;
  byOutcome[k] = (byOutcome[k] ?? 0) + 1;
}
const correct = inv.filter((r) => expected(r) === r.outcome).length;
const answers = inv.filter((r) => expected(r) === "ANSWER");
const abstainExp = inv.filter((r) => expected(r) === "ABSTAIN");
const refuseExp = inv.filter((r) => expected(r) === "REFUSE");
const abstainGot = inv.filter((r) => r.outcome === "ABSTAIN");
const f = (r, kind) => r.findings.filter((x) => x.type === kind);
const count = (rs, kind) => rs.reduce((n, r) => n + f(r, kind).length, 0);
const refFacts = inv.reduce((n, r) => n + (caseOf.get(r.id)?.expect?.referenceFacts ?? []).filter((x) => x.mustBeStated).length, 0);
out.push("Investigator mode (deterministic investigator; no language model)", "", "| Measure | Count | Rate |", "|---|---|---|");
out.push(line("Correct outcome", correct, inv.length));
out.push(line("Expected ANSWER, answered", answers.filter((r) => r.outcome === "ANSWER").length, answers.length));
out.push(line("Expected ABSTAIN, abstained", abstainExp.filter((r) => r.outcome === "ABSTAIN").length, abstainExp.length));
out.push(line("Expected REFUSE, refused", refuseExp.filter((r) => r.outcome === "REFUSE").length, refuseExp.length));
out.push(line("Abstention precision (abstained when it should have)", abstainGot.filter((r) => expected(r) === "ABSTAIN").length, abstainGot.length));
out.push(line("Unnecessary abstentions (expected ANSWER, got ABSTAIN)", answers.filter((r) => r.outcome === "ABSTAIN").length, answers.length));
out.push(line("Reference facts stated in a SUPPORTED claim", refFacts - count(inv, "missing_reference_fact"), refFacts));
out.push(`| Forbidden statements in SUPPORTED claims | ${count(inv, "forbidden_statement")} | — |`);
out.push(`| Authorization failures | ${count(inv, "authorization_failure")} | — |`);
out.push(`| Unmatched figures (info, for review) | ${count(inv, "unmatched_figure")} | — |`);
out.push(`| Invalid tool calls | ${count(inv, "invalid_tool_call")} | — |`);
// The product's own sentences must never be contradicted by its own checker (a false rejection).
const templateClaims = inv.flatMap((r) => r.claims ?? []);
const selfContradicted = templateClaims.filter((c) => (c.proofs ?? []).some((p) => p.verdict === "CONTRADICTED"));
out.push(`| Template sentences contradicted by their own proofs | ${selfContradicted.length} / ${templateClaims.length} | ${pct(selfContradicted.length, templateClaims.length)} |`);
out.push("", `Outcome matrix (expected→got): ${Object.entries(byOutcome).map(([k, v]) => `${k} ${v}`).join(", ")}`, "");

// Claims mode.
const cands = claims.flatMap((r) => r.candidates.map((c) => ({ ...c, case: r.id, severity: r.severityIfWrong })));
const sup = cands.filter((c) => c.expect === "SUPPORTED");
const notSup = cands.filter((c) => c.expect !== "SUPPORTED");
const falseAccept = notSup.filter((c) => c.got === "SUPPORTED");
const falseReject = sup.filter((c) => c.got !== "SUPPORTED");
out.push("Claims mode (the claim checker behind a scripted provider; measures the checker, not a model)", "", "| Measure | Count | Rate |", "|---|---|---|");
out.push(line("Candidates judged correctly (SUPPORTED vs not)", cands.length - falseAccept.length - falseReject.length, cands.length));
out.push(line("Wrong candidates rejected", notSup.length - falseAccept.length, notSup.length));
out.push(line("Correct candidates accepted", sup.length - falseReject.length, sup.length));
out.push(line("False accepts in critical-severity cases", falseAccept.filter((c) => c.severity === "critical").length, notSup.filter((c) => c.severity === "critical").length));
out.push(line("Exact status (all five statuses)", cands.filter((c) => c.got === c.expect).length, cands.length));
out.push("", "False accepts, one by one:", "");
for (const c of falseAccept) out.push(`- ${c.case} [${c.severity}] "${c.text}"`);
out.push("", "False rejects, one by one:", "");
for (const c of falseReject) out.push(`- ${c.case} "${c.text}" → ${c.got}`);
out.push("", "Critical and high findings in investigator mode:", "");
for (const r of inv) for (const x of r.findings.filter((x) => x.severity === "critical" || x.severity === "high")) out.push(`- ${r.id} [${x.severity}] ${x.type}: ${x.detail ?? ""}`.slice(0, 400));
console.log(out.join("\n"));
