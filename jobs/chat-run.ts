// A chat sentence goes to the receptionist (engine/chat.ts, WP8), which
// routes it to a new invoice, an open invoice, an open dispute, or a plain
// reply. A routed sentence becomes one skill run, stored like any other.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { handleChat, type ChatRoute, type ChatSubject } from "@/engine/chat";
import type { AgentClient, PayPalReads } from "@/engine/types";
import { engineDb, loadMerchant, saveRun } from "./store";

export interface ChatRunDeps {
  pool: Pool;
  read: PayPalReads;
  agent: AgentClient;
  /** Open invoices and disputes the merchant might mean. Unset or failing = new invoices only. */
  subjects?: () => Promise<ChatSubject[]>;
  now?: () => Date;
}

export interface ChatRunOutcome {
  /** Null when the message only got a reply (nothing ran). */
  runId: string | null;
  cardIds: string[];
  route: ChatRoute;
  status: "ok" | "paused" | "failed";
  /** What to say in the chat. */
  reply: string;
}

export async function runChatMessage(deps: ChatRunDeps, merchantId: string, message: string, signal?: AbortSignal): Promise<ChatRunOutcome> {
  const { merchant, rules } = await loadMerchant(deps.pool, merchantId);
  const ctx = { merchant, rules, read: deps.read, db: engineDb(deps.pool, merchantId), now: deps.now ?? (() => new Date()) };
  // A PayPal hiccup listing open items shouldn't stop a new invoice.
  const subjects = deps.subjects ? await deps.subjects().catch(() => []) : [];

  const chat = await handleChat({ message, chatId: randomUUID(), subjects, ctx, agent: deps.agent, signal });
  const result = chat.run;
  if (!result || !chat.subject) {
    return { runId: null, cardIds: [], route: chat.route, status: rules.killSwitch ? "paused" : "ok", reply: chat.reply };
  }

  const skill = chat.subject.kind === "dispute" ? "disputes" : "collections";
  // The receptionist's call and steps are part of this run: its cost, then its routing on the trace.
  const stored = { ...result, usage: chat.usage, trace: [...chat.trace, ...result.trace] };
  const { runId, cardIds } = await saveRun(deps.pool, { merchantId, skill, subject: chat.subject, trigger: "chat", result: stored });

  const invalid = result.proposals.filter((p) => p.status === "invalid").map((p) => p.check.reason);
  const reply =
    result.status !== "ok"
      ? `Pyp couldn't finish that: ${result.failure ?? result.status}`
      : cardIds.length
        ? result.response!.summary
        : `Pyp didn't make a card. ${invalid.length ? `It held back because: ${invalid.join("; ")}` : (result.response?.summary ?? "")}`.trim();
  return { runId, cardIds, route: chat.route, status: result.status, reply };
}
