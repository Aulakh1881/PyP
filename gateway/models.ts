// Which Claude model serves each tier, and what it costs (design §7.7).
// Prices are USD per million tokens, from Anthropic's model table as of
// Oct 2026. Recheck before quoting any cost (master plan §3, item 6).

import type { Tier, Usage } from "@/engine/types";

export const CLAUDE_MODELS: Record<Tier, string> = {
  fast: "claude-haiku-5-5", // quarantine, triage, Insights wording
  main: "claude-sonnet-5-5", // Collections, chat
  deep: "claude-opus-5-5", // Disputes
};

interface Price {
  input: number;
  output: number;
  cacheRead: number;
  cacheWrite: number; // 5-minute cache writes cost 1.25x input
}

const PRICES: Record<string, Price> = {
  "claude-haiku-5-5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  // A server-side fallback can answer on another model; price it like Opus 5.5 when unknown.
};
const UNKNOWN_PRICE: Price = PRICES["claude-opus-5-5"];

export function priceFor(model: string): Price {
  return PRICES[model] ?? UNKNOWN_PRICE;
}

export function costUsd(model: string, u: Omit<Usage, "costUsd">): number {
  const p = priceFor(model);
  return (
    (u.inputTokens * p.input + u.outputTokens * p.output + u.cacheReadTokens * p.cacheRead + u.cacheWriteTokens * p.cacheWrite) /
    1_000_000
  );
}

/** Tokens a file costs to read, generously: an image up to ~1,600; a PDF page, its text plus an image of the page. */
export const IMAGE_TOKENS = 2_000;
export const PDF_PAGE_TOKENS = 3_500;

/** A deliberately high estimate for reserving budget before a call: every input token uncached, every output token used. */
export function estimateUsd(model: string, inputChars: number, maxOutputTokens: number, attachmentTokens = 0): number {
  const p = priceFor(model);
  const inputTokens = Math.ceil(inputChars / 3) + attachmentTokens;
  return (inputTokens * Math.max(p.input, p.cacheWrite) + maxOutputTokens * p.output) / 1_000_000;
}
