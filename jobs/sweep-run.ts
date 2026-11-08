// Sweeps (design §9.3): the safety net behind webhooks.
//
//   overdue-invoices    unpaid invoices past their due date → Collections
//   dispute-deadlines   disputes waiting on the merchant, due within 72 h → Disputes
//
// A subject that already has a card waiting, an Auto action in its undo window
// or a follow-up scheduled is skipped: the merchant (or the follow-up) already
// has it. The rest run least recently swept first, so the per-sweep cap never
// leaves the same subjects out day after day. One sweep runs at a time per
// merchant (an advisory lock), so "check now" and the daily sweep never race.
// The worker runs each once a day from 08:00 merchant-local (runDailySweeps),
// trying again later that day if it failed; the dashboard can run one now
// (POST /api/sweeps/{name}).

import type { Pool } from "pg";
import { localDate } from "@/engine/format";
import { getSkill } from "@/engine/registry";
import { runSkill } from "@/engine/run-skill";
import type { AgentClient, Dispute, Invoice, PayPalReads, SkillId, SubjectRef } from "@/engine/types";
import { engineDb, loadMerchant, saveRun, subjectRef } from "./store";

export const SWEEP_NAMES = ["overdue-invoices", "dispute-deadlines"] as const;
export type SweepName = (typeof SWEEP_NAMES)[number];

const SKILL: Record<SweepName, SkillId> = { "overdue-invoices": "collections", "dispute-deadlines": "disputes" };
/** A dispute due within this many hours is swept (design §9.3, B.2 urgency). */
export const DEADLINE_HOURS = 72;
/** The merchant-local hour the daily sweeps start. */
export const SWEEP_HOUR = 8;
/** At most this many skill runs per sweep, so one sweep can't spend the day's budget. */
export const SWEEP_LIMIT = 10;

export interface SweepReads extends PayPalReads {
  overdueInvoices(today: string, limit?: number): Promise<Invoice[]>;
  disputesDueBefore(before: Date): Promise<Dispute[]>;
}

export interface SweepDeps {
  pool: Pool;
  read: SweepReads;
  agent: AgentClient;
  now?: () => Date;
  /** The daily sweeps only: limit them to these merchants (the one the shared PayPal app belongs to). */
  merchantIds?: string[];
}

export type SweepOutcome =
  | { status: "paused" }
  | { status: "busy" } // another sweep for this merchant is running
  | { status: "ok"; found: number; skipped: number; deferred: number; ran: number; cardIds: string[]; failed: string[] };

/** A daily sweep that ended in one of these is tried again RETRY_MINUTES after it finished. */
const RETRYABLE = ["error", "paused", "busy"];
export const RETRY_MINUTES = 15;
/** A daily sweep with no finish this long after it started (a restart mid-sweep) is claimed again. */
export const STALE_MINUTES = 30;

export async function runSweep(deps: SweepDeps, merchantId: string, name: SweepName, limit = SWEEP_LIMIT): Promise<SweepOutcome> {
  // One sweep per merchant at a time, across workers and the dashboard.
  const key = `pyp-sweep:${merchantId}`;
  const lock = await deps.pool.connect();
  try {
    const got = await lock.query("select pg_try_advisory_lock(hashtext($1)) as ok", [key]);
    if (!got.rows[0].ok) return { status: "busy" };
    try {
      return await sweepLocked(deps, merchantId, name, limit);
    } finally {
      await lock.query("select pg_advisory_unlock(hashtext($1))", [key]);
    }
  } finally {
    lock.release();
  }
}

async function sweepLocked(deps: SweepDeps, merchantId: string, name: SweepName, limit: number): Promise<SweepOutcome> {
  const now = deps.now ?? (() => new Date());
  const { merchant, rules } = await loadMerchant(deps.pool, merchantId);
  if (rules.killSwitch) return { status: "paused" }; // no model calls while paused

  const subjects: SubjectRef[] =
    name === "overdue-invoices"
      ? (await deps.read.overdueInvoices(localDate(now(), merchant.timezone))).map((i) => ({ kind: "invoice", id: i.id }))
      : (await deps.read.disputesDueBefore(new Date(now().getTime() + DEADLINE_HOURS * 3_600_000))).map((d) => ({ kind: "dispute", id: d.id }));

  const busy = await busySubjects(deps.pool, merchantId);
  const last = await lastSwept(deps.pool, merchantId);
  // Least recently swept first (never swept before anything); ties keep PayPal's order.
  const todo = subjects
    .filter((s) => !busy.has(subjectRef(s)))
    .map((s, i) => ({ s, i, at: last.get(subjectRef(s)) ?? -Infinity }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.s);
  const ctx = { merchant, rules, read: deps.read, db: engineDb(deps.pool, merchantId), now };
  const skill = getSkill(SKILL[name]);
  const out = { status: "ok" as const, found: subjects.length, skipped: subjects.length - todo.length, deferred: Math.max(0, todo.length - limit), ran: 0, cardIds: [] as string[], failed: [] as string[] };

  for (const subject of todo.slice(0, limit)) {
    try {
      const result = await runSkill({ skill, subject, ctx, agent: deps.agent, trigger: `sweep:${name}` });
      // A failed run is still saved, so its trace shows what went wrong.
      const saved = await saveRun(deps.pool, { merchantId, skill: skill.id, subject, trigger: `sweep:${name}`, result, now: now() });
      if (result.status === "failed") {
        out.failed.push(`${subject.id}: ${result.failure ?? "run failed"}`);
        continue;
      }
      out.ran++;
      out.cardIds.push(...saved.cardIds);
    } catch (err) {
      // One subject failing (PayPal down, the spend cap) never stops the rest being reported.
      out.failed.push(`${subject.id}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** Subjects Pyp is already handling: a card waiting, an Auto action or follow-up scheduled, a write in flight. */
async function busySubjects(pool: Pool, merchantId: string): Promise<Set<string>> {
  const res = await pool.query(
    `select distinct r.subject_ref from proposals p join runs r on r.id = p.run_id
      where p.merchant_id = $1 and p.status in ('awaiting_approval', 'scheduled', 'executing')`,
    [merchantId],
  );
  return new Set(res.rows.map((r) => r.subject_ref as string));
}

/** When each subject was last run by a sweep, in ms. */
async function lastSwept(pool: Pool, merchantId: string): Promise<Map<string, number>> {
  const res = await pool.query(
    `select subject_ref, max(started_at) as at from runs
      where merchant_id = $1 and trigger like 'sweep:%' group by subject_ref`,
    [merchantId],
  );
  return new Map(res.rows.map((r) => [r.subject_ref as string, new Date(r.at).getTime()]));
}

/**
 * The worker's daily check: for each merchant whose local time is past 08:00,
 * claims today's row in sweep_runs (so each sweep runs once a day, whatever
 * the number of workers) and runs the sweep. A sweep that failed, found Pyp
 * paused or found another sweep running is claimed again RETRY_MINUTES after
 * it finished; one that never finished (a restart) after STALE_MINUTES.
 * One merchant's failure never stops the others.
 */
export async function runDailySweeps(deps: SweepDeps): Promise<{ merchantId: string; name: SweepName; outcome: SweepOutcome | { status: "error"; message: string } }[]> {
  const now = (deps.now ?? (() => new Date()))();
  const merchants = deps.merchantIds
    ? await deps.pool.query("select id, timezone from merchants where not kill_switch and id = any($1::uuid[])", [deps.merchantIds])
    : await deps.pool.query("select id, timezone from merchants where not kill_switch");
  const done: { merchantId: string; name: SweepName; outcome: SweepOutcome | { status: "error"; message: string } }[] = [];
  for (const m of merchants.rows as { id: string; timezone: string }[]) {
    try {
      if (localHour(now, m.timezone) < SWEEP_HOUR) continue;
      const today = localDate(now, m.timezone);
      for (const name of SWEEP_NAMES) {
        const claimed = await deps.pool.query(
          `insert into sweep_runs (merchant_id, name, local_date, started_at) values ($1, $2, $3, $4)
           on conflict (merchant_id, name, local_date) do update set started_at = $4, finished_at = null, outcome = null
            where (sweep_runs.finished_at is not null
                   and sweep_runs.outcome::jsonb ->> 'status' = any($5::text[])
                   and sweep_runs.finished_at < $4::timestamptz - make_interval(mins => $6))
               or (sweep_runs.finished_at is null and sweep_runs.started_at < $4::timestamptz - make_interval(mins => $7))
           returning name`,
          [m.id, name, today, now, RETRYABLE, RETRY_MINUTES, STALE_MINUTES],
        );
        if (!claimed.rows[0]) continue;
        const outcome = await runSweep(deps, m.id, name).catch((err: Error) => ({ status: "error" as const, message: err.message }));
        await deps.pool.query(
          "update sweep_runs set finished_at = $4, outcome = $5 where merchant_id = $1 and name = $2 and local_date = $3",
          [m.id, name, today, now, JSON.stringify(outcome)],
        );
        done.push({ merchantId: m.id, name, outcome });
      }
    } catch (err) {
      // A bad time zone or a database error for one merchant: report it, go on to the next.
      done.push({ merchantId: m.id, name: SWEEP_NAMES[0], outcome: { status: "error", message: (err as Error).message } });
    }
  }
  return done;
}

function localHour(at: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(at));
}
