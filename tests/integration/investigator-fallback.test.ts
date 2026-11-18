import Anthropic from "@anthropic-ai/sdk";
import type { Pool } from "pg";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { runInvestigation } from "@/lib/ai/investigate";
import { ANTHROPIC_PROFILE, ollamaProfile, type FallbackClass, type ModelClient } from "@/lib/ai/model";
import { VIEWERS } from "@/lib/viewer";
import { freshDb, one, testPool } from "../helpers";

/**
 * Every way a model run can fail falls back to the deterministic investigator, and the stored
 * result says which way, in a class (release design §5.9). A class of "other" is reserved for the
 * unrecognised: a failure the tests expect must never land there.
 */

const pool: Pool = testPool();
const NOW = new Date("2026-10-31T13:00:00Z");
const QUESTION = "What is paid CAC?";
const { marketing } = VIEWERS;

type Message = Anthropic.Beta.Messages.BetaMessage;
const message = (content: Message["content"], stop: Message["stop_reason"] = "tool_use", usage: Message["usage"] | undefined = undefined): Message =>
  ({ id: "msg", type: "message", role: "assistant", model: "claude-opus-5-5", content, stop_reason: stop, stop_sequence: null, ...(usage ? { usage } : {}) }) as unknown as Message;
const toolUse = (id: string, name: string, input: unknown) => ({ type: "tool_use", id, name, input }) as unknown as Message["content"][number];

const findings = (evidenceId: string) => ({
  summary: "Paid CAC is paid media spend divided by new customers whose first evidenced touch was paid.",
  observations: [{ text: "The definition of paid CAC was read from the metric registry.", evidenceIds: [evidenceId], status: "hypothesis", strength: "weak" }],
  suspectedCause: null,
  confidence: { level: "low", why: "definition only" },
  recommendedNextAction: "Look at a branch.",
  expectedEffect: "None.",
  risks: [],
  missingInformation: [],
  proposals: [],
});

/** A client that answers from a script, one message per request, or throws what it is given. */
function scripted(replies: Array<Message | Error>): ModelClient {
  let i = 0;
  return {
    create: async () => {
      const next = replies[Math.min(i++, replies.length - 1)];
      if (next instanceof Error) throw next;
      return next;
    },
  };
}

const api = (status: number) => Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message: `status ${status}` } }, `status ${status}`, new Headers());

beforeAll(async () => {
  await freshDb(pool);
});
afterAll(async () => {
  await pool.end();
});

async function stored(id: number) {
  return one<{ mode: string; model: string | null; fallback: { class: string; message: string } | null; label: string }>(
    pool,
    "select mode, model, result -> 'fallback' as fallback, result ->> 'modeLabel' as label from investigations where id = $1",
    [id],
  );
}

describe("a failed model run falls back, and says why", () => {
  const cases: Array<[string, ModelClient, FallbackClass]> = [
    ["a timeout", { create: (_p, o) => new Promise((_r, reject) => o?.signal?.addEventListener("abort", () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })))) }, "timeout"],
    ["a 429", scripted([api(429)]), "rate_limited"],
    ["a 401", scripted([api(401)]), "auth"],
    ["a 400", scripted([api(400)]), "bad_request"],
    ["an unreachable host", scripted([new Anthropic.APIConnectionError({ message: "connect ECONNREFUSED" })]), "unreachable"],
    ["schema-invalid findings, three times", scripted([message([toolUse("a", "submit_findings", { summary: "incomplete" })])]), "invalid_output"],
    ["a draft whose every statement the evidence check drops", scripted([message([toolUse("a", "submit_findings", findings("exception:999999"))])]), "no_verified_statement"],
  ];

  for (const [name, client, expected] of cases) {
    it(`${name} → the deterministic answer, stored with the class "${expected}"`, async () => {
      const out = await runInvestigation(pool, { question: QUESTION, branchId: null, viewer: marketing, now: NOW, client, limits: { timeoutMs: 200, maxTurns: 4 } });
      expect(out.mode).toBe("deterministic");
      expect(out.result.fallback?.class).toBe(expected);
      expect(out.result.modeLabel).toMatch(/^The model .+, so this answer came from the deterministic evidence path\.$/);
      const row = await stored(out.id);
      expect(row).toMatchObject({ mode: "deterministic", model: "claude-opus-5-5", fallback: { class: expected } });
    });
  }

  it("an unrecognised error is 'other', logged with its stack", async () => {
    const log = vi.spyOn(console, "error").mockImplementation(() => {});
    const out = await runInvestigation(pool, { question: QUESTION, branchId: null, viewer: marketing, now: NOW, client: scripted([new TypeError("x is undefined")]) });
    expect(out.result.fallback).toEqual({ class: "other", message: "failed unexpectedly (TypeError: x is undefined)" });
    expect(log.mock.calls.some(([line]) => String(line).includes("model request failed unexpectedly") && String(line).includes("stack"))).toBe(true);
    log.mockRestore();
  });

  it("a local model names itself in the fallback, and is never priced", async () => {
    const out = await runInvestigation(pool, { question: QUESTION, branchId: null, viewer: marketing, now: NOW, client: scripted([api(429)]), profile: ollamaProfile("qwen3:8b") });
    expect(out.result.modeLabel).toBe("The local model was rate limited, so this answer came from the deterministic evidence path.");
    expect((await stored(out.id)).model).toBe("ollama:qwen3:8b");
    expect(out.costMicros).toBe(0);
  });
});

describe("a model answer stands", () => {
  it("a response without usage keeps the model's answer, at zero tokens", async () => {
    const client = scripted([
      message([toolUse("a", "getMetricDefinition", { key: "paidCac" })]),
      message([toolUse("b", "submit_findings", findings("metric_definition:paidCac"))]),
    ]);
    const out = await runInvestigation(pool, { question: QUESTION, branchId: null, viewer: marketing, now: NOW, client, profile: ANTHROPIC_PROFILE });
    expect(out.mode).toBe("model");
    expect(out.result.fallback).toBeUndefined();
    expect(out.result.modeLabel).toBe("Answered by claude-opus-5-5");
    expect(out.usage).toEqual({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0 });
    expect(out.costMicros).toBe(0);
  });
});
