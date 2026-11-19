import type { Pool } from "pg";
import { createChange, listChanges } from "@/lib/changeguard/service";
import { getNow } from "@/lib/db";
import { listShadowChecks, runShadowCheck } from "@/lib/shadow/store";
import { VIEWERS } from "@/lib/viewer";
import { createProposal, dryRunProposal } from "@/lib/workflow/proposals";
import { caseForException, caseProposals } from "@/lib/workflow/queries";

/**
 * The hosted copy's worked examples (sharing review, 2026-11-19). The hosted demo has no staff
 * roles, so a visitor found Answer check and ChangeGuard empty, and every incident either detected
 * or resolved: nothing in between. These are made through the product's own paths, as the demo
 * roles would make them, and none moves a shared figure:
 *
 *   - two answer checks recorded against the ledger: a figure another system got right, and a
 *     causal claim the evidence does not support;
 *   - a ChangeGuard change mapping B44's unmapped Local Services campaign to B44, preflighted (the
 *     production write path, in a transaction that is rolled back) and left for a different person
 *     to approve. It is not released, so spend stays where it is counted today;
 *   - B09's coverage-gap fix (re-map the channel with ads@1.1) proposed and dry-run (rolled back),
 *     left awaiting a different role's approval.
 *
 * Each is made only when it is not there yet, so a second run changes nothing. Run on a copy that
 * was loaded and corrected (scripts/populate-hosted-demo.ts, docs/deploy.md step 2).
 */

const SYSTEM = "Atlas BI (synthetic)";
const ANSWERS = [
  "B20's paid-media CAC was $271.31 in October.",
  "B09's paid CAC rose in October. That is because Google Search spend doubled.",
];
const UNMAPPED_CAMPAIGN = "B44 | Local Services | Expansion";

export async function applyHostedExamples(db: Pool): Promise<string[]> {
  const now = await getNow(db);
  const done: string[] = [];
  const { marketing, engineer } = VIEWERS;

  // 1. Answer checks: what another system said, checked claim by claim.
  const recorded = new Set((await listShadowChecks(db, marketing, 100)).map((c) => ("answer" in c.input ? c.input.answer : "")));
  for (const answer of ANSWERS) {
    if (recorded.has(answer)) continue;
    const check = await runShadowCheck(db, marketing, { kind: "answer", input: { system: SYSTEM, asOf: new Date(now.getTime() - 7 * 3_600_000).toISOString(), question: "", answer } }, now);
    done.push(`answer check #${check.id}: ${check.verdict} — "${answer}"`);
  }

  // 2. ChangeGuard: the unmapped campaign, mapped to the branch its name says, checked and left in review.
  const campaign = (await db.query<{ id: string }>("select id from ad_campaigns where name = $1", [UNMAPPED_CAMPAIGN])).rows[0];
  if (campaign) {
    const campaignId = Number(campaign.id);
    const existing = (await listChanges(db, engineer, 100)).find((c) => c.kind === "campaign_mapping" && (c.payload as { campaignId?: number }).campaignId === campaignId);
    if (!existing) {
      const change = await createChange(
        db,
        engineer,
        { kind: "campaign_mapping", payload: { campaignId, branchId: "B44" }, reason: "Map the Local Services expansion campaign to B44, the branch its name and leads point to, so its spend counts in B44's cost per customer" },
        now,
      );
      done.push(`ChangeGuard change #${change.id}: ${change.status}`);
    }
  }

  // 3. The Action Center: B09's fix proposed and dry-run, waiting for another role to approve.
  const gap = (await db.query<{ id: string }>("select id from exceptions where kind = 'channel_coverage_gap' and branch_id = 'B09' and status = 'open' order by id desc limit 1")).rows[0];
  if (gap) {
    const exceptionId = Number(gap.id);
    const kase = await caseForException(db, exceptionId);
    const live = kase ? (await caseProposals(db, kase.id)).some((p) => ["draft", "dry_run_ok", "approved"].includes(p.status)) : false;
    if (!live) {
      const proposal = await createProposal(db, {
        exceptionId,
        kind: "remap_channel",
        params: { mapperVersion: "1.1" },
        rationale: "ads@1.1 files Performance Max campaigns with Local Services enabled as Local Services; re-map B09's stored spend",
        source: "human",
        actor: engineer,
        now,
      });
      const dry = await dryRunProposal(db, { proposalId: proposal.id, actor: engineer, now });
      done.push(`proposal #${proposal.id} on incident #${exceptionId}: ${dry.status}`);
    }
  }
  return done;
}
