// Pyp's own records in Postgres (design §10): storing a RunResult (engine
// README §2), the cards feed, the trace, and the proposal lifecycle the
// executor drives. Every query is scoped to one merchant.

import type { Pool } from "pg";
import { cardFor, needsCard, type CardFront, type CardState } from "@/engine/card";
import type { RunResult } from "@/engine/run-skill";
import type { CaseFile, CommandId, CommandRule, EngineDb, Hold, Merchant, MerchantRules, SkillId, SubjectRef } from "@/engine/types";

type Db = Pick<Pool, "query">;

const DEFAULT_TONE = "Warm, brief and professional. First names. No exclamation marks.";

export async function loadMerchant(db: Db, merchantId: string): Promise<{ merchant: Merchant; rules: MerchantRules }> {
  const m = await db.query(
    "select id, name, timezone, currency, kill_switch, undo_window_s, tone_guide from merchants where id = $1",
    [merchantId],
  );
  if (!m.rows[0]) throw new Error(`Merchant ${merchantId} not found`);
  const row = m.rows[0];
  const r = await db.query("select command_id, dial, limits_json from rules where merchant_id = $1", [merchantId]);
  const commands: Record<string, CommandRule> = {};
  for (const rule of r.rows) commands[rule.command_id] = { dial: rule.dial, limits: rule.limits_json ?? undefined };
  return {
    merchant: { id: row.id, name: row.name, timezone: row.timezone, currency: row.currency.trim(), toneGuide: row.tone_guide ?? DEFAULT_TONE },
    rules: { killSwitch: row.kill_switch, undoSeconds: row.undo_window_s, commands },
  };
}

/** Reminders that went out or are waiting in their undo window count (engine README §1). */
export function engineDb(db: Db, merchantId: string): EngineDb {
  return {
    async remindersSent(invoiceId) {
      const res = await db.query(
        `select count(*)::int as count, max(coalesce(e.at, p.decided_at, p.created_at)) as last
           from proposals p
           left join lateral (
             select max(at) as at from executions x
              where x.proposal_id = p.id and x.http_status between 200 and 299
           ) e on true
          where p.merchant_id = $1 and p.command_id = 'invoice.sendReminder'
            and p.params_json->>'invoiceId' = $2
            and p.status in ('scheduled', 'executing', 'executed')`,
        [merchantId, invoiceId],
      );
      const row = res.rows[0];
      return { count: row.count, lastSentAt: row.last ? new Date(row.last).toISOString() : null };
    },
    async remindCallsToday() {
      const res = await db.query(
        `select count(*)::int as n from executions x join proposals p on p.id = x.proposal_id
          where p.merchant_id = $1 and p.command_id = 'invoice.sendReminder'
            and x.http_status between 200 and 299 and x.at >= date_trunc('day', now())`,
        [merchantId],
      );
      return res.rows[0].n;
    },
    async merchantNotes() {
      return []; // seeded notes come with client_profiles (db/README.md)
    },
    async activeHold(subject) {
      const res = await db.query(
        `select reason, set_at, until from holds
          where merchant_id = $1 and subject_ref = $2 and lifted_at is null
          order by set_at desc limit 1`,
        [merchantId, subjectRef(subject)],
      );
      const row = res.rows[0];
      if (!row) return null;
      // The engine decides whether an `until` date has passed (merchant's timezone).
      const hold: Hold = { reason: row.reason, setAt: new Date(row.set_at).toISOString(), until: row.until ? isoDate(row.until) : null };
      return hold;
    },
  };
}

export function subjectRef(subject: SubjectRef): string {
  return `${subject.kind}:${subject.id}`;
}

function isoDate(d: Date | string): string {
  return typeof d === "string" ? d.slice(0, 10) : d.toISOString().slice(0, 10);
}

// ---------- Holds ----------

export async function setHold(db: Db, merchantId: string, subject: SubjectRef, reason: string, until: string | null): Promise<string> {
  const res = await db.query(
    `insert into holds (merchant_id, subject_ref, reason, until) values ($1, $2, $3, $4) returning id`,
    [merchantId, subjectRef(subject), reason, until],
  );
  await db.query(`insert into activity_log (merchant_id, actor, summary, refs_json) values ($1, 'merchant', $2, $3)`, [
    merchantId,
    `Hold on ${subject.kind} ${subject.id}${until ? ` until ${until}` : ""}: ${reason}`,
    JSON.stringify({ subject: subjectRef(subject) }),
  ]);
  return res.rows[0].id;
}

/** Lift every active hold on a subject. Returns how many were lifted. */
export async function liftHolds(db: Db, merchantId: string, subject: SubjectRef): Promise<number> {
  const res = await db.query(
    `update holds set lifted_at = now() where merchant_id = $1 and subject_ref = $2 and lifted_at is null`,
    [merchantId, subjectRef(subject)],
  );
  return res.rowCount ?? 0;
}

// ---------- Webhook events ----------

/** Store a PayPal event once. False = we've seen this event id before (a duplicate delivery). */
export async function insertEvent(
  db: Db,
  e: { id: string; merchantId: string; type: string; resourceId: string | null; raw: unknown },
): Promise<boolean> {
  const res = await db.query(
    `insert into events (id, merchant_id, type, resource_id, raw_json) values ($1, $2, $3, $4, $5)
     on conflict (id) do nothing`,
    [e.id, e.merchantId, e.type, e.resourceId, JSON.stringify(e.raw)],
  );
  return (res.rowCount ?? 0) === 1;
}

export async function markEvent(db: Db, eventId: string, status: "done" | "ignored" | "failed", outcome: string): Promise<void> {
  await db.query(`update events set status = $2, outcome = $3, processed_at = now() where id = $1`, [eventId, status, outcome]);
}

/**
 * A stand-down (design §0.14): pending proposals for this subject whose
 * command is listed become `obsolete`, their cards follow, and one activity
 * entry says why. One transaction. Returns the proposals it closed.
 */
export async function applyStandDown(
  pool: Pool,
  input: { merchantId: string; subject: SubjectRef; obsoleteCommands: CommandId[]; message: string; eventId?: string },
): Promise<string[]> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const closed = await client.query(
      `update proposals p set status = 'obsolete', decided_by = 'pyp', decided_at = now()
         from runs r
        where p.run_id = r.id and p.merchant_id = $1 and r.subject_ref = $2
          and p.command_id = any($3) and p.status in ('awaiting_approval', 'scheduled')
        returning p.id, p.run_id`,
      [input.merchantId, subjectRef(input.subject), input.obsoleteCommands],
    );
    const ids: string[] = closed.rows.map((r) => r.id);
    if (ids.length) {
      await client.query(`update cards set state = 'obsolete', updated_at = now() where proposal_id = any($1)`, [ids]);
      for (const row of closed.rows) {
        await addStep(client, row.run_id, row.id, "act", input.message, true, input.eventId ? { event: input.eventId } : undefined);
      }
    }
    await client.query(`insert into activity_log (merchant_id, actor, summary, refs_json) values ($1, 'pyp', $2, $3)`, [
      input.merchantId,
      input.message,
      JSON.stringify({ subject: subjectRef(input.subject), event: input.eventId ?? null, obsoleted: ids }),
    ]);
    await client.query("commit");
    return ids;
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export interface SaveRunInput {
  merchantId: string;
  skill: SkillId;
  subject: SubjectRef;
  trigger: string;
  result: RunResult;
  /** The PayPal event behind this run, if any. Unique: an event makes at most one run. */
  triggerEventId?: string;
}

/** One transaction: the run, its proposals (ids assigned here), trace steps and cards. */
export async function saveRun(pool: Pool, input: SaveRunInput): Promise<{ runId: string; cardIds: string[] }> {
  const { merchantId, skill, subject, trigger, result, triggerEventId } = input;
  const client = await pool.connect();
  try {
    await client.query("begin");
    const cf = result.caseFile;
    const run = await client.query(
      `insert into runs (merchant_id, skill, subject_ref, trigger, model, case_file_xml, case_file_json,
                         output_json, usage_json, cost_usd, status, failure, trigger_event_id, ended_at)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, now()) returning id`,
      [
        merchantId,
        skill,
        `${subject.kind}:${subject.id}`,
        trigger,
        result.model,
        cf?.xml ?? null,
        cf ? JSON.stringify(cf) : null,
        result.response ? JSON.stringify(result.response) : null,
        JSON.stringify(result.usage),
        result.usage.reduce((s, u) => s + u.costUsd, 0),
        result.status,
        result.failure ?? null,
        triggerEventId ?? null,
      ],
    );
    const runId: string = run.rows[0].id;

    for (const step of result.trace) {
      await client.query(
        "insert into trace_steps (run_id, at, kind, label, detail_json) values ($1, $2, $3, $4, $5)",
        [runId, step.at, step.stage, step.label, step.detail ? JSON.stringify(step.detail) : null],
      );
    }

    const cardIds: string[] = [];
    for (const p of result.proposals) {
      const prop = await client.query(
        `insert into proposals (run_id, merchant_id, command_id, params_json, why, decision, policy_rule,
                                status, resolved_json, check_reason)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10) returning id`,
        [
          runId,
          merchantId,
          p.action.command,
          JSON.stringify(p.action.params),
          p.action.why,
          p.policy?.decision ?? null,
          p.policy?.rule ?? null,
          p.status,
          p.resolved ? JSON.stringify(p.resolved) : null,
          p.check.ok ? null : (p.check.reason ?? null),
        ],
      );
      if (!needsCard(p) || !result.response) continue;
      const card = await client.query(
        `insert into cards (merchant_id, run_id, proposal_id, skill, state, front_json)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [merchantId, runId, prop.rows[0].id, skill, p.status, JSON.stringify(cardFor(skill, p, result.response))],
      );
      cardIds.push(card.rows[0].id);
    }
    await client.query("commit");
    return { runId, cardIds };
  } catch (err) {
    await client.query("rollback");
    throw err;
  } finally {
    client.release();
  }
}

export interface CardRow {
  id: string;
  skill: SkillId;
  state: CardState;
  front: CardFront;
  proposalId: string | null;
  createdAt: string;
  updatedAt: string;
}

const CARD_COLUMNS = "id, skill, state, front_json, proposal_id, created_at, updated_at";

function toCard(row: Record<string, any>): CardRow { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    id: row.id,
    skill: row.skill,
    state: row.state,
    front: row.front_json,
    proposalId: row.proposal_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
  };
}

export async function listCards(db: Db, merchantId: string, limit = 50): Promise<CardRow[]> {
  const res = await db.query(
    `select ${CARD_COLUMNS} from cards where merchant_id = $1 order by created_at desc limit $2`,
    [merchantId, limit],
  );
  return res.rows.map(toCard);
}

export async function getCard(db: Db, merchantId: string, cardId: string): Promise<CardRow | null> {
  const res = await db.query(`select ${CARD_COLUMNS} from cards where merchant_id = $1 and id = $2`, [merchantId, cardId]);
  return res.rows[0] ? toCard(res.rows[0]) : null;
}

export interface TraceRow {
  at: string;
  kind: string;
  label: string;
  ok: boolean | null;
  detail: unknown;
}

/** The back of the card: its run's steps, then what happened to this card's proposal. */
export async function getTrace(db: Db, merchantId: string, cardId: string): Promise<TraceRow[] | null> {
  const card = await db.query("select run_id, proposal_id from cards where merchant_id = $1 and id = $2", [merchantId, cardId]);
  if (!card.rows[0]) return null;
  const { run_id, proposal_id } = card.rows[0];
  const res = await db.query(
    `select at, kind, label, ok, detail_json from trace_steps
      where run_id = $1 and (proposal_id is null or proposal_id = $2) order by at, id`,
    [run_id, proposal_id],
  );
  return res.rows.map((r) => ({ at: new Date(r.at).toISOString(), kind: r.kind, label: r.label, ok: r.ok, detail: r.detail_json }));
}

export interface ClaimedProposal {
  id: string;
  runId: string;
  cardId: string;
  skill: SkillId;
  commandId: string;
  params: Record<string, unknown>;
  resolved: Record<string, unknown> | null;
  caseFile: CaseFile;
}

/**
 * Approve: moves the card's proposal from awaiting_approval to executing in one
 * conditional update, so a double tap or a second tab can't run it twice.
 * Returns null if the card isn't waiting for approval (or isn't this merchant's).
 */
export async function claimForExecution(db: Db, merchantId: string, cardId: string): Promise<ClaimedProposal | null> {
  const res = await db.query(
    `with claimed as (
       update proposals p set status = 'executing', decided_by = 'merchant', decided_at = now()
         from cards c
        where c.id = $2 and c.merchant_id = $1 and c.proposal_id = p.id
          and p.merchant_id = $1 and p.status = 'awaiting_approval'
          and p.command_id <> 'merchant.ask'
       returning p.id, p.run_id, p.command_id, p.params_json, p.resolved_json, c.id as card_id
     )
     select claimed.*, r.skill, r.case_file_json from claimed join runs r on r.id = claimed.run_id`,
    [merchantId, cardId],
  );
  const row = res.rows[0];
  if (!row) return null;
  await setCardState(db, cardId, "executing");
  await addStep(db, row.run_id, row.id, "merchant", "You approved", true);
  return {
    id: row.id,
    runId: row.run_id,
    cardId: row.card_id,
    skill: row.skill,
    commandId: row.command_id,
    params: row.params_json,
    resolved: row.resolved_json,
    caseFile: row.case_file_json,
  };
}

/** Dismiss: the proposal is rejected and nothing is sent. */
export async function dismiss(db: Db, merchantId: string, cardId: string): Promise<boolean> {
  const res = await db.query(
    `update proposals p set status = 'rejected', decided_by = 'merchant', decided_at = now()
       from cards c
      where c.id = $2 and c.merchant_id = $1 and c.proposal_id = p.id and p.status = 'awaiting_approval'
     returning p.id, p.run_id`,
    [merchantId, cardId],
  );
  if (!res.rows[0]) return false;
  await setCardState(db, cardId, "rejected");
  await addStep(db, res.rows[0].run_id, res.rows[0].id, "merchant", "You dismissed this", true);
  return true;
}

export async function recordExecution(
  db: Db,
  e: { proposalId: string; step: string; requestId: string; httpStatus: number | null; debugId: string | null; response: unknown },
): Promise<void> {
  const prior = await db.query("select count(*)::int as n from executions where proposal_id = $1 and step = $2", [e.proposalId, e.step]);
  await db.query(
    `insert into executions (proposal_id, step, paypal_request_id, http_status, paypal_debug_id, response_json, attempt)
     values ($1, $2, $3, $4, $5, $6, $7)`,
    [e.proposalId, e.step, e.requestId, e.httpStatus, e.debugId, JSON.stringify(e.response ?? null), prior.rows[0].n + 1],
  );
}

/** The response of a step that already succeeded, so a retry resumes after it. */
export async function succeededStep(db: Db, proposalId: string, step: string): Promise<unknown | null> {
  const res = await db.query(
    `select response_json from executions where proposal_id = $1 and step = $2
        and http_status between 200 and 299 order by at desc limit 1`,
    [proposalId, step],
  );
  return res.rows[0]?.response_json ?? null;
}

/** Where a claimed proposal ends up, with the trace step and activity-log line that say so. */
export async function finish(
  db: Db,
  p: { merchantId: string; proposal: ClaimedProposal; status: "executed" | "failed" | "obsolete" | "awaiting_approval"; label: string; ok: boolean; reason?: string; detail?: unknown },
): Promise<void> {
  await db.query("update proposals set status = $2 where id = $1", [p.proposal.id, p.status]);
  await db.query(
    `update cards set state = $2, updated_at = now(),
            front_json = case when $3::text is null then front_json else front_json || jsonb_build_object('reason', $3::text) end
      where id = $1`,
    [p.proposal.cardId, p.status, p.reason ?? null],
  );
  await addStep(db, p.proposal.runId, p.proposal.id, "paypal", p.label, p.ok, p.detail);
  if (p.status === "executed") {
    await db.query("insert into activity_log (merchant_id, actor, summary, refs_json) values ($1, 'pyp', $2, $3)", [
      p.merchantId,
      p.label,
      JSON.stringify({ proposalId: p.proposal.id, cardId: p.proposal.cardId }),
    ]);
  }
}

async function setCardState(db: Db, cardId: string, state: CardState): Promise<void> {
  await db.query("update cards set state = $2, updated_at = now() where id = $1", [cardId, state]);
}

async function addStep(db: Db, runId: string, proposalId: string, kind: string, label: string, ok: boolean, detail?: unknown) {
  await db.query(
    "insert into trace_steps (run_id, proposal_id, at, kind, label, ok, detail_json) values ($1, $2, clock_timestamp(), $3, $4, $5, $6)",
    [runId, proposalId, kind, label, ok, detail === undefined ? null : JSON.stringify(detail)],
  );
}

/** Which merchant a signed-in Supabase user works for (migration 002). */
export async function merchantForUser(db: Db, userId: string): Promise<string | null> {
  const res = await db.query("select merchant_id from merchant_members where user_id = $1 order by created_at limit 1", [userId]);
  return res.rows[0]?.merchant_id ?? null;
}
