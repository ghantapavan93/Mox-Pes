import { readFileSync } from "node:fs";
import path from "node:path";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { withTransaction } from "@/lib/db";
import { decideMapping, getUpload, proposeMapping, stageUpload } from "@/lib/onboarding/service";
import { ensureCaseForException } from "@/lib/workflow/cases";
import { VIEWERS, type Viewer } from "@/lib/viewer";
import { freshDb, testPool } from "../helpers";

/**
 * Separation of duties by person, and the append-only audit trail (migration 0014).
 * "One person, two roles" is modelled as two viewers with the same subject: what an identity
 * provider produces for an administrator granted both the analyst and the approver groups.
 */
const pool: Pool = testPool();
beforeEach(async () => freshDb(pool));
afterAll(async () => pool.end());

const NOW = new Date("2026-11-10T15:00:00Z");
const bytes = readFileSync(path.join(__dirname, "..", "fixtures", "onboarding", "holdout", "callrail-style-export.csv"));
const asPerson = (v: Viewer, subject: string): Viewer => ({ ...v, subject });

async function proposed(proposer: Viewer) {
  const r = await stageUpload(pool, { viewer: proposer, filename: "calls.csv", bytes, now: NOW });
  if ("refused" in r) throw new Error(r.refused.message);
  const d = await getUpload(pool, proposer, r.upload.id, NOW);
  const spec = {
    dataset: "calls" as const,
    columns: Object.fromEntries(d.assistant.fields.map((f) => [f.field, f.status === "suggested" ? f.column : null])),
    constants: {}, valueMaps: {}, dateOrder: "MDY" as const, localTime: "branch_local" as const, moneyMeaning: {}, exportedAt: null,
  };
  return proposeMapping(pool, { viewer: proposer, uploadId: r.upload.id, spec, now: NOW });
}

describe("separation of duties by person", () => {
  it("one person holding the analyst and the approver role cannot approve their own mapping", async () => {
    const m = await proposed(asPerson(VIEWERS.marketing, "idp:jordan"));
    await expect(decideMapping(pool, { viewer: asPerson(VIEWERS.approver, "idp:jordan"), mappingId: m.mappingId, decision: "approve", reason: "Looks right to me", now: NOW })).rejects.toThrow(/someone else/);
    // A different person with the approver role can.
    await expect(decideMapping(pool, { viewer: asPerson(VIEWERS.approver, "idp:sam"), mappingId: m.mappingId, decision: "approve", reason: "Checked the export", now: NOW })).resolves.toEqual({ status: "approved" });
  });

  it("the database refuses the same person on both sides even if application code is bypassed", async () => {
    const m = await proposed(asPerson(VIEWERS.marketing, "idp:jordan"));
    await expect(
      pool.query("update onboarding_mappings set status = 'approved', decided_role = 'approver', decided_subject = 'idp:jordan', decided_at = now() where id = $1", [m.mappingId]),
    ).rejects.toThrow(/onboarding_mappings_different_person/);
  });

  it("an Action Center approval by the proposing person is refused by the database trigger", async () => {
    // An exception, its case (through the product's own function), then a proposal by jordan.
    const ex = await pool.query<{ id: string }>(
      `insert into exceptions (kind, severity, fingerprint, subject_type, subject_id, summary, evidence, first_detected_at, last_detected_at)
       values ('quarantined_source_records', 'high', 'sec-test', 'source', 'calls', 'test', '{}', now(), now()) returning id`,
    );
    const exceptionId = Number(ex.rows[0].id);
    const kase = await withTransaction(pool, (tx) => ensureCaseForException(tx, exceptionId, NOW));
    const p = await pool.query<{ id: string }>(
      `insert into action_proposals (case_id, exception_id, kind, params, rationale, source, proposed_by, proposed_role, proposed_subject, status, created_at, updated_at)
       values ($1, $2, 'acknowledge_exception', '{}', 'test', 'human', 'x', 'engineer', 'idp:jordan', 'dry_run_ok', now(), now()) returning id`,
      [kase.id, exceptionId],
    );
    await expect(
      pool.query("insert into action_approvals (proposal_id, decision, actor, role, reason, decided_at, subject) values ($1, 'approved', 'approver', 'approver', 'self', now(), 'idp:jordan')", [p.rows[0].id]),
    ).rejects.toThrow(/separation of duties/);
    await expect(
      pool.query("insert into action_approvals (proposal_id, decision, actor, role, reason, decided_at, subject) values ($1, 'approved', 'approver', 'approver', 'other', now(), 'idp:sam')", [p.rows[0].id]),
    ).resolves.toBeDefined();
  });
});

describe("audit integrity", () => {
  it("the audit log cannot be edited or deleted", async () => {
    await pool.query("insert into audit_log (at, actor, action, subject, detail) values (now(), 'x', 'test', 'test', '{}')");
    await expect(pool.query("update audit_log set actor = 'someone else'")).rejects.toThrow(/append-only/);
    await expect(pool.query("delete from audit_log")).rejects.toThrow(/append-only/);
  });
});
