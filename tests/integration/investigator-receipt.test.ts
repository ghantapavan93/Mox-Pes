import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { runInvestigation } from "@/lib/ai/investigate";
import { resolveEvidence } from "@/lib/ai/queries";
import { applyHostedCorrection, type HostedCorrection } from "@/lib/demo/hosted-correction";
import { seed } from "@/lib/sim/seed";
import { workspaceViewer } from "@/lib/viewer";
import { subjectOf } from "@/lib/workspace";
import { testPool } from "../helpers";

/**
 * The hosted demo's headline question on the hosted copy: the seeded world with B20's approved
 * repair (lib/demo/hosted-correction.ts, as `npm run db:correct-hosted` leaves it). "Why did B20's
 * CAC jump in October?" asks about history: the jump readers saw was measured with 119 call
 * records held, and an approved, verified repair corrected it. The answer reads what happened
 * before the repair from the stored receipt, and what the metric says now from the scorecard,
 * cites both, and passes the same evidence check as every answer: the historical figures are proved
 * from the receipt's stored fields, never from today's scorecard. Controls: a question about the
 * current figure, another branch and another month never borrow the receipt, and the last two say
 * that none matches.
 */

const pool = testPool();
const NOW = new Date("2026-10-31T13:00:00Z");
const visitor = workspaceViewer(subjectOf("r".repeat(43)));
let receipt: HostedCorrection;

const ask = (question: string) => runInvestigation(pool, { question, branchId: null, viewer: visitor, now: NOW });
const textOf = (out: Awaited<ReturnType<typeof ask>>) => out.result.observations.map((o) => o.text).join("\n");
const citedBy = (out: Awaited<ReturnType<typeof ask>>) => new Set(out.result.observations.flatMap((o) => o.evidenceIds));

beforeAll(async () => {
  await seed(pool);
  const done = await applyHostedCorrection(pool);
  if (!done) throw new Error("the seeded world has no open B20 quarantine to correct");
  receipt = done;
}, 300_000);

afterAll(async () => {
  await pool.end();
});

describe("B20's October CAC, after the approved repair", () => {
  it("the hosted copy holds the receipt the answer reads", () => {
    expect([receipt.before?.paidCacCents, receipt.after?.paidCacCents]).toEqual([49_011, 27_131]);
    expect([receipt.before?.paidAcquired, receipt.after?.paidAcquired]).toEqual([31, 56]);
    expect([receipt.before?.paidSpendCents, receipt.after?.paidSpendCents]).toEqual([1_519_347, 1_519_347]);
    expect([receipt.before?.acquired, receipt.after?.acquired]).toEqual([109, 109]);
  });

  it("answers the jump from the receipt, the current figure from the scorecard, and cites both", async () => {
    const out = await ask("Why did B20's CAC jump in October?");
    const r = out.result;
    const text = textOf(out);
    // What happened before the repair: the stored receipt.
    expect(text).toContain("$490.11");
    expect(text).toMatch(/119 held call records/);
    expect(text).toMatch(/from 31 to 56/);
    expect(text).toContain("$15,193.47");
    expect(text).toMatch(/109 serviced customers/);
    // What the metric says now: the scorecard.
    expect(text).toContain("$271.31");
    const cited = citedBy(out);
    expect(cited).toContain(`proposal:${receipt.proposalId}`);
    expect(cited).toContain(`exception:${receipt.exceptionId}`);
    expect(cited).toContain("branch_metrics:B20:oct");
    // Each citation links to its page: the receipt's incident, the scorecard's branch.
    const drawer = { db: pool, viewer: visitor, now: NOW };
    await expect(resolveEvidence(drawer, out.id, `proposal:${receipt.proposalId}`)).resolves.toMatchObject({ href: `/exceptions/${receipt.exceptionId}` });
    await expect(resolveEvidence(drawer, out.id, "branch_metrics:B20:oct")).resolves.toMatchObject({ href: "/branches/B20?period=oct" });
    // The receipt's figures are proved from its stored fields: every finding stays verified.
    expect(r.observations.filter((o) => o.evidenceIds.includes(`proposal:${receipt.proposalId}`)).map((o) => o.status)).toEqual(["verified", "verified"]);
    // The same evidence check as every answer: nothing dropped, the summary stands.
    expect(r.grounding.claimsDropped).toBe(0);
    expect(r.summary).not.toMatch(/withheld/);
    expect(r.summary).toMatch(/corrected/i);
    expect(r.summary).toContain("$271.31");
    // A verified repair corrects a measurement; it does not approve a budget move.
    expect([r.recommendedNextAction, ...r.risks].join(" ")).toMatch(/not (?:an? )?(?:approval|permission) to move budget/i);
  });

  it("a question about the current figure answers from the scorecard alone", async () => {
    const out = await ask("What is B20's paid CAC in October?");
    expect(out.result.summary).toContain("$271.31");
    expect(textOf(out)).not.toContain("$490.11");
    expect(citedBy(out)).not.toContain(`proposal:${receipt.proposalId}`);
    expect(out.result.grounding.claimsDropped).toBe(0);
  });

  it("another branch never borrows B20's receipt, and says it has none", async () => {
    const out = await ask("Why did B09's CAC jump in October?");
    const text = textOf(out);
    expect(text).not.toContain("$490.11");
    expect(text).not.toMatch(/held call records/);
    expect(citedBy(out)).not.toContain(`proposal:${receipt.proposalId}`);
    expect(out.result.missingInformation.join(" ")).toMatch(/No verified correction of B09's paid-media CAC for Oct 1–30, 2026/);
  });

  it("another month never borrows October's receipt, and says it has none", async () => {
    const out = await ask("Why did B20's CAC jump in September?");
    const text = textOf(out);
    expect(text).not.toContain("$490.11");
    expect(text).not.toMatch(/held call records/);
    expect(citedBy(out)).not.toContain(`proposal:${receipt.proposalId}`);
    expect(out.result.missingInformation.join(" ")).toMatch(/No verified correction of B20's paid-media CAC for Sep 1–30, 2026/);
  });
});
