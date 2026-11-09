// A chat sentence goes to the receptionist (engine/chat.ts, WP8), which
// routes it to a new invoice, an open invoice, an open dispute, or a plain
// reply. A routed sentence becomes one skill run, stored like any other.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { handleChat, openQuestionCards, type ChatRoute, type ChatSubject, type ChatTurn } from "@/engine/chat";
import { needsCard } from "@/engine/card";
import type { Proposal } from "@/engine/run-skill";
import type { AgentClient, PayPalReads } from "@/engine/types";
import { engineDb, loadMerchant, saveRun } from "./store";
import type { SweepOutcome } from "./sweep-run";
import { createClient } from "./clients";
import { answerQuestionsInChat } from "./store";

export interface ChatRunDeps {
  pool: Pool;
  read: PayPalReads;
  agent: AgentClient;
  /** Open invoices and disputes the merchant might mean. Unset or failing = new invoices only. */
  subjects?: () => Promise<ChatSubject[]>;
  /** Makes this week's brief now (the weekly-brief sweep). Unset = the chat says where to find it. */
  weeklyBrief?: () => Promise<SweepOutcome>;
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

  // A client the merchant gave in chat goes in Pyp's list (never PayPal), source "chat".
  const saveClient = async (c: { name: string; email: string }) =>
    (await createClient(deps.pool, merchantId, { name: c.name, email: c.email }, "chat")) ? ("saved" as const) : ("exists" as const);
  const chat = await handleChat({ message, chatId: randomUUID(), subjects, history, saveClient, ctx, agent: deps.agent, signal });
  const savedLine = chat.savedClient?.status === "saved" && chat.route !== "add_client" ? `Saved ${chat.savedClient.name} to your clients. ` : "";
  // Answered here: the question cards Pyp asked in this chat leave "Needs you".
  if (chat.continues && !(chat.run && chat.run.status !== "ok")) {
    await answerQuestionsInChat(deps.pool, merchantId, openQuestionCards(history), message).catch(() => undefined);
  }
  if (chat.route === "weekly_brief") return { runId: null, route: chat.route, status: "ok", ...(await weeklyBrief(deps)) };
  const result = chat.run;
  if (!result || !chat.subject) {
    return { runId: null, cardIds: [], route: chat.route, status: rules.killSwitch ? "paused" : "ok", reply: savedLine + chat.reply, waiting: chat.route !== "add_client" };
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
        : nothingMade(invalid.filter((r): r is string => !!r), result.response?.summary);
  const waiting = result.status !== "ok" || !carded.length || carded.every((p) => p.action.command === "merchant.ask");
  return { runId, cardIds, route: chat.route, status: result.status, reply: savedLine + reply, waiting };
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

const BRIEF_SCHEDULE = "Pyp also sends one to your Inbox every Friday on its own.";

/** "Make my weekly brief": run the brief now and say where it went. */
async function weeklyBrief(deps: ChatRunDeps): Promise<{ reply: string; cardIds: string[]; waiting: boolean }> {
  if (!deps.weeklyBrief) return { reply: `Your weekly brief is on the Weekly brief page. ${BRIEF_SCHEDULE}`, cardIds: [], waiting: false };
  const out = await deps.weeklyBrief().catch(() => null);
  return { reply: briefReply(out), cardIds: out?.status === "ok" ? out.cardIds : [], waiting: false };
}

/** What the chat says after making the brief (null: the sweep threw). */
export function briefReply(out: SweepOutcome | null): string {
  if (!out) return "I couldn't make the brief just now. Try again in a moment.";
  if (out.status === "paused") return "Pyp is paused. Turn it back on in Setup to make a brief.";
  if (out.status === "busy") return "Pyp is already running a check. Try again in a minute.";
  if (out.cardIds.length) return `This week's brief is in your Inbox. ${BRIEF_SCHEDULE}`;
  if (out.skipped) return `This week's brief is already in your Inbox. ${BRIEF_SCHEDULE}`;
  if (out.failed.length) return "I couldn't make the brief just now. Try again in a moment.";
  return `The brief is ready on the Weekly brief page. ${BRIEF_SCHEDULE}`;
}

/** The chat line when a run made no card: the code's reason in a sentence, or the model's summary. */
export function nothingMade(reasons: string[], summary?: string): string {
  if (!reasons.length) return (summary ?? "").trim() || "There's nothing to do on that right now.";
  const why = reasons.map((r) => r.charAt(0).toLowerCase() + r.slice(1).replace(/[.]$/, "")).join("; ");
  return `I didn't set anything up: ${why}.`;
}
