// Sweeps (design §9.3): the safety net behind webhooks.
//
//   overdue-invoices    unpaid invoices past their due date → Collections
//   dispute-deadlines   disputes waiting on the merchant, due within 72 h → Disputes
//   weekly-brief        Fridays only: the last 7 days in numbers → Insights
//   workflows           the merchant's due-soon, open-dispute and weekly workflows
//
// A workflow that's on and matches an overdue invoice or a dispute near its
// deadline decides how Pyp handles it (jobs/workflows.ts); the rest get the usual run.
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
import { disputeFacts, enabledWorkflows, firstPlan, invoiceFacts, runPlan, runScheduledWorkflows } from "./workflows";

export const SWEEP_NAMES = ["overdue-invoices", "dispute-deadlines", "weekly-brief", "workflows"] as const;
export type SweepName = (typeof SWEEP_NAMES)[number];

const SKILL: Record<Exclude<SweepName, "workflows">, SkillId> = { "overdue-invoices": "collections", "dispute-deadlines": "disputes", "weekly-brief": "insights" };
/** The weekly brief runs on this merchant-local weekday (design §9.3: Friday). */
export const BRIEF_WEEKDAY = "Fri";
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
  return withSweepLock(deps.pool, merchantId, () => sweepLocked(deps, merchantId, name, limit));
}

/** One sweep (or workflow run) per merchant at a time, across workers and the dashboard. */
export async function withSweepLock<T>(pool: Pool, merchantId: string, fn: () => Promise<T>): Promise<T | { status: "busy" }> {
  const key = `pyp-sweep:${merchantId}`;
  const lock = await pool.connect();
  try {
    const got = await lock.query("select pg_try_advisory_lock(hashtext($1)) as ok", [key]);
    if (!got.rows[0].ok) return { status: "busy" };
    try {
      return await fn();
    } finally {
      await lock.query("select pg_advisory_unlock(hashtext($1))", [key]);
    }
  } finally {
    lock.release();
  }
}

/** A sweep, for a caller that already holds the merchant's sweep lock. */
export async function sweepLocked(deps: SweepDeps, merchantId: string, name: SweepName, limit: number): Promise<SweepOutcome> {
  const now = deps.now ?? (() => new Date());
  const { merchant, rules } = await loadMerchant(deps.pool, merchantId);
  if (rules.killSwitch) return { status: "paused" }; // no model calls while paused

  if (name === "workflows") {
    const r = await runScheduledWorkflows(deps, merchantId);
    if (r.status === "paused") return { status: "paused" };
    return { status: "ok", found: r.found, skipped: r.skipped, deferred: 0, ran: r.ran, cardIds: r.cardIds, failed: r.failed };
  }

  // Kept whole, so a workflow can check code's facts about each one.
  const invoices = name === "overdue-invoices" ? await deps.read.overdueInvoices(localDate(now(), merchant.timezone)) : [];
  const disputes = name === "dispute-deadlines" ? await deps.read.disputesDueBefore(new Date(now().getTime() + DEADLINE_HOURS * 3_600_000)) : [];
  const subjects: SubjectRef[] =
    name === "overdue-invoices"
      ? invoices.map((i) => ({ kind: "invoice", id: i.id }))
      : name === "dispute-deadlines"
        ? disputes.map((d) => ({ kind: "dispute", id: d.id }))
        : [{ kind: "week", id: localDate(now(), merchant.timezone) }];
  const workflows =
    name === "overdue-invoices"
      ? await enabledWorkflows(deps.pool, merchantId, ["invoice_overdue"])
      : name === "dispute-deadlines"
        ? await enabledWorkflows(deps.pool, merchantId, ["dispute_deadline"])
        : [];

  const busy = await busySubjects(deps.pool, merchantId);
  const last = await lastSwept(deps.pool, merchantId);
  // Least recently swept first (never swept before anything); ties keep PayPal's order.
  const todo = subjects
    .filter((s) => !busy.has(subjectRef(s)))
    .map((s, i) => ({ s, i, at: last.get(subjectRef(s)) ?? -Infinity }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.s);
  const ctx = { merchant, rules, read: deps.read, db: engineDb(deps.pool, merchantId), now };
  const skill = getSkill(SKILL[name as Exclude<SweepName, "workflows">]);
  const out = { status: "ok" as const, found: subjects.length, skipped: subjects.length - todo.length, deferred: Math.max(0, todo.length - limit), ran: 0, cardIds: [] as string[], failed: [] as string[] };

  for (const subject of todo.slice(0, limit)) {
    try {
      // The merchant's workflow first: if one matches, it decides how Pyp handles this one.
      if (workflows.length) {
        const inv = invoices.find((i) => i.id === subject.id);
        const dis = disputes.find((d) => d.id === subject.id);
        const facts = inv ? await invoiceFacts(inv, ctx) : dis ? disputeFacts((await deps.read.getDispute?.(dis.id)) ?? dis, now()) : null;
        const found = facts ? firstPlan(workflows, inv ? "invoice" : "dispute", facts) : null;
        if (found) {
          const r = await runPlan(deps, merchantId, ctx, subject, found);
          if (r.status === "failed") out.failed.push(`${subject.id}: ${r.failure ?? "run failed"}`);
          else {
            out.ran++;
            out.cardIds.push(...r.cardIds);
          }
          continue;
        }
      }
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
export async function busySubjects(pool: Pool, merchantId: string): Promise<Set<string>> {
  const res = await pool.query(
    `select distinct r.subject_ref from proposals p join runs r on r.id = p.run_id
      where p.merchant_id = $1
        and (p.status in ('awaiting_approval', 'scheduled', 'executing')
             -- A brief is done once shown: "Weekly brief now" twice doesn't make two.
             or (r.subject_ref like 'week:%' and p.status = 'executed'))`,
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
        if (name === "weekly-brief" && localWeekday(now, m.timezone) !== BRIEF_WEEKDAY) continue;
        // Only for a merchant with a due-soon, open-dispute or weekly workflow switched on.
        if (name === "workflows" && !(await enabledWorkflows(deps.pool, m.id, ["invoice_due_soon", "dispute_opened", "weekly"])).length) continue;
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
        const finished = (deps.now ?? (() => new Date()))(); // when it really ended, not when the tick began
        await deps.pool.query(
          "update sweep_runs set finished_at = $4, outcome = $5 where merchant_id = $1 and name = $2 and local_date = $3",
          [m.id, name, today, finished, JSON.stringify(outcome)],
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

function localWeekday(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-US", { timeZone, weekday: "short" }).format(at);
}

function localHour(at: Date, timeZone: string): number {
  return Number(new Intl.DateTimeFormat("en-US", { timeZone, hour: "numeric", hourCycle: "h23" }).format(at));
}
