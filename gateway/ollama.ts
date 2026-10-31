// Ollama adapter for free local development. Uses Ollama's own /api/chat
// with the response schema as `format` (constrained decoding). Small models
// slip more often; the validator re-checks everything, so a weak model fails
// safe.

import type { AgentClient, CompletionRequest, GatewayEvent, StopReason } from "@/engine/types";

export interface OllamaOptions {
  baseUrl?: string;
  /**
   * Thinking for thinking models (qwen3, gemma4). Off by default: with it on,
   * some models put the JSON in the thinking output instead of the answer.
   * null = the model's own default.
   */
  think?: boolean | null;
  /** Context window. Ollama's default can be smaller than a case file plus the schema. */
  numCtx?: number;
  keepAlive?: string;
  fetchImpl?: typeof fetch;
}

export class OllamaAgentClient implements AgentClient {
  readonly name = "ollama";
  private readonly baseUrl: string;
  private readonly fetchImpl: typeof fetch;

  constructor(
    private readonly model: string,
    private readonly opts: OllamaOptions = {},
  ) {
    this.baseUrl = (opts.baseUrl ?? "http://localhost:11434").replace(/\/$/, "");
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async *complete(req: CompletionRequest): AsyncIterable<GatewayEvent> {
    const res = await this.fetchImpl(`${this.baseUrl}/api/chat`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      signal: req.signal,
      body: JSON.stringify({
        model: this.model,
        stream: true,
        // Ollama's constrained decoding can enforce length limits, so it gets the full schema.
        format: req.fullSchema ?? req.schema,
        think: this.opts.think === undefined ? false : this.opts.think,
        keep_alive: this.opts.keepAlive ?? "10m",
        messages: [
          // Ollama's docs recommend also showing the schema in the prompt; small models follow it better.
          { role: "system", content: `${req.system}\n<json-schema>${JSON.stringify(req.fullSchema ?? req.schema)}</json-schema>` },
          { role: "user", content: req.turn },
        ],
        options: { num_predict: req.maxOutputTokens, num_ctx: this.opts.numCtx ?? 8192, temperature: 0 },
      }),
    });
    if (!res.ok || !res.body) throw new Error(`Ollama returned ${res.status}: ${await res.text().catch(() => "")}`);

    let text = "";
    let buffered = "";
    const decoder = new TextDecoder();
    for await (const bytes of res.body as unknown as AsyncIterable<Uint8Array>) {
      buffered += decoder.decode(bytes, { stream: true });
      const lines = buffered.split("\n");
      buffered = lines.pop() ?? "";
      for (const line of lines) {
        if (!line.trim()) continue;
        const msg = JSON.parse(line) as OllamaChunk;
        if (msg.error) throw new Error(`Ollama: ${msg.error}`);
        const piece = msg.message?.content ?? "";
        if (piece) {
          text += piece;
          yield { type: "chunk", text: piece };
        }
        if (msg.done) {
          yield {
            type: "done",
            text,
            model: `ollama:${this.model}`,
            usage: {
              inputTokens: msg.prompt_eval_count ?? 0,
              outputTokens: msg.eval_count ?? 0,
              cacheReadTokens: 0,
              cacheWriteTokens: 0,
              costUsd: 0,
            },
            stopReason: mapStop(msg.done_reason),
          };
          return;
        }
      }
    }
    throw new Error("Ollama stream ended without a final message");
  }
}

interface OllamaChunk {
  message?: { content?: string };
  done?: boolean;
  done_reason?: string;
  prompt_eval_count?: number;
  eval_count?: number;
  error?: string;
}

function mapStop(reason: string | undefined): StopReason {
  if (reason === "stop") return "end";
  if (reason === "length") return "max_tokens";
  return "other";
}
