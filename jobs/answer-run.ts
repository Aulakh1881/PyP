// Answering a question card (merchant.ask, design §11.3 POST /api/cards/{id}/answer).
// The merchant taps one of the buttons; the question is closed and the same
// skill runs again on the same subject with the answer as the merchant's words.
// That run makes its own cards, so an answer never writes to PayPal by itself.
//
// For a new invoice from chat the original sentence goes along too, because the
// case file is built from it ("Invoice NewCo $500" + "Done, NewCo is added").
// The model's question doesn't: code reads amounts and terms from that text,
// and "$500 or $5,000?" would put both in the merchant's mouth.
//
// The answer counts only once its run has worked. If the run fails or throws,
// the question goes back to waiting, so the merchant can tap again.

import type { Pool } from "pg";
import { getSkill } from "@/engine/registry";
import { runSkill } from "@/engine/run-skill";
import type { AgentClient, PayPalReads, SkillId, SubjectRef } from "@/engine/types";
import { MAX_REQUEST_CHARS } from "@/skills/collections/case-file";
import { addStepFor, engineDb, loadMerchant, saveRun } from "./store";

export interface AnswerDeps {
  pool: Pool;
  read: PayPalReads;
  agent: AgentClient;
  now?: () => Date;
}

export type AnswerOutcome =
  | { status: "answered"; message: string; cardIds: string[] }
  | { status: "not_waiting" | "bad_option" | "retry"; message: string };

export async function answerCard(deps: AnswerDeps, merchantId: string, cardId: string, optionIndex: number): Promise<AnswerOutcome> {
  const now = deps.now ?? (() => new Date());
  // One statement: only a waiting question of this merchant's, and only a real option.
  const res = await deps.pool.query(
    `with q as (
       update proposals p set status = 'answered', decided_by = 'merchant', decided_at = now()
         from cards c
        where c.id = $2 and c.merchant_id = $1 and c.proposal_id = p.id and p.merchant_id = $1
          and p.command_id = 'merchant.ask' and p.status = 'awaiting_approval'
          and $3::int >= 0 and $3::int < jsonb_array_length(coalesce(p.params_json->'options', '[]'::jsonb))
       returning p.id, p.run_id, p.params_json
     )
     select q.*, r.skill, r.subject_ref, r.case_file_json from q join runs r on r.id = q.run_id`,
    [merchantId, cardId, optionIndex],
  );
  const row = res.rows[0];
  if (!row) {
    const waiting = await deps.pool.query(
      `select 1 from cards c join proposals p on p.id = c.proposal_id
        where c.id = $2 and c.merchant_id = $1 and p.command_id = 'merchant.ask' and p.status = 'awaiting_approval'`,
      [merchantId, cardId],
    );
    return waiting.rows[0]
      ? { status: "bad_option", message: "That isn't one of the answers" }
      : { status: "not_waiting", message: "This question isn't waiting for an answer" };
  }

  const { question, options } = row.params_json as { question: string; options: string[] };
  const option = options[optionIndex];
  const reopen = async (why: string) => {
    await deps.pool.query("update proposals set status = 'awaiting_approval', decided_by = null, decided_at = null where id = $1", [row.id]);
    await addStepFor(deps.pool, row.run_id, row.id, "merchant", `You answered: ${option}. Pyp couldn't act on it: ${why}`, false);
    return { status: "retry" as const, message: `Pyp couldn't act on your answer (${why}). Tap it again to retry.` };
  };

  const [kind, ...rest] = (row.subject_ref as string).split(":");
  const subject: SubjectRef = { kind, id: rest.join(":") };
  const original = (row.case_file_json?.facts as { request?: string } | undefined)?.request;
  let instruction: string;
  if (original) {
    const answer = `\n\nMy answer: ${option}`;
    // Keep the answer whole: cut the original sentence instead, if it has to be cut.
    instruction = original.slice(0, Math.max(0, MAX_REQUEST_CHARS - answer.length)) + answer;
  } else {
    instruction = `You asked: "${question}"\nMy answer: ${option}`;
  }

  const skillId = row.skill as SkillId;
  let cardIds: string[];
  try {
    const { merchant, rules } = await loadMerchant(deps.pool, merchantId);
    const ctx = { merchant, rules, read: deps.read, db: engineDb(deps.pool, merchantId), now };
    const result = await runSkill({ skill: getSkill(skillId), subject, ctx, agent: deps.agent, trigger: "answer", instruction });
    const saved = await saveRun(deps.pool, { merchantId, skill: skillId, subject, trigger: "answer", result, now: now() });
    if (result.status === "failed") return reopen(result.failure ?? "the run failed");
    cardIds = saved.cardIds;
  } catch (err) {
    return reopen((err as Error).message);
  }

  await deps.pool.query(
    `update cards set state = 'executed', updated_at = now(), front_json = front_json || jsonb_build_object('reason', $2::text) where id = $1`,
    [cardId, `You answered: ${option}`],
  );
  await addStepFor(deps.pool, row.run_id, row.id, "merchant", `You answered: ${option}`, true);
  const message = cardIds.length ? `Thanks. Pyp made ${cardIds.length} new card${cardIds.length > 1 ? "s" : ""}.` : "Thanks. Nothing more to do.";
  return { status: "answered", message, cardIds };
}
