import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { getNow } from "@/lib/db";
import { seed } from "@/lib/sim/seed";
import { VIEWERS } from "@/lib/viewer";
import { approveProposal, createProposal, dryRunProposal, executeProposal } from "@/lib/workflow/proposals";
import { caseForException, caseProposals } from "@/lib/workflow/queries";
import { one, testPool } from "../helpers";

/**
 * B20's fix receipt leads with October (release design §5.8, WP-E). On the seeded demo world, the
 * call feed's field rename held B20's calls in quarantine; replaying them through calls@1.1 with
 * the Action Center (propose, dry run, approve, execute) stores before and after snapshots, and
 * the stored execution now carries the branch's October as well as the replay's whole window.
 * Every figure below is what the receipt shows, read back from the stored execution.
 */

const pool = testPool();
let exceptionId = 0;

beforeAll(async () => {
  await seed(pool);
  exceptionId = Number(
    (await one<{ id: string }>(pool, "select id from exceptions where branch_id = 'B20' and kind = 'quarantined_source_records' and status = 'open' order by id limit 1")).id,
  );
}, 300_000);

afterAll(async () => {
  await pool.end();
});

describe("B20's fix receipt", () => {
  it("stores October before and after: CAC $490.11 → $271.31 on the same spend and the same 109 customers", async () => {
    expect(exceptionId).toBeGreaterThan(0);
    const now = await getNow(pool);
    const proposal = await createProposal(pool, {
      exceptionId,
      kind: "replay_quarantine",
      params: { mapperVersion: "1.1" },
      rationale: "Replay the held calls through calls@1.1, which reads the renamed field",
      source: "human",
      actor: VIEWERS.marketing,
      now,
    });
    const dry = await dryRunProposal(pool, { proposalId: proposal.id, actor: VIEWERS.engineer, now });
    expect(dry.status, dry.dryRun?.error ?? "").toBe("dry_run_ok");
    await approveProposal(pool, { proposalId: proposal.id, actor: VIEWERS.approver, reason: "Dry run verified; the five ledger totals are conserved", now });
    await executeProposal(pool, { proposalId: proposal.id, actor: VIEWERS.approver, now });

    const kase = await caseForException(pool, exceptionId);
    const execution = (await caseProposals(pool, kase!.id)).find((p) => p.id === proposal.id)!.execution!;
    expect(execution.status).toBe("succeeded");
    const before = execution.before!.month!;
    const after = execution.after!.month!;
    expect([before.key, after.key]).toEqual(["oct", "oct"]);
    expect([before.branch.paidCacCents, after.branch.paidCacCents]).toEqual([49_011, 27_131]);
    expect([before.branch.paidSpendCents, after.branch.paidSpendCents]).toEqual([1_519_347, 1_519_347]);
    expect([before.branch.acquired, after.branch.acquired]).toEqual([109, 109]);
    expect([before.branch.paidAcquired, after.branch.paidAcquired]).toEqual([31, 56]);
    // Where credit moved: 33 customers changed channel. 30 had none and 3 were door-to-door; 25
    // now count as paid media (Search +13, Local Services +11, Meta +1) and 8 as organic Business Profile.
    const moved = (code: string) => (after.branch.acquiredByChannel?.[code] ?? 0) - (before.branch.acquiredByChannel?.[code] ?? 0);
    expect([moved("unknown"), moved("d2d"), moved("organic_gbp")]).toEqual([-30, -3, 8]);
    expect([moved("google_search"), moved("google_lsa"), moved("meta")]).toEqual([13, 11, 1]);
    expect(before.branch.unknownAcquired - after.branch.unknownAcquired).toBe(30);
    // The replay's own window, which the receipt shows below the month.
    expect([execution.before!.branch!.paidCacCents, execution.after!.branch!.paidCacCents]).toEqual([36_475, 28_406]);
  });
});
