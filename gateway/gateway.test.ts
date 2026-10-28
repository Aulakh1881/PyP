import type Anthropic from "@anthropic-ai/sdk";
import { describe, expect, it } from "vitest";
import { collect } from "@/engine/run-skill";
import type { CompletionRequest } from "@/engine/types";
import { AnthropicAgentClient } from "./anthropic";
import { BudgetExceeded, MemoryLedger, withBudget } from "./budget";
import { createAgentClient } from "./index";
import { OllamaAgentClient } from "./ollama";
import { ScriptedAgentClient } from "./scripted";

const req: CompletionRequest = {
  system: "sys",
  turn: "turn",
  schema: { type: "object" },
  tier: "main",
  effort: "low",
  maxOutputTokens: 1000,
  purpose: "test",
};

describe("budget", () => {
  it("fails closed when the cap would be exceeded, without calling the model", async () => {
    const inner = new ScriptedAgentClient([{ ok: 1 }]);
    const agent = withBudget(inner, new MemoryLedger(), 0.001);
    await expect(collect(agent.complete(req))).rejects.toBeInstanceOf(BudgetExceeded);
    expect(inner.requests).toHaveLength(0);
  });

  it("settles the reservation to the real cost", async () => {
    const ledger = new MemoryLedger();
    const agent = withBudget(new ScriptedAgentClient([{ ok: 1 }]), ledger, 5);
    await collect(agent.complete(req));
    expect(ledger.spentToday).toBe(0); // scripted calls cost nothing
  });

  it("fails closed when the ledger itself is down", async () => {
    const broken = { reserve: async () => { throw new Error("db down"); }, settle: async () => {} };
    const agent = withBudget(new ScriptedAgentClient([{ ok: 1 }]), broken, 5);
    await expect(collect(agent.complete(req))).rejects.toThrow("db down");
  });
});

describe("Anthropic adapter", () => {
  function fakeClient(capture: { params?: any }, message: object, events: object[] = []) {
    return {
      beta: {
        messages: {
          stream(params: unknown) {
            capture.params = params;
            return {
              async *[Symbol.asyncIterator]() {
                yield* events;
              },
              finalMessage: async () => message,
            };
          },
        },
      },
    } as unknown as Anthropic;
  }

  const message = {
    model: "claude-sonnet-5-5",
    stop_reason: "end_turn",
    content: [{ type: "thinking", thinking: "" }, { type: "text", text: '{"a":1}' }],
    usage: { input_tokens: 1000, output_tokens: 200, cache_read_input_tokens: 3000, cache_creation_input_tokens: 0 },
  };

  it("sends one structured call with a cached system prompt", async () => {
    const capture: { params?: any } = {};
    const done = await collect(new AnthropicAgentClient(fakeClient(capture, message)).complete(req));

    expect(capture.params).toMatchObject({
      model: "claude-sonnet-5-5",
      max_tokens: 1000,
      system: [{ type: "text", text: "sys", cache_control: { type: "ephemeral" } }],
      messages: [{ role: "user", content: "turn" }],
      output_config: { format: { type: "json_schema", schema: { type: "object" } }, effort: "low" },
      fallbacks: "default",
    });
    expect(capture.params).not.toHaveProperty("thinking");
    expect(done.text).toBe('{"a":1}');
    expect(done.stopReason).toBe("end");
    // 1000 × $2 + 200 × $10 + 3000 × $0.20, per million tokens
    expect(done.usage.costUsd).toBeCloseTo(0.0046, 6);
  });

  it("leaves server-side fallbacks off for Haiku", async () => {
    const capture: { params?: any } = {};
    await collect(new AnthropicAgentClient(fakeClient(capture, { ...message, model: "claude-haiku-5-5" })).complete({ ...req, tier: "fast" }));
    expect(capture.params.model).toBe("claude-haiku-5-5");
    expect(capture.params).not.toHaveProperty("fallbacks");
  });

  it("reports refusals so the run can stop", async () => {
    const done = await collect(new AnthropicAgentClient(fakeClient({}, { ...message, stop_reason: "refusal", content: [] })).complete(req));
    expect(done.stopReason).toBe("refusal");
  });
});

describe("Ollama adapter", () => {
  it("streams NDJSON chunks into one answer", async () => {
    const lines = [
      { message: { content: '{"a"' }, done: false },
      { message: { content: ":1}" }, done: false },
      { message: { content: "" }, done: true, done_reason: "stop", prompt_eval_count: 50, eval_count: 7 },
    ];
    const body = new ReadableStream({
      start(c) {
        // Split mid-line to prove the buffering works.
        const text = lines.map((l) => JSON.stringify(l)).join("\n") + "\n";
        c.enqueue(new TextEncoder().encode(text.slice(0, 20)));
        c.enqueue(new TextEncoder().encode(text.slice(20)));
        c.close();
      },
    });
    let sent: any;
    const fakeFetch = (async (_url: string, init: RequestInit) => {
      sent = JSON.parse(init.body as string);
      return new Response(body);
    }) as unknown as typeof fetch;

    const done = await collect(new OllamaAgentClient("qwen3:8b", { fetchImpl: fakeFetch }).complete(req));
    expect(sent).toMatchObject({ model: "qwen3:8b", format: { type: "object" }, stream: true, think: false, options: { num_ctx: 8192, temperature: 0 } });
    expect(sent.messages[0].content).toContain('<json-schema>{"type":"object"}</json-schema>');
    expect(done).toMatchObject({ text: '{"a":1}', model: "ollama:qwen3:8b", stopReason: "end", usage: { inputTokens: 50, outputTokens: 7 } });
  });
});

describe("createAgentClient", () => {
  it("picks the provider from the environment", () => {
    expect(createAgentClient({ ANTHROPIC_API_KEY: "sk-test" }).name).toBe("anthropic+budget");
    expect(createAgentClient({ OLLAMA_MODEL: "qwen3:8b" }).name).toBe("ollama");
    expect(() => createAgentClient({})).toThrow("OLLAMA_MODEL");
    expect(() => createAgentClient({ PYP_MODEL_PROVIDER: "anthropic" })).toThrow("ANTHROPIC_API_KEY");
  });
});
