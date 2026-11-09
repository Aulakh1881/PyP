// The merchant's custom skills (db/migrations/014_custom_skills.sql,
// engine/custom-skills.ts): saving them, running them on their schedule, and
// "Try it" dry runs. A custom skill never writes to PayPal: each matching
// invoice or dispute becomes a skill run limited to the actions the merchant
// allowed, and its proposals go through the same checks, dials and kill switch.

import type { Pool } from "pg";
import { nextRun, passesFilters, SKILL_ACTIONS, skillPlan, skillProblems, SkillSpec, watchDef } from "@/engine/custom-skills";
import { getSkill } from "@/engine/registry";
import { runSkill } from "@/engine/run-skill";
import type { CommandId } from "@/engine/types";
import { engineDb, loadMerchant, saveRun, subjectRef } from "./store";
import { busySubjects, SWEEP_LIMIT, withSweepLock, type SweepDeps } from "./sweep-run";
import { subjectsFor } from "./workflows";

type Db = Pick<Pool, "query">;

export interface StoredSkill {
  id: string;
  name: string;
  enabled: boolean;
  spec: SkillSpec;
  nextRunAt: string | null;
  lastRunAt: string | null;
  lastOutcome: SkillRunOutcome | null;
  createdAt: string;
  updatedAt: string;
}

/** A "Try it" run looks at this many invoices or disputes at most (each is a model call). */
export const TRY_LIMIT = 3;
/** A scheduled run that found another check running tries again this many minutes later. */
export const BUSY_RETRY_MINUTES = 5;
/** A scheduled run that failed (PayPal or the database down) tries again this many minutes later, until its next time. */
export const ERROR_RETRY_MINUTES = 15;

/** True when migration 014 hasn't been run on this database yet. */
export function missingSkillsTable(err: unknown): boolean {
  return (err as { code?: string }).code === "42P01";
}

const COLUMNS = "id, name, enabled, spec, next_run_at, last_run_at, last_outcome, created_at, updated_at";
const EMPTY_SPEC: SkillSpec = { watch: "invoice_overdue", filters: [], schedule: { kind: "manual" }, actions: [], playbook: "", tone: "neutral" };

const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);

function toSkill(row: Record<string, unknown>): StoredSkill {
  const parsed = SkillSpec.safeParse(row.spec);
  return {
    id: String(row.id),
    name: String(row.name),
    enabled: row.enabled === true,
    spec: parsed.success ? parsed.data : EMPTY_SPEC,
    nextRunAt: iso(row.next_run_at),
    lastRunAt: iso(row.last_run_at),
    lastOutcome: (row.last_outcome as SkillRunOutcome | null) ?? null,
    createdAt: iso(row.created_at)!,
    updatedAt: iso(row.updated_at)!,
  };
}

export async function listSkills(db: Db, merchantId: string): Promise<StoredSkill[]> {
  const res = await db.query(`select ${COLUMNS} from custom_skills where merchant_id = $1 order by created_at`, [merchantId]);
  return res.rows.map(toSkill);
}

export async function getSkillById(db: Db, merchantId: string, id: string): Promise<StoredSkill | null> {
  const res = await db.query(`select ${COLUMNS} from custom_skills where merchant_id = $1 and id = $2`, [merchantId, id]);
  return res.rows[0] ? toSkill(res.rows[0]) : null;
}

export interface SkillInput {
  name: string;
  enabled: boolean;
  spec: SkillSpec;
}

/**
 * Saves a skill. One with problems is saved switched off (a draft). Switching
 * one on, or changing its schedule, sets its next run from now; other edits
 * (a rename, the playbook) keep the next run, so "every 5 days" keeps its rhythm.
 */
export async function saveSkill(
  db: Db,
  merchantId: string,
  input: SkillInput,
  opts: { id?: string; now: Date; timeZone: string },
): Promise<{ skill: StoredSkill; problems: string[] } | null> {
  const problems = skillProblems(input.spec);
  const enabled = input.enabled && !problems.length;
  const next = enabled ? nextRun(input.spec.schedule, opts.now, opts.timeZone, opts.now) : null;
  const res = opts.id
    ? await db.query(
        `update custom_skills set name = $3, enabled = $4, spec = $5, updated_at = now(),
                next_run_at = case when $4 and enabled and next_run_at is not null and spec->'schedule' = $5::jsonb->'schedule'
                                   then next_run_at else $6::timestamptz end
          where merchant_id = $1 and id = $2 returning ${COLUMNS}`,
        [merchantId, opts.id, input.name, enabled, JSON.stringify(input.spec), next],
      )
    : await db.query(`insert into custom_skills (merchant_id, name, enabled, spec, next_run_at) values ($1, $2, $3, $4, $5) returning ${COLUMNS}`, [
        merchantId,
        input.name,
        enabled,
        JSON.stringify(input.spec),
        next,
      ]);
  return res.rows[0] ? { skill: toSkill(res.rows[0]), problems } : null;
}

export async function deleteSkill(db: Db, merchantId: string, id: string): Promise<boolean> {
  const res = await db.query("delete from custom_skills where merchant_id = $1 and id = $2", [merchantId, id]);
  return res.rowCount === 1;
}

// ---------- Running ----------

/** What a "Try it" run would have done for one invoice or dispute. Nothing was saved or sent. */
export interface SkillPreview {
  subject: { kind: string; id: string };
  title: string | null;
  summary: string | null;
  /** Each action Pyp proposed, and what would happen to it (a card, Auto with undo, or refused). */
  actions: { label: string; outcome: "would ask you" | "would run on Auto (with undo)" | "refused by the checks" | "blocked"; reason: string }[];
  failure?: string;
}

export interface SkillRunOutcome {
  status: "ok" | "paused" | "waiting" | "error";
  at: string;
  /** How many invoices or disputes the skill watches right now. */
  found: number;
  /** How many passed its checks. */
  matched: number;
  /** Already has a card waiting or an action in its undo window. */
  skipped: number;
  ran: number;
  cardIds: string[];
  failed: string[];
  /** Pyp's own words when a run made no card. */
  notes: string[];
  previews?: SkillPreview[];
  message?: string;
  /** Failed scheduled runs in a row, for the retry backoff. */
  failures?: number;
}

const LABEL = (cmd: string) => SKILL_ACTIONS.find((a) => a.command === cmd)?.label ?? (cmd === "merchant.ask" ? "Ask you a question" : cmd);

/**
 * Runs one skill now, for everything it watches that passes its checks. Called
 * inside the merchant's sweep lock. `dryRun` ("Try it") runs Pyp's decision
 * for up to TRY_LIMIT of them and saves nothing: no run, no card, no write.
 */
export async function runSkillLocked(deps: SweepDeps, merchantId: string, s: StoredSkill, opts: { dryRun?: boolean } = {}): Promise<SkillRunOutcome> {
  const now = deps.now ?? (() => new Date());
  const out: SkillRunOutcome = { status: "ok", at: now().toISOString(), found: 0, matched: 0, skipped: 0, ran: 0, cardIds: [], failed: [], notes: [] };
  if (opts.dryRun) out.previews = [];
  const { merchant, rules } = await loadMerchant(deps.pool, merchantId);
  if (rules.killSwitch) return { ...out, status: "paused", message: "Pyp is paused. Turn it back on in Settings." };
  const plan = skillPlan(s.name, s.spec);
  const watch = watchDef(s.spec.watch);
  if (!plan || !watch) return { ...out, status: "waiting", message: "Finish this skill before running it" };

  const ctx = { merchant, rules, read: deps.read, db: engineDb(deps.pool, merchantId), now };
  const items = await subjectsFor(deps, ctx, watch.id, s.spec.dueWithinDays ?? 3);
  out.found = items.length;
  const busy = await busySubjects(deps.pool, merchantId);
  const limit = opts.dryRun ? TRY_LIMIT : SWEEP_LIMIT;
  const trigger = `skill:${s.name}`;
  // Least recently handled by this skill first (never before anything), so the
  // per-run cap never leaves the same invoices or disputes out run after run.
  const last = await lastRunBySkill(deps.pool, merchantId, trigger);
  const ordered = items
    .map((item, i) => ({ item, i, at: last.get(subjectRef(item.subject)) ?? -Infinity }))
    .sort((a, b) => a.at - b.at || a.i - b.i)
    .map((x) => x.item);
  const askFirst = { commands: plan.askFirst, reason: `Your skill “${s.name}” asks you first` };

  for (const item of ordered) {
    if (out.ran >= limit) break;
    try {
      if (!passesFilters(s.spec, await item.facts())) continue;
      out.matched++;
      if (busy.has(subjectRef(item.subject))) {
        out.skipped++;
        continue;
      }
      const result = await runSkill({
        skill: getSkill(plan.skill),
        subject: item.subject,
        ctx,
        agent: deps.agent,
        trigger: opts.dryRun ? `${trigger} (try it)` : trigger,
        instruction: plan.instruction,
        instructionKind: "standing",
        onlyCommands: plan.commands,
        askFirst,
      });
      out.ran++;
      if (opts.dryRun) {
        out.previews!.push(preview(item.subject, result));
        continue;
      }
      // A failed run is still saved, so its trace shows what went wrong.
      const saved = await saveRun(deps.pool, { merchantId, skill: plan.skill, subject: item.subject, trigger, result, now: now() });
      if (result.status === "failed") out.failed.push(`${item.subject.id}: ${result.failure ?? "run failed"}`);
      else {
        out.cardIds.push(...saved.cardIds);
        if (!saved.cardIds.length && result.response?.summary) out.notes.push(result.response.summary);
      }
    } catch (err) {
      // One subject failing (PayPal down, the spend cap) never stops the rest.
      out.failed.push(`${item.subject.id}: ${(err as Error).message}`);
    }
  }
  return out;
}

async function lastRunBySkill(pool: Pool, merchantId: string, trigger: string): Promise<Map<string, number>> {
  const res = await pool.query("select subject_ref, max(started_at) as at from runs where merchant_id = $1 and trigger = $2 group by subject_ref", [merchantId, trigger]);
  return new Map(res.rows.map((r) => [r.subject_ref as string, new Date(r.at).getTime()]));
}

function preview(subject: { kind: string; id: string }, result: Awaited<ReturnType<typeof runSkill>>): SkillPreview {
  const p: SkillPreview = { subject, title: result.response?.title ?? null, summary: result.response?.summary ?? null, actions: [] };
  if (result.status === "failed") p.failure = result.failure ?? "The run failed";
  for (const prop of result.proposals) {
    const label = LABEL(prop.action.command as CommandId);
    if (prop.status === "invalid") p.actions.push({ label, outcome: "refused by the checks", reason: prop.check.ok ? "" : (prop.check.reason ?? "") });
    else if (prop.status === "blocked") p.actions.push({ label, outcome: "blocked", reason: prop.policy?.reason ?? "" });
    else if (prop.status === "scheduled") p.actions.push({ label, outcome: "would run on Auto (with undo)", reason: prop.policy?.reason ?? "" });
    else p.actions.push({ label, outcome: "would ask you", reason: prop.policy?.reason ?? "" });
  }
  return p;
}

async function recordRun(db: Db, merchantId: string, id: string, outcome: SkillRunOutcome): Promise<void> {
  // Previews are for the page that asked; the stored outcome keeps the counts.
  const kept: SkillRunOutcome = { ...outcome };
  delete kept.previews;
  await db.query("update custom_skills set last_run_at = $3, last_outcome = $4 where merchant_id = $1 and id = $2", [
    merchantId,
    id,
    outcome.at,
    JSON.stringify(kept),
  ]);
}

/** "Run now" or "Try it" on one skill, under the merchant's sweep lock. */
export async function runSkillNow(deps: SweepDeps, merchantId: string, id: string, opts: { dryRun?: boolean } = {}) {
  const s = await getSkillById(deps.pool, merchantId, id);
  if (!s) return null;
  const out = await withSweepLock(deps.pool, merchantId, () => runSkillLocked(deps, merchantId, s, opts));
  if (!opts.dryRun && out.status !== "busy") await recordRun(deps.pool, merchantId, id, out);
  return out;
}

/**
 * The worker's check: runs every switched-on skill whose next run has come,
 * then sets its next run from the schedule. Claiming moves next_run_at first
 * (a conditional update), so with several workers each run happens once.
 * Paused merchants' skills move on to their next time without a backlog.
 */
export async function runDueSkills(deps: SweepDeps): Promise<{ skillId: string; name: string; outcome: SkillRunOutcome | { status: "busy" | "error"; message?: string } }[]> {
  const now = (deps.now ?? (() => new Date()))();
  let due;
  try {
    due = await deps.pool.query(
      `select s.${COLUMNS.split(", ").join(", s.")}, s.merchant_id, m.timezone
         from custom_skills s join merchants m on m.id = s.merchant_id
        where s.enabled and s.next_run_at <= $1 ${deps.merchantIds ? "and s.merchant_id = any($2::uuid[])" : ""}
        order by s.next_run_at limit 20`,
      deps.merchantIds ? [now, deps.merchantIds] : [now],
    );
  } catch (err) {
    if (missingSkillsTable(err)) return [];
    throw err;
  }
  const done: { skillId: string; name: string; outcome: SkillRunOutcome | { status: "busy" | "error"; message?: string } }[] = [];
  for (const row of due.rows as Record<string, unknown>[]) {
    const s = toSkill(row);
    const merchantId = String(row.merchant_id);
    // "Every N days" counts from when it was due, so a late run or a retry keeps the rhythm.
    const dueAt = new Date(row.next_run_at as string);
    const next = nextRun(s.spec.schedule, now, String(row.timezone), dueAt);
    // Atomic: only one worker moves a due, switched-on skill to its next time.
    const claimed = await deps.pool.query("update custom_skills set next_run_at = $3 where id = $1 and enabled and next_run_at <= $2 returning id", [s.id, now, next]);
    if (!claimed.rows[0]) continue; // another worker has it, or it was switched off
    // Try again soon, but never later than the next scheduled time. Only if the row still holds what
    // the claim wrote: a skill switched off or rescheduled meanwhile keeps the merchant's change.
    const retryIn = async (minutes: number) => {
      const at = new Date(now.getTime() + minutes * 60_000);
      if (!next || at < next) {
        await deps.pool.query("update custom_skills set next_run_at = $2 where id = $1 and enabled and next_run_at is not distinct from $3", [s.id, at, next]);
      }
    };
    try {
      const out = await withSweepLock(deps.pool, merchantId, () => runSkillLocked(deps, merchantId, s));
      if (out.status === "busy") {
        await retryIn(BUSY_RETRY_MINUTES); // another check is running
        done.push({ skillId: s.id, name: s.name, outcome: out });
        continue;
      }
      await recordRun(deps.pool, merchantId, s.id, out);
      done.push({ skillId: s.id, name: s.name, outcome: out });
    } catch (err) {
      // PayPal or the database failed before any subject ran: say so on the page and try again.
      const message = (err as Error).message;
      const out: SkillRunOutcome = { status: "error", at: now.toISOString(), found: 0, matched: 0, skipped: 0, ran: 0, cardIds: [], failed: [message], notes: [], message };
      // Back off while it keeps failing: 15 min, 30, 60… up to a day (PayPal reads only; no model calls).
      const failures = s.lastOutcome?.status === "error" ? (s.lastOutcome.failures ?? 1) + 1 : 1;
      out.failures = failures;
      await recordRun(deps.pool, merchantId, s.id, out).catch(() => {});
      await retryIn(Math.min(ERROR_RETRY_MINUTES * 2 ** (failures - 1), 24 * 60)).catch(() => {});
      done.push({ skillId: s.id, name: s.name, outcome: { status: "error", message } });
    }
  }
  return done;
}

