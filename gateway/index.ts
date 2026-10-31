// Pick the model connection from the environment. Switching providers is a
// change here, nowhere else (ADR-007).
//
//   PYP_MODEL_PROVIDER=anthropic   Claude (needs ANTHROPIC_API_KEY)
//   PYP_MODEL_PROVIDER=ollama      local model (needs OLLAMA_MODEL; OLLAMA_BASE_URL, OLLAMA_THINK optional)
//   unset                          anthropic if ANTHROPIC_API_KEY is set, else ollama

import type { AgentClient } from "@/engine/types";
import { AnthropicAgentClient } from "./anthropic";
import { MemoryLedger, withBudget, type SpendLedger } from "./budget";
import { OllamaAgentClient } from "./ollama";

export { AnthropicAgentClient } from "./anthropic";
export { BudgetExceeded, MemoryLedger, withBudget, type SpendLedger } from "./budget";
export { OllamaAgentClient } from "./ollama";
export { ScriptedAgentClient, type ScriptedAnswer } from "./scripted";

export function createAgentClient(
  env: Record<string, string | undefined> = process.env,
  ledger: SpendLedger = new MemoryLedger(),
): AgentClient {
  const provider = env.PYP_MODEL_PROVIDER || (env.ANTHROPIC_API_KEY ? "anthropic" : "ollama");

  if (provider === "anthropic") {
    if (!env.ANTHROPIC_API_KEY) throw new Error("PYP_MODEL_PROVIDER=anthropic needs ANTHROPIC_API_KEY");
    const cap = Number(env.SPEND_CAP_USD ?? "5");
    if (!Number.isFinite(cap) || cap <= 0) throw new Error("SPEND_CAP_USD must be a positive number");
    return withBudget(new AnthropicAgentClient(), ledger, cap);
  }
  if (provider === "ollama") {
    if (!env.OLLAMA_MODEL) throw new Error("Set OLLAMA_MODEL (for example qwen3:4b) or ANTHROPIC_API_KEY");
    const think = env.OLLAMA_THINK === "true" ? true : env.OLLAMA_THINK === "default" ? null : false;
    return new OllamaAgentClient(env.OLLAMA_MODEL, { baseUrl: env.OLLAMA_BASE_URL, think });
  }
  throw new Error(`Unknown PYP_MODEL_PROVIDER: ${provider}`);
}
