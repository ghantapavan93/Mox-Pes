import type { Pool } from "pg";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runInvestigation } from "@/lib/ai/investigate";
import { deleteOwnInvestigation, getInvestigation, listInvestigations, resolveEvidence } from "@/lib/ai/queries";
import { addInquiryNote, openCacInquiry } from "@/lib/inquiry/store";
import { ForbiddenError, VIEWERS, workspaceViewer } from "@/lib/viewer";
import { deleteExpiredWorkspace, subjectOf } from "@/lib/workspace";
import { freshDb, one, testPool } from "../helpers";

/**
 * A visitor's questions on the hosted demo (release design §5.2, §5.9): answered by the
 * deterministic evidence path whatever model keys exist, stored in the workspace tables under the
 * visitor's owner, readable only by that owner, never audited, deleted with their steps after 24
 * hours, and counted against the start quota.
 */

const pool: Pool = testPool();
const NOW = new Date("2026-10-31T13:00:00Z");
const QUESTION = "What is paid CAC?";
const A = workspaceViewer(subjectOf("a".repeat(43)));
const B = workspaceViewer(subjectOf("b".repeat(43)));

const n = async (sql: string, params: unknown[] = []) => (await one<{ n: number }>(pool, `select count(*)::int as n from ${sql}`, params)).n;
const ask = (viewer = A) => runInvestigation(pool, { question: QUESTION, branchId: null, viewer, now: NOW });

beforeAll(async () => {
  await freshDb(pool);
});
afterEach(async () => {
  vi.unstubAllEnvs();
  await pool.query("delete from workspace_quota");
  await pool.query("delete from workspace_investigations");
});
afterAll(async () => {
  await pool.end();
});

describe("a visitor's investigation", () => {
  it("runs the deterministic path even with a model key set, in the workspace tables, unaudited", async () => {
    vi.stubEnv("ANTHROPIC_API_KEY", "sk-ant-test-key-never-used");
    const audit = await n("audit_log");
    const out = await ask();
    expect(out.mode).toBe("deterministic");
    expect(out.result.fallback).toBeUndefined();
    expect(out.result.proposals).toEqual([]);
    expect(await n("workspace_investigations where id = $1 and workspace_owner = $2", [out.id, A.subject])).toBe(1);
    expect(await n("workspace_investigation_steps where investigation_id = $1", [out.id])).toBeGreaterThan(0);
    expect(await n("investigations where id = $1", [out.id])).toBe(0);
    expect(await n("audit_log")).toBe(audit);
    expect(await n("action_proposals")).toBe(0);
  });

  it("is its owner's alone: another visitor and staff get nothing by id, list or evidence", async () => {
    // A branch question, so the run returns evidence to look up (B09's metrics, zero on this database).
    const out = await runInvestigation(pool, { question: "Why is B09's paid CAC high?", branchId: "B09", viewer: A, now: NOW });
    const evidence = out.steps.flatMap((s) => s.evidenceIds)[0];
    expect(evidence).toBeTruthy();
    expect((await getInvestigation(pool, A, out.id))?.workspaceStartedAt).not.toBeNull();
    expect((await listInvestigations(pool, A)).map((i) => i.id)).toContain(out.id);
    const ctxA = { db: pool, viewer: A, now: NOW };
    await expect(resolveEvidence(ctxA, out.id, evidence)).resolves.toMatchObject({ evidenceId: evidence });

    expect(await getInvestigation(pool, B, out.id)).toBeNull();
    expect((await listInvestigations(pool, B)).map((i) => i.id)).not.toContain(out.id);
    await expect(resolveEvidence({ db: pool, viewer: B, now: NOW }, out.id, evidence)).rejects.toMatchObject({ status: 404 });
    for (const staff of [VIEWERS.marketing, VIEWERS.approver]) {
      expect(await getInvestigation(pool, staff, out.id)).toBeNull();
      expect((await listInvestigations(pool, staff)).map((i) => i.id)).not.toContain(out.id);
    }
    await expect(deleteOwnInvestigation(pool, B, out.id)).rejects.toMatchObject({ status: 404 });
    await expect(deleteOwnInvestigation(pool, VIEWERS.marketing, out.id)).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("never shares an id with a company investigation", async () => {
    const company = await runInvestigation(pool, { question: QUESTION, branchId: null, viewer: VIEWERS.marketing, now: NOW, mode: "deterministic" });
    const visitor = await ask();
    const next = await runInvestigation(pool, { question: QUESTION, branchId: null, viewer: VIEWERS.marketing, now: NOW, mode: "deterministic" });
    expect(new Set([company.id, visitor.id, next.id]).size).toBe(3);
    expect(visitor.id).toBeGreaterThan(company.id);
    expect(next.id).toBeGreaterThan(visitor.id);
    // The company's own list never shows the visitor's.
    expect((await listInvestigations(pool, VIEWERS.marketing)).map((i) => i.id)).not.toContain(visitor.id);
  });

  it("is unreadable after 24 hours and gone, with its steps, after the next cleanup", async () => {
    const out = await ask();
    await pool.query("update workspace_investigations set workspace_started_at = now() - interval '25 hours' where id = $1", [out.id]);
    expect(await getInvestigation(pool, A, out.id)).toBeNull();
    await deleteExpiredWorkspace(pool);
    expect(await n("workspace_investigations where id = $1", [out.id])).toBe(0);
    expect(await n("workspace_investigation_steps where investigation_id = $1", [out.id])).toBe(0);
  });

  it("\"Delete it now\" removes it and its steps", async () => {
    const out = await ask();
    await deleteOwnInvestigation(pool, A, out.id);
    expect(await n("workspace_investigations where id = $1", [out.id])).toBe(0);
    expect(await n("workspace_investigation_steps where investigation_id = $1", [out.id])).toBe(0);
  });

  it("refuses the 31st start in a minute", async () => {
    const s = new Date().getUTCSeconds();
    if (s > 45) await new Promise((r) => setTimeout(r, (61 - s) * 1000));
    await pool.query("insert into workspace_quota (kind, bucket, starts_at, items) values ('investigation', 'minute', date_trunc('minute', now()), 29)");
    await ask();
    await expect(ask(B)).rejects.toMatchObject({ status: 429, message: "The public demo is at capacity for questions. Try again in a minute." });
  });

  it("leaves inquiries and notes closed to the guest", async () => {
    await expect(openCacInquiry(pool, A, { branchId: "B09", now: NOW })).rejects.toBeInstanceOf(ForbiddenError);
    await expect(addInquiryNote(pool, A, { id: 1, text: "a note", now: NOW })).rejects.toBeInstanceOf(ForbiddenError);
  });

  it("needs the visitor's own token: nothing is stored under the token-less guest", async () => {
    await expect(ask(workspaceViewer(null))).rejects.toThrow(/its own token/);
  });
});
