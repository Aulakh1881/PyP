// Sweeps (design §9.3): the safety net behind webhooks.
//
//   overdue-invoices    unpaid invoices past their due date → Collections
//   dispute-deadlines   disputes waiting on the merchant, due within 72 h → Disputes
//   weekly-brief        Fridays only: the last 7 days in numbers → Insights
//
// A subject that already has a card waiting, an Auto action in its undo window
// or a follow-up scheduled is skipped: the merchant (or the follow-up) already
// has it. The worker runs both once a day from 08:00 merchant-local
// (runDailySweeps); the dashboard can run one now (POST /api/sweeps/{name}).

import type { Pool } from "pg";
import { localDate } from "@/engine/format";
import { getSkill } from "@/engine/registry";
import { runSkill } from "@/engine/run-skill";
import type { AgentClient, Dispute, Invoice, PayPalReads, SkillId, SubjectRef } from "@/engine/types";
import { engineDb, loadMerchant, saveRun, subjectRef } from "./store";

export const SWEEP_NAMES = ["overdue-invoices", "dispute-deadlines", "weekly-brief"] as const;
export type SweepName = (typeof SWEEP_NAMES)[number];

const SKILL: Record<SweepName, SkillId> = { "overdue-invoices": "collections", "dispute-deadlines": "disputes", "weekly-brief": "insights" };
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
}

export type SweepOutcome =
  | { status: "paused" }
  | { status: "ok"; found: number; skipped: number; ran: number; cardIds: string[]; failed: string[] };

export async function runSweep(deps: SweepDeps, merchantId: string, name: SweepName, limit = SWEEP_LIMIT): Promise<SweepOutcome> {
  const now = deps.now ?? (() => new Date());
  const { merchant, rules } = await loadMerchant(deps.pool, merchantId);
  if (rules.killSwitch) return { status: "paused" }; // no model calls while paused

  const subjects: SubjectRef[] =
    name === "overdue-invoices"
      ? (await deps.read.overdueInvoices(localDate(now(), merchant.timezone))).map((i) => ({ kind: "invoice", id: i.id }))
      : name === "dispute-deadlines"
        ? (await deps.read.disputesDueBefore(new Date(now().getTime() + DEADLINE_HOURS * 3_600_000))).map((d) => ({ kind: "dispute", id: d.id }))
        : [{ kind: "week", id: localDate(now(), merchant.timezone) }];

  const busy = await busySubjects(deps.pool, merchantId);
  const todo = subjects.filter((s) => !busy.has(subjectRef(s)));
  const ctx = { merchant, rules, read: deps.read, db: engineDb(deps.pool, merchantId), now };
  const skill = getSkill(SKILL[name]);
  const out = { status: "ok" as const, found: subjects.length, skipped: subjects.length - todo.length, ran: 0, cardIds: [] as string[], failed: [] as string[] };

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

/**
 * The worker's daily check: for each merchant whose local time is past 08:00,
 * claims today's row in sweep_runs (so each sweep runs once a day, whatever
 * the number of workers) and runs the sweep.
 */
export async function runDailySweeps(deps: SweepDeps): Promise<{ merchantId: string; name: SweepName; outcome: SweepOutcome | { status: "error"; message: string } }[]> {
  const now = (deps.now ?? (() => new Date()))();
  const merchants = await deps.pool.query("select id, timezone from merchants where not kill_switch");
  const done = [];
  for (const m of merchants.rows as { id: string; timezone: string }[]) {
    if (localHour(now, m.timezone) < SWEEP_HOUR) continue;
    for (const name of SWEEP_NAMES) {
      if (name === "weekly-brief" && localWeekday(now, m.timezone) !== BRIEF_WEEKDAY) continue;
      const claimed = await deps.pool.query(
        `insert into sweep_runs (merchant_id, name, local_date) values ($1, $2, $3) on conflict do nothing returning name`,
        [m.id, name, localDate(now, m.timezone)],
      );
      if (!claimed.rows[0]) continue;
      const outcome = await runSweep(deps, m.id, name).catch((err: Error) => ({ status: "error" as const, message: err.message }));
      await deps.pool.query(
        "update sweep_runs set finished_at = now(), outcome = $4 where merchant_id = $1 and name = $2 and local_date = $3",
        [m.id, name, localDate(now, m.timezone), JSON.stringify(outcome)],
      );
      done.push({ merchantId: m.id, name, outcome });
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
