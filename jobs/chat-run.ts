// A chat sentence becomes one Collections run (engine README §4): subject
// "new-invoice:<message id>", the sentence as the instruction. Until the
// receptionist (WP8) routes chat to the right skill, every message goes here.

import { randomUUID } from "node:crypto";
import type { Pool } from "pg";
import { getSkill } from "@/engine/registry";
import { runSkill } from "@/engine/run-skill";
import type { AgentClient, PayPalReads } from "@/engine/types";
import { engineDb, loadMerchant, saveRun } from "./store";

export interface ChatRunDeps {
  pool: Pool;
  read: PayPalReads;
  agent: AgentClient;
  now?: () => Date;
}

export interface ChatRunOutcome {
  runId: string;
  cardIds: string[];
  status: "ok" | "paused" | "failed";
  /** What to say in the chat: the model's summary, or why nothing came of it. */
  reply: string;
}

export async function runChatMessage(deps: ChatRunDeps, merchantId: string, message: string, signal?: AbortSignal): Promise<ChatRunOutcome> {
  const skill = getSkill("collections");
  const subject = { kind: "new-invoice", id: randomUUID() };
  const { merchant, rules } = await loadMerchant(deps.pool, merchantId);
  const ctx = { merchant, rules, read: deps.read, db: engineDb(deps.pool, merchantId), now: deps.now ?? (() => new Date()) };

  const result = await runSkill({ skill, subject, ctx, agent: deps.agent, trigger: "chat", instruction: message, signal });
  const { runId, cardIds } = await saveRun(deps.pool, { merchantId, skill: skill.id, subject, trigger: "chat", result });

  const invalid = result.proposals.filter((p) => p.status === "invalid").map((p) => p.check.reason);
  const reply =
    result.status !== "ok"
      ? `Pyp couldn't finish that: ${result.failure ?? result.status}`
      : cardIds.length
        ? result.response!.summary
        : `Pyp didn't make a card. ${invalid.length ? `It held back because: ${invalid.join("; ")}` : result.response?.summary ?? ""}`.trim();
  return { runId, cardIds, status: result.status, reply };
}
