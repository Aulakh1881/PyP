// Scripted adapter: replays fixed answers. Makes tests deterministic and lets
// the demo run with no network if it has to (design §7.7).

import type { AgentClient, CompletionRequest, GatewayEvent, StopReason } from "@/engine/types";

/** An answer as an object (serialized for you) or raw text (to test bad output). */
export type ScriptedAnswer = object | string | { raw: string; stopReason: StopReason };

export class ScriptedAgentClient implements AgentClient {
  readonly name = "scripted";
  /** Every request received, for assertions. */
  readonly requests: CompletionRequest[] = [];
  private next = 0;

  constructor(private readonly answers: ScriptedAnswer[] | ((req: CompletionRequest) => ScriptedAnswer)) {}

  async *complete(req: CompletionRequest): AsyncIterable<GatewayEvent> {
    this.requests.push(req);
    const answer = typeof this.answers === "function" ? this.answers(req) : this.answers[this.next++];
    if (answer === undefined) throw new Error("Scripted client ran out of answers");

    const isRaw = typeof answer === "object" && answer !== null && "raw" in answer && "stopReason" in answer;
    const text = typeof answer === "string" ? answer : isRaw ? answer.raw : JSON.stringify(answer);
    const stopReason: StopReason = isRaw ? answer.stopReason : "end";

    yield { type: "chunk", text };
    yield {
      type: "done",
      text,
      model: "scripted",
      usage: { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, costUsd: 0 },
      stopReason,
    };
  }
}
