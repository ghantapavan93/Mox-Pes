import Anthropic from "@anthropic-ai/sdk";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ANTHROPIC_PROFILE, ModelConfigError, classifyModelError, configuredProfile, modelClientFromEnv, ollamaProfile } from "@/lib/ai/model";

/**
 * Which model the investigator uses, what it sends each one, and how a failure is named (release
 * design §5.9). The Ollama client must never carry a credential from the environment, and only
 * a model on this machine may receive the records.
 */

const base = { system: "system prompt", tools: [] as Anthropic.Beta.Messages.BetaTool[], messages: [{ role: "user" as const, content: "What is paid CAC?" }] };

afterEach(() => vi.unstubAllGlobals());

describe("which setting wins", () => {
  it("AI_INVESTIGATOR_MODE=deterministic, then the Ollama provider, then an Anthropic key, else no model", () => {
    const key = "sk-ant-test-key";
    expect(configuredProfile({ AI_INVESTIGATOR_MODE: "deterministic", AI_INVESTIGATOR_PROVIDER: "ollama", ANTHROPIC_API_KEY: key })).toBeNull();
    expect(configuredProfile({ AI_INVESTIGATOR_PROVIDER: "ollama", ANTHROPIC_API_KEY: key })).toMatchObject({ provider: "ollama", model: "ollama:qwen3:8b", name: "qwen3:8b", priced: false });
    expect(configuredProfile({ AI_INVESTIGATOR_PROVIDER: "ollama", OLLAMA_MODEL: "llama3.2:3b" })?.model).toBe("ollama:llama3.2:3b");
    expect(configuredProfile({ ANTHROPIC_API_KEY: key })).toBe(ANTHROPIC_PROFILE);
    expect(configuredProfile({})).toBeNull();
    expect(modelClientFromEnv({})).toBeNull();
  });

  it("refuses an Ollama host that is not this machine", () => {
    for (const host of ["http://localhost:11434", "http://127.0.0.1:11434", "http://[::1]:11434"]) {
      expect(configuredProfile({ AI_INVESTIGATOR_PROVIDER: "ollama", OLLAMA_BASE_URL: host })?.provider).toBe("ollama");
    }
    for (const host of ["http://192.168.1.20:11434", "https://ollama.example.com", "http://localhost.example.com:11434", "not a url"]) {
      expect(() => modelClientFromEnv({ AI_INVESTIGATOR_PROVIDER: "ollama", OLLAMA_BASE_URL: host }), host).toThrow(ModelConfigError);
    }
  });
});

describe("what each profile sends", () => {
  it("Anthropic: adaptive thinking, effort, a cached system prompt and the default refusal fallback", () => {
    expect(ANTHROPIC_PROFILE.request(base)).toMatchObject({
      model: "claude-opus-5-5",
      thinking: { type: "adaptive" },
      output_config: { effort: "medium" },
      system: [{ type: "text", text: "system prompt", cache_control: { type: "ephemeral" } }],
      tool_choice: { type: "auto" },
      betas: ["server-side-fallback-2026-07-01"],
      fallbacks: "default",
    });
  });

  it("Ollama: the plain request, with none of the Anthropic-only fields", () => {
    const request = ollamaProfile("qwen3:8b").request(base) as unknown as Record<string, unknown>;
    expect(request).toMatchObject({ model: "qwen3:8b", system: "system prompt", tool_choice: { type: "auto" } });
    for (const field of ["thinking", "output_config", "betas", "fallbacks", "cache_control"]) expect(request, field).not.toHaveProperty(field);
    expect(ollamaProfile("qwen3:8b")).toMatchObject({ perRequestMs: 45_000, totalMs: 90_000 });
  });

  it("the Ollama client sends its placeholder key to this machine's /v1/messages, never the Anthropic key", async () => {
    const sent: Array<{ url: string; headers: Headers; body: Record<string, unknown> }> = [];
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      sent.push({ url: String(input), headers: new Headers(init?.headers), body: JSON.parse(String(init?.body)) });
      const message = { id: "msg_1", type: "message", role: "assistant", model: "qwen3:8b", content: [{ type: "text", text: "ok" }], stop_reason: "end_turn", stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } };
      return new Response(JSON.stringify(message), { status: 200, headers: { "content-type": "application/json" } });
    });
    const configured = modelClientFromEnv({ AI_INVESTIGATOR_PROVIDER: "ollama", ANTHROPIC_API_KEY: "sk-ant-real-secret", ANTHROPIC_AUTH_TOKEN: "oauth-secret" })!;
    const reply = await configured.client.create(configured.profile.request(base));
    expect(reply.content[0]).toMatchObject({ type: "text", text: "ok" });
    expect(sent).toHaveLength(1);
    expect(new URL(sent[0].url)).toMatchObject({ host: "localhost:11434", pathname: "/v1/messages" });
    // SDK 1.x sends the key as a bearer token.
    expect(sent[0].headers.get("authorization")).toBe("Bearer ollama");
    const all = [...sent[0].headers.entries()].map(([k, v]) => `${k}: ${v}`).join("\n");
    expect(all).not.toContain("sk-ant-real-secret");
    expect(all).not.toContain("oauth-secret");
    expect(sent[0].headers.get("anthropic-beta")).toBeNull();
    expect(sent[0].body).not.toHaveProperty("thinking");
  });
});

describe("failures, named", () => {
  const api = (status: number) => Anthropic.APIError.generate(status, { type: "error", error: { type: "x", message: `status ${status}` } }, `status ${status}`, new Headers());

  it("maps every typed SDK error to its class and never throws", () => {
    expect(classifyModelError(api(429)).class).toBe("rate_limited");
    expect(classifyModelError(api(401)).class).toBe("auth");
    expect(classifyModelError(api(403)).class).toBe("auth");
    expect(classifyModelError(api(400)).class).toBe("bad_request");
    expect(classifyModelError(api(404)).class).toBe("bad_request");
    expect(classifyModelError(api(529)).class).toBe("unreachable");
    expect(classifyModelError(new Anthropic.APIConnectionTimeoutError()).class).toBe("timeout");
    expect(classifyModelError(new Anthropic.APIUserAbortError()).class).toBe("timeout");
    expect(classifyModelError(new Anthropic.APIConnectionError({ message: "connection refused" })).class).toBe("unreachable");
    expect(classifyModelError(Object.assign(new Error("aborted"), { name: "AbortError" })).class).toBe("timeout");
  });

  it("calls anything unrecognised 'other', so a defect never passes as a quiet fallback", () => {
    expect(classifyModelError(new TypeError("Cannot read properties of undefined"))).toEqual({ class: "other", message: "failed unexpectedly (TypeError: Cannot read properties of undefined)" });
    expect(classifyModelError("a string").class).toBe("other");
  });
});
