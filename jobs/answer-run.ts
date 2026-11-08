// Answering a question card (merchant.ask, design §11.3 POST /api/cards/{id}/answer).
// The merchant taps one of the buttons; the question is closed and the same
// skill runs again on the same subject with the answer as the merchant's words.
// That run makes its own cards, so an answer never writes to PayPal by itself.
//
// For a new invoice from chat the original sentence goes along too, because the
// case file is built from it ("Invoice NewCo $500" + "Done, NewCo is added").

import type { Pool } from "pg";
import { getSkill } from "@/engine/registry";
import { runSkill } from "@/engine/run-skill";
import type { AgentClient, PayPalReads, SkillId, SubjectRef } from "@/engine/types";
import { addStepFor, engineDb, loadMerchant, saveRun } from "./store";

export interface AnswerDeps {
  pool: Pool;
  read: PayPalReads;
  agent: AgentClient;
  now?: () => Date;
}

export type AnswerOutcome =
  | { status: "answered"; message: string; cardIds: string[] }
  | { status: "not_waiting" | "bad_option"; message: string };

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
  await deps.pool.query(
    `update cards set state = 'executed', updated_at = now(), front_json = front_json || jsonb_build_object('reason', $2::text) where id = $1`,
    [cardId, `You answered: ${option}`],
  );
  await addStepFor(deps.pool, row.run_id, row.id, "merchant", `You answered: ${option}`, true);

  const [kind, ...rest] = (row.subject_ref as string).split(":");
  const subject: SubjectRef = { kind, id: rest.join(":") };
  const answer = `My answer to your question "${question}": ${option}`;
  const original = (row.case_file_json?.facts as { request?: string } | undefined)?.request;
  const instruction = original ? `${original}\n\n${answer}` : answer;

  const skillId = row.skill as SkillId;
  const { merchant, rules } = await loadMerchant(deps.pool, merchantId);
  const ctx = { merchant, rules, read: deps.read, db: engineDb(deps.pool, merchantId), now };
  const result = await runSkill({ skill: getSkill(skillId), subject, ctx, agent: deps.agent, trigger: "answer", instruction });
  const { cardIds } = await saveRun(deps.pool, { merchantId, skill: skillId, subject, trigger: "answer", result, now: now() });
  const message =
    result.status === "failed"
      ? `Answer saved, but Pyp couldn't act on it: ${result.failure ?? "the run failed"}`
      : cardIds.length
        ? `Thanks. Pyp made ${cardIds.length} new card${cardIds.length > 1 ? "s" : ""}.`
        : "Thanks. Nothing more to do.";
  return { status: "answered", message, cardIds };
}
