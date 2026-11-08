// A chat sentence goes to the receptionist (engine/chat.ts, WP8), which
// routes it to a new invoice, an open invoice, an open dispute, or a plain
// reply. A routed sentence becomes one skill run, stored like any other.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { handleChat, type ChatRoute, type ChatSubject, type ChatTurn } from "@/engine/chat";
import { needsCard } from "@/engine/card";
import type { Proposal } from "@/engine/run-skill";
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
  /**
   * True while Pyp still needs more from the merchant: just a reply, a question card,
   * or nothing made. The browser keeps it on Pyp's line, so the next message can be
   * read together with the earlier ones (engine/chat.ts requestWithFollowUps).
   */
  waiting: boolean;
}

export async function runChatMessage(
  deps: ChatRunDeps,
  merchantId: string,
  message: string,
  signal?: AbortSignal,
  history: ChatTurn[] = [],
): Promise<ChatRunOutcome> {
  const { merchant, rules } = await loadMerchant(deps.pool, merchantId);
  const ctx = { merchant, rules, read: deps.read, db: engineDb(deps.pool, merchantId), now: deps.now ?? (() => new Date()) };
  // A PayPal hiccup listing open items shouldn't stop a new invoice.
  const subjects = deps.subjects ? await deps.subjects().catch(() => []) : [];

  const chat = await handleChat({ message, chatId: randomUUID(), subjects, history, ctx, agent: deps.agent, signal });
  const result = chat.run;
  if (!result || !chat.subject) {
    return { runId: null, cardIds: [], route: chat.route, status: rules.killSwitch ? "paused" : "ok", reply: chat.reply, waiting: true };
  }

  const skill = chat.subject.kind === "dispute" ? "disputes" : "collections";
  // The receptionist's call and steps are part of this run: its cost, then its routing on the trace.
  const stored = { ...result, usage: chat.usage, trace: [...chat.trace, ...result.trace] };
  const { runId, cardIds } = await saveRun(deps.pool, { merchantId, skill, subject: chat.subject, trigger: "chat", result: stored });

  const invalid = result.proposals.filter((p) => p.status === "invalid").map((p) => p.check.reason);
  const carded = result.proposals.filter(needsCard);
  const reply =
    result.status !== "ok"
      ? `Pyp couldn't finish that: ${result.failure ?? result.status}`
      : cardIds.length
        ? `${result.response!.summary} ${whereItWent(carded)}`.trim()
        : `Pyp didn't make a card. ${invalid.length ? `It held back because: ${invalid.join("; ")}` : (result.response?.summary ?? "")}`.trim();
  const waiting = result.status !== "ok" || !carded.length || carded.every((p) => p.action.command === "merchant.ask");
  return { runId, cardIds, route: chat.route, status: result.status, reply, waiting };
}

/**
 * The line after Pyp's reply that says where the card went. A question can be
 * answered right in the chat (the next message is read with this one); anything
 * else waits in the Inbox.
 */
export function whereItWent(carded: Proposal[]): string {
  if (!carded.length) return "";
  if (carded.some((p) => p.status === "awaiting_approval" && p.action.command !== "merchant.ask")) {
    return "It's in your Inbox, waiting for your approval.";
  }
  if (carded.some((p) => p.status === "scheduled")) return "It's in your Inbox and runs on its own unless you tap Undo.";
  return "Just reply here.";
}
