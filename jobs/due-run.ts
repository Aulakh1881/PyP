// The worker's tick (design §8.3, §9.3): runs every scheduled proposal whose
// time has come.
//
// - An Auto action (a reminder on Auto, say) whose undo window has passed goes
//   through the executor, which re-checks it against PayPal before writing.
// - A follow-up (invoice.scheduleFollowUp) that falls due starts a fresh
//   Collections run on its invoice. That run makes its own cards, so a paid or
//   held invoice simply gets nothing.
//
// The executor is passed in, so this file never touches the PayPal write client.

import type { Pool } from "pg";
import { getSkill } from "@/engine/registry";
import { runSkill } from "@/engine/run-skill";
import type { AgentClient, PayPalReads, SubjectRef } from "@/engine/types";
import { claimDue, engineDb, finish, FOLLOW_UP, loadMerchant, saveRun, type DueProposal } from "./store";

export interface DueRunDeps {
  pool: Pool;
  read: PayPalReads;
  agent: AgentClient;
  /** executor/execute.ts's executeProposal, bound to its write client. */
  execute: (merchantId: string, proposal: DueProposal) => Promise<{ status: string; message: string }>;
  now?: () => Date;
}

export interface DueRunResult {
  proposalId: string;
  commandId: string;
  status: string;
  message: string;
}

export async function runDueWork(deps: DueRunDeps, limit = 20): Promise<DueRunResult[]> {
  const now = deps.now ?? (() => new Date());
  const due = await claimDue(deps.pool, now(), limit);
  const results: DueRunResult[] = [];
  for (const p of due) {
    // One proposal failing never stops the others.
    const out = await (p.commandId === FOLLOW_UP ? followUp(deps, p, now) : deps.execute(p.merchantId, p)).catch(async (err: Error) => {
      await finish(deps.pool, { merchantId: p.merchantId, proposal: p, status: "failed", label: `Error: ${err.message}`, ok: false, reason: err.message });
      return { status: "failed", message: err.message };
    });
    results.push({ proposalId: p.id, commandId: p.commandId, ...out });
  }
  return results;
}

async function followUp(deps: DueRunDeps, p: DueProposal, now: () => Date) {
  const [kind, ...rest] = p.subjectRef.split(":");
  const subject: SubjectRef = { kind, id: rest.join(":") };
  const { merchant, rules } = await loadMerchant(deps.pool, p.merchantId);
  const ctx = { merchant, rules, read: deps.read, db: engineDb(deps.pool, p.merchantId), now };
  const result = await runSkill({ skill: getSkill("collections"), subject, ctx, agent: deps.agent, trigger: "follow-up" });
  const { cardIds } = await saveRun(deps.pool, { merchantId: p.merchantId, skill: "collections", subject, trigger: "follow-up", result, now: now() });
  const message = cardIds.length
    ? `Followed up on invoice ${subject.id}: ${cardIds.length} new card${cardIds.length > 1 ? "s" : ""}`
    : `Followed up on invoice ${subject.id}: nothing to do`;
  await finish(deps.pool, { merchantId: p.merchantId, proposal: p, status: "executed", label: message, ok: true });
  return { status: "executed", message };
}
