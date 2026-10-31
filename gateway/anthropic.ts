// Claude adapter (evals and the demo). One structured call per run: the
// response schema goes in output_config.format, so the API forces the answer
// to match it. Stall timers abort a call that stops streaming (design §7.7).

import Anthropic from "@anthropic-ai/sdk";
import type { AgentClient, CompletionRequest, GatewayEvent, StopReason } from "@/engine/types";
import { CLAUDE_MODELS, costUsd } from "./models";

export interface StallTimers {
  firstChunkMs: number;
  nextChunkMs: number;
}

const DEFAULT_STALL: StallTimers = { firstChunkMs: 45_000, nextChunkMs: 20_000 };

export class AnthropicAgentClient implements AgentClient {
  readonly name = "anthropic";

  constructor(
    private readonly client: Anthropic = new Anthropic(),
    private readonly models = CLAUDE_MODELS,
    private readonly stall: StallTimers = DEFAULT_STALL,
  ) {}

  async *complete(req: CompletionRequest): AsyncIterable<GatewayEvent> {
    const model = this.models[req.tier];
    const abort = new AbortController();
    const onOuterAbort = () => abort.abort(req.signal?.reason);
    req.signal?.addEventListener("abort", onOuterAbort, { once: true });

    let stalled = false;
    let timer = setTimeout(() => ((stalled = true), abort.abort()), this.stall.firstChunkMs);
    const bump = () => {
      clearTimeout(timer);
      timer = setTimeout(() => ((stalled = true), abort.abort()), this.stall.nextChunkMs);
    };

    try {
      const stream = this.client.beta.messages.stream(
        {
          model,
          max_tokens: req.maxOutputTokens,
          // The system prompt is identical across runs of a skill, so mark it for caching.
          system: [{ type: "text", text: req.system, cache_control: { type: "ephemeral" } }],
          messages: [{ role: "user", content: req.turn }],
          output_config: {
            format: { type: "json_schema", schema: req.schema },
            ...(req.effort ? { effort: req.effort } : {}),
          },
          // If a safety classifier declines, let the API retry on a suitable model.
          // Haiku 5.5 has no server-side fallback, so it's left out there.
          ...(req.tier === "fast" ? {} : { betas: ["server-side-fallback-2026-07-01"], fallbacks: "default" as const }),
        },
        { signal: abort.signal },
      );

      for await (const event of stream) {
        bump();
        if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
          yield { type: "chunk", text: event.delta.text };
        }
      }

      const message = await stream.finalMessage();
      const text = message.content
        .filter((b): b is Anthropic.Beta.BetaTextBlock => b.type === "text")
        .map((b) => b.text)
        .join("");
      const u = message.usage;
      const usage = {
        inputTokens: u.input_tokens,
        outputTokens: u.output_tokens,
        cacheReadTokens: u.cache_read_input_tokens ?? 0,
        cacheWriteTokens: u.cache_creation_input_tokens ?? 0,
      };
      yield {
        type: "done",
        text,
        model: message.model,
        usage: { ...usage, costUsd: costUsd(message.model, usage) },
        stopReason: mapStop(message.stop_reason),
      };
    } catch (err) {
      if (stalled) throw new Error(`Claude stalled (no data from ${model})`);
      throw err;
    } finally {
      clearTimeout(timer);
      req.signal?.removeEventListener("abort", onOuterAbort);
    }
  }
}

function mapStop(reason: string | null): StopReason {
  if (reason === "end_turn") return "end";
  if (reason === "max_tokens") return "max_tokens";
  if (reason === "refusal") return "refusal";
  return "other";
}
