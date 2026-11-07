// Helpers for the gateway's event stream.

import type { GatewayEvent } from "./types";

/** Drain a gateway stream into its final answer. */
export async function collect(events: AsyncIterable<GatewayEvent>) {
  for await (const ev of events) {
    if (ev.type === "done") return ev;
  }
  throw new Error("The model stream ended without an answer");
}

/**
 * The "summary" the model was writing, read from raw (possibly cut-off or
 * malformed) JSON, so the trace can still say what it was going to propose
 * (design §7.7). For the trace only: never parsed into actions.
 */
export function partialSummary(raw: string, max = 400): string | null {
  const m = /"summary"\s*:\s*"((?:[^"\\]|\\.)*)/.exec(raw);
  if (!m) return null;
  let text: string;
  try {
    text = JSON.parse(`"${m[1].replace(/\\$/, "")}"`);
  } catch {
    text = m[1];
  }
  text = text.trim();
  if (!text) return null;
  return text.length > max ? `${text.slice(0, max)}…` : text;
}
