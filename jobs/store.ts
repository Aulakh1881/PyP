// Pyp's own records in Postgres (design §10): storing a RunResult (engine
// README §2), the cards feed, the trace, and the proposal lifecycle the
// executor drives. Every query is scoped to one merchant.

import type { Pool } from "pg";
import { cardFor, needsCard, type CardFront, type CardState } from "@/engine/card";
import { getSkill } from "@/engine/registry";
import type { RunResult } from "@/engine/run-skill";
import type { CaseFile, CommandId, CommandRule, EngineDb, Hold, Merchant, MerchantRules, SkillId, SubjectRef } from "@/engine/types";
import { savedClientsForEngine } from "./clients";
import { factsFor } from "./facts";

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

/**
 * Reminders that went out or are waiting in their undo window count (engine README §1).
 * The executor passes the proposal it is running as `executing`, so its own re-check
 * doesn't count the reminder it is about to send.
 */
export function engineDb(db: Db, merchantId: string, executing?: string): EngineDb {
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
            and p.status in ('scheduled', 'executing', 'executed')
            and p.id is distinct from $3::uuid`,
        [merchantId, invoiceId, executing ?? null],
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
    merchantNotes(subject, clientEmails) {
      return factsFor(db, merchantId, subjectRef(subject), clientEmails ?? []);
    },
    savedClients() {
      return savedClientsForEngine(db, merchantId);
    },
    async followUps(invoiceId) {
      const res = await db.query(
        `select count(*) filter (where status = 'scheduled')::int as pending,
                count(*) filter (where status in ('executing', 'executed'))::int as done
           from proposals
          where merchant_id = $1 and command_id = 'invoice.scheduleFollowUp' and params_json->>'invoiceId' = $2`,
        [merchantId, invoiceId],
      );
      // A follow-up being run is "executing", so it counts as done, not pending.
      return res.rows[0];
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
  /** The clock scheduled proposals count from (default: now). */
  now?: Date;
}

export const FOLLOW_UP = "invoice.scheduleFollowUp";

/**
 * When a scheduled proposal falls due (design §8.3): a follow-up after its
 * inDays, anything else on Auto once the merchant's undo window has passed.
 */
export function dueAt(commandId: string, params: Record<string, unknown>, now: Date, undoSeconds: number): Date {
  if (commandId === FOLLOW_UP) return new Date(now.getTime() + Number(params.inDays) * 86_400_000);
  return new Date(now.getTime() + undoSeconds * 1000);
}

/** One transaction: the run, its proposals (ids assigned here), trace steps and cards. */
export async function saveRun(pool: Pool, input: SaveRunInput): Promise<{ runId: string; cardIds: string[] }> {
  const { merchantId, skill, subject, trigger, result, triggerEventId } = input;
  const now = input.now ?? new Date();
  const client = await pool.connect();
  try {
    await client.query("begin");
    const undoSeconds: number = result.proposals.some((p) => p.status === "scheduled")
      ? (await client.query("select undo_window_s from merchants where id = $1", [merchantId])).rows[0].undo_window_s
      : 0;
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
      // A read-only action on Auto (an insight card) sends nothing, so there is nothing to undo: it's done now.
      const def = getSkill(skill).commands.find((c) => c.id === p.action.command);
      const status = p.status === "scheduled" && def?.risk === "read" ? "executed" : p.status;
      const scheduledFor = status === "scheduled" ? dueAt(p.action.command, p.action.params, now, undoSeconds) : null;
      const prop = await client.query(
        `insert into proposals (run_id, merchant_id, command_id, params_json, why, decision, policy_rule,
                                status, resolved_json, check_reason, scheduled_for)
         values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11) returning id`,
        [
          runId,
          merchantId,
          p.action.command,
          JSON.stringify(p.action.params),
          p.action.why,
          p.policy?.decision ?? null,
          p.policy?.rule ?? null,
          status,
          p.resolved ? JSON.stringify(p.resolved) : null,
          p.check.ok ? null : (p.check.reason ?? null),
          scheduledFor,
        ],
      );
      if (!needsCard(p) || !result.response) continue;
      const editable = def?.editable;
      const front = { ...cardFor(skill, p, result.response, editable), ...(scheduledFor ? { scheduledFor: scheduledFor.toISOString() } : {}) };
      const card = await client.query(
        `insert into cards (merchant_id, run_id, proposal_id, skill, state, front_json)
         values ($1, $2, $3, $4, $5, $6) returning id`,
        [merchantId, runId, prop.rows[0].id, skill, status, JSON.stringify(front)],
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
  /** When the merchant removed this finished card from the Inbox; it stays in Activity. */
  clearedAt: string | null;
}

// cleared_at is read through to_jsonb so this still works on a database that
// hasn't run migration 010 yet (every card then reads as not cleared).
const CARD_COLUMNS = "id, skill, state, front_json, proposal_id, created_at, updated_at, to_jsonb(cards) ->> 'cleared_at' as cleared_at";

function toCard(row: Record<string, any>): CardRow { // eslint-disable-line @typescript-eslint/no-explicit-any
  return {
    id: row.id,
    skill: row.skill,
    state: row.state,
    front: row.front_json,
    proposalId: row.proposal_id,
    createdAt: new Date(row.created_at).toISOString(),
    updatedAt: new Date(row.updated_at).toISOString(),
    clearedAt: row.cleared_at ? new Date(row.cleared_at).toISOString() : null,
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
  /** Set when the worker claimed it (Auto, after the undo window), with the pickup count. */
  auto?: { attempts: number };
  /** The merchant's rewrites from Approve (executor/execute.ts applies and checks them). */
  edits?: Record<string, string>;
}

/** An approved edit: the new params and resolved values, what changed, and the card's text to match. */
/** The params a card shows as its body (engine/card.ts). */
const BODY_FIELDS = ["note", "message"];

export async function saveEdits(db: Db, p: ClaimedProposal, diff: Record<string, { from: unknown; to: string }>): Promise<void> {
  await db.query("update proposals set params_json = $2, resolved_json = $3, edit_diff = $4 where id = $1", [
    p.id,
    JSON.stringify(p.params),
    p.resolved ? JSON.stringify(p.resolved) : null,
    JSON.stringify(diff),
  ]);
  // The card shows what was actually sent: the edited fields, and the body if it was one of them.
  const card = await db.query("select front_json from cards where id = $1", [p.cardId]);
  const front = card.rows[0]?.front_json as CardFront | undefined;
  if (front) {
    for (const [field, d] of Object.entries(diff)) {
      // The body is the note (or a dispute message); an empty note has no body until edited.
      if (BODY_FIELDS.includes(field) || front.body === d.from) front.body = d.to || undefined;
      const e = front.edit?.find((x) => x.field === field);
      if (e) e.value = d.to;
    }
    await db.query("update cards set front_json = $2, updated_at = now() where id = $1", [p.cardId, JSON.stringify(front)]);
  }
  await addStep(db, p.runId, p.id, "merchant", `You edited: ${Object.keys(diff).join(", ")}`, true, diff);
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

export interface DueProposal extends ClaimedProposal {
  merchantId: string;
  subjectRef: string;
}

/**
 * The worker's claim (design §8.3): scheduled proposals whose time has come move
 * to executing in one statement. SKIP LOCKED lets two workers share the queue
 * without taking the same row. A merchant with the kill switch on is left alone;
 * their proposals wait until it is off.
 */
export async function claimDue(db: Db, now: Date, limit = 1): Promise<DueProposal[]> {
  const res = await db.query(
    `with due as (
       select p.id from proposals p join merchants m on m.id = p.merchant_id
        where p.status = 'scheduled' and p.scheduled_for <= $1 and not m.kill_switch
        order by p.scheduled_for
        limit $2
        for update of p skip locked
     ),
     claimed as (
       update proposals p set status = 'executing', decided_by = 'pyp', decided_at = now(), attempts = p.attempts + 1
         from due where p.id = due.id
       returning p.id, p.run_id, p.merchant_id, p.command_id, p.params_json, p.resolved_json, p.attempts
     )
     select claimed.*, c.id as card_id, r.skill, r.subject_ref, r.case_file_json
       from claimed join runs r on r.id = claimed.run_id
       left join cards c on c.proposal_id = claimed.id`,
    [now, limit],
  );
  const out: DueProposal[] = [];
  for (const row of res.rows) {
    if (row.card_id) await setCardState(db, row.card_id, "executing");
    const label = row.command_id === FOLLOW_UP ? "Follow-up is due" : "Undo window passed; running on Auto";
    await addStep(db, row.run_id, row.id, "merchant", label, true);
    out.push({
      id: row.id,
      runId: row.run_id,
      cardId: row.card_id,
      merchantId: row.merchant_id,
      subjectRef: row.subject_ref,
      skill: row.skill,
      commandId: row.command_id,
      params: row.params_json,
      resolved: row.resolved_json,
      caseFile: row.case_file_json,
      auto: { attempts: row.attempts },
    });
  }
  return out;
}

/** A write in flight longer than this is taken to have died with its process. */
export const STALE_EXECUTING_MINUTES = 5;

/**
 * Proposals left on "executing" by a process that stopped mid-run (a deploy, a
 * crash) go back where they came from: the worker's queue, or the merchant's
 * Approve button. Safe to run again: every write carries the same request id.
 */
export async function reapStale(db: Db): Promise<string[]> {
  const res = await db.query(
    `update proposals set status = case when decided_by = 'pyp' then 'scheduled' else 'awaiting_approval' end
      where status = 'executing' and decided_at < now() - make_interval(mins => $1)
      returning id, run_id, status`,
    [STALE_EXECUTING_MINUTES],
  );
  for (const row of res.rows) {
    await db.query("update cards set state = $2, updated_at = now() where proposal_id = $1", [row.id, row.status]);
    await addStep(db, row.run_id, row.id, "act", "Pyp stopped mid-run; this went back to wait", false);
  }
  return res.rows.map((r) => r.id);
}

/** Undo: a scheduled proposal is cancelled before it runs. Nothing has left Pyp. */
export async function undo(db: Db, merchantId: string, cardId: string): Promise<boolean> {
  const res = await db.query(
    `update proposals p set status = 'undone', decided_by = 'merchant', decided_at = now()
       from cards c
      where c.id = $2 and c.merchant_id = $1 and c.proposal_id = p.id and p.status = 'scheduled'
     returning p.id, p.run_id`,
    [merchantId, cardId],
  );
  if (!res.rows[0]) return false;
  await setCardState(db, cardId, "undone");
  await addStep(db, res.rows[0].run_id, res.rows[0].id, "merchant", "You tapped Undo; nothing was sent", true);
  return true;
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

/**
 * A heads-up card from a workflow (an invoice was paid): no model, no proposal,
 * nothing sent anywhere. Saved as a finished run so its trace and Activity work.
 */
export async function saveNotice(
  pool: Pool,
  n: { merchantId: string; subject: SubjectRef; trigger: string; title: string; subtitle: string; body: string; reason: string },
): Promise<string> {
  const client = await pool.connect();
  try {
    await client.query("begin");
    const run = await client.query(
      `insert into runs (merchant_id, skill, subject_ref, trigger, status, usage_json, cost_usd, ended_at)
       values ($1, 'collections', $2, $3, 'ok', '[]', 0, now()) returning id`,
      [n.merchantId, subjectRef(n.subject), n.trigger],
    );
    const runId: string = run.rows[0].id;
    await client.query("insert into trace_steps (run_id, at, kind, label) values ($1, now(), 'trigger', $2), ($1, now(), 'decide', $3)", [
      runId,
      `${n.trigger} → heads-up`,
      `${n.reason} No model call; nothing sent.`,
    ]);
    const front = { eyebrow: "WORKFLOWS · HEADS-UP", title: n.title, subtitle: n.subtitle, body: n.body, reason: n.reason, notice: true };
    const card = await client.query(
      "insert into cards (merchant_id, run_id, skill, state, front_json) values ($1, $2, 'collections', 'executed', $3) returning id",
      [n.merchantId, runId, JSON.stringify(front)],
    );
    await client.query("commit");
    return card.rows[0].id;
  } catch (err) {
    await client.query("rollback").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

/**
 * Questions the merchant answered by typing in chat: each question card in `cardIds`
 * that is still waiting becomes answered, with their words on it, like tapping an answer.
 * Only this merchant's waiting questions; anything else is left alone.
 */
export async function answerQuestionsInChat(db: Db, merchantId: string, cardIds: string[], answer: string): Promise<number> {
  if (!cardIds.length) return 0;
  const reason = `You answered in the chat: ${answer.length > 120 ? `${answer.slice(0, 120)}…` : answer}`;
  const res = await db.query(
    `with q as (
       update proposals p set status = 'answered', decided_by = 'merchant', decided_at = now()
         from cards c
        where c.id = any($2::uuid[]) and c.merchant_id = $1 and c.proposal_id = p.id and p.merchant_id = $1
          and p.command_id = 'merchant.ask' and p.status = 'awaiting_approval'
       returning c.id
     )
     update cards c set state = 'executed', updated_at = now(), front_json = c.front_json || jsonb_build_object('reason', $3::text)
       from q where c.id = q.id
     returning c.id`,
    [merchantId, cardIds, reason],
  );
  return res.rowCount ?? 0;
}

/** States a card can be removed from the Inbox in: nothing is waiting or still running. */
export const CLEARABLE_STATES: CardState[] = ["executed", "failed", "blocked", "obsolete", "rejected", "undone"];

/**
 * "Remove from Inbox": hides a finished card from the Inbox. Nothing is deleted;
 * the card stays in Activity and the audit trail. False if the card isn't finished.
 */
export async function clearCard(db: Db, merchantId: string, cardId: string): Promise<boolean> {
  const res = await db.query(
    `update cards set cleared_at = now()
      where merchant_id = $1 and id = $2 and state = any($3::text[]) and cleared_at is null
     returning id`,
    [merchantId, cardId, CLEARABLE_STATES],
  );
  return res.rowCount === 1;
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

/** Has any write for this proposal reached (or tried to reach) PayPal? Then its words are fixed. */
export async function attempted(db: Db, proposalId: string): Promise<boolean> {
  const res = await db.query("select 1 from executions where proposal_id = $1 limit 1", [proposalId]);
  return res.rows.length > 0;
}

/** Takes the Edit fields off a card: what's going to PayPal can't change any more. */
export async function lockEdits(db: Db, cardId: string): Promise<void> {
  await db.query("update cards set front_json = front_json - 'edit', updated_at = now() where id = $1", [cardId]);
}

export type FinishStatus = "executed" | "failed" | "obsolete" | "awaiting_approval" | "scheduled";

/** Where a claimed proposal ends up, with the trace step and activity-log line that say so. */
export async function finish(
  db: Db,
  p: {
    merchantId: string;
    proposal: ClaimedProposal;
    status: FinishStatus;
    label: string;
    ok: boolean;
    reason?: string;
    detail?: unknown;
    /** With status "scheduled": when the worker tries again. */
    retryAt?: Date;
  },
): Promise<void> {
  const retryAt = p.status === "scheduled" ? (p.retryAt ?? null) : null;
  await db.query("update proposals set status = $2, scheduled_for = coalesce($3, scheduled_for) where id = $1", [p.proposal.id, p.status, retryAt]);
  const front: Record<string, string> = {};
  if (p.reason) front.reason = p.reason;
  if (retryAt) front.scheduledFor = retryAt.toISOString();
  await db.query(
    `update cards set state = $2, updated_at = now(), front_json = front_json || $3::jsonb where id = $1`,
    [p.proposal.cardId, p.status, JSON.stringify(front)],
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

/** A trace step on a proposal, for job code outside this file (e.g. answering a question). */
export const addStepFor = (db: Db, runId: string, proposalId: string, kind: string, label: string, ok: boolean, detail?: unknown) =>
  addStep(db, runId, proposalId, kind, label, ok, detail);

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
