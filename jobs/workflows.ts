// The merchant's workflows (db/migrations/012_workflows.sql, engine/workflows.ts):
// saving them, and running them. A workflow never writes to PayPal: a Then
// becomes an instruction to a skill run limited to the commands it names, and
// the run's proposals go through the same checks, dials and kill switch as any.

import type { Pool } from "pg";
import { daysBetween, localDate, toCents } from "@/engine/format";
import { getSkill } from "@/engine/registry";
import { runSkill } from "@/engine/run-skill";
import type { Dispute, Invoice, SkillContext, SubjectRef } from "@/engine/types";
import {
  actionDef,
  disputeReason,
  evaluate,
  planFor,
  triggerDef,
  whenOf,
  workflowProblems,
  WorkflowGraph,
  type TriggerId,
  type WorkflowFacts,
} from "@/engine/workflows";
import { engineDb, loadMerchant, saveNotice, saveRun, subjectRef } from "./store";
import { busySubjects, DEADLINE_HOURS, SWEEP_LIMIT, sweepLocked, type SweepDeps } from "./sweep-run";

type Db = Pick<Pool, "query">;

export interface StoredWorkflow {
  id: string;
  name: string;
  enabled: boolean;
  graph: WorkflowGraph;
  createdAt: string;
  updatedAt: string;
}

/** True when migration 012 hasn't been run on this database yet. */
export function missingWorkflowsTable(err: unknown): boolean {
  return (err as { code?: string }).code === "42P01";
}

const COLUMNS = "id, name, enabled, graph, created_at, updated_at";

function toWorkflow(row: Record<string, unknown>): StoredWorkflow {
  const parsed = WorkflowGraph.safeParse(row.graph);
  return {
    id: String(row.id),
    name: String(row.name),
    enabled: row.enabled === true,
    graph: parsed.success ? parsed.data : { nodes: [], edges: [] },
    createdAt: new Date(row.created_at as string).toISOString(),
    updatedAt: new Date(row.updated_at as string).toISOString(),
  };
}

export async function listWorkflows(db: Db, merchantId: string): Promise<StoredWorkflow[]> {
  const res = await db.query(`select ${COLUMNS} from workflows where merchant_id = $1 order by created_at`, [merchantId]);
  return res.rows.map(toWorkflow);
}

/** The merchant's workflows that are on, for these triggers. No table yet = none. */
export async function enabledWorkflows(db: Db, merchantId: string, triggers: TriggerId[]): Promise<StoredWorkflow[]> {
  try {
    const all = await listWorkflows(db, merchantId);
    return all.filter((w) => w.enabled && triggers.includes(whenOf(w.graph)?.trigger as TriggerId) && !workflowProblems(w.graph).length);
  } catch (err) {
    if (missingWorkflowsTable(err)) return [];
    throw err;
  }
}

export interface WorkflowInput {
  name: string;
  enabled: boolean;
  graph: WorkflowGraph;
}

/** A workflow with problems is saved switched off (a draft); `problems` says why. */
export async function saveWorkflow(db: Db, merchantId: string, input: WorkflowInput, id?: string): Promise<{ workflow: StoredWorkflow; problems: string[] } | null> {
  const problems = workflowProblems(input.graph);
  const enabled = input.enabled && !problems.length;
  const res = id
    ? await db.query(
        `update workflows set name = $3, enabled = $4, graph = $5, updated_at = now() where merchant_id = $1 and id = $2 returning ${COLUMNS}`,
        [merchantId, id, input.name, enabled, JSON.stringify(input.graph)],
      )
    : await db.query(`insert into workflows (merchant_id, name, enabled, graph) values ($1, $2, $3, $4) returning ${COLUMNS}`, [
        merchantId,
        input.name,
        enabled,
        JSON.stringify(input.graph),
      ]);
  return res.rows[0] ? { workflow: toWorkflow(res.rows[0]), problems } : null;
}

export async function deleteWorkflow(db: Db, merchantId: string, id: string): Promise<boolean> {
  const res = await db.query("delete from workflows where merchant_id = $1 and id = $2", [merchantId, id]);
  return res.rowCount === 1;
}

export async function getWorkflow(db: Db, merchantId: string, id: string): Promise<StoredWorkflow | null> {
  const res = await db.query(`select ${COLUMNS} from workflows where merchant_id = $1 and id = $2`, [merchantId, id]);
  return res.rows[0] ? toWorkflow(res.rows[0]) : null;
}

// ---------- Facts, computed by code ----------

export async function invoiceFacts(inv: Invoice, ctx: Pick<SkillContext, "db" | "now" | "merchant">): Promise<WorkflowFacts> {
  const late = inv.dueDate ? daysBetween(inv.dueDate, ctx.now(), ctx.merchant.timezone) : null;
  const reminders = await ctx.db.remindersSent(inv.id).catch(() => ({ count: 0 }));
  return {
    amountCents: Number(toCents(inv.amountDue)),
    daysOverdue: late,
    daysUntilDue: late === null ? null : -late,
    client: [inv.recipientName, inv.recipientEmail].filter(Boolean).join(" "),
    remindersSent: reminders.count,
  };
}

export function disputeFacts(d: Dispute, now: Date): WorkflowFacts {
  const due = d.sellerResponseDueDate ? Date.parse(d.sellerResponseDueDate) : NaN;
  return {
    amountCents: Number(toCents(d.amount)),
    daysLeft: Number.isFinite(due) ? Math.floor((due - now.getTime()) / 86_400_000) : null,
    reason: disputeReason(d.reason),
    hasTracking: d.tracking.length > 0,
    buyer: d.buyerName,
  };
}

// ---------- Running ----------

export interface WorkflowRunOutcome {
  status: "ok" | "paused" | "waiting";
  found: number;
  matched: number;
  skipped: number;
  ran: number;
  cardIds: string[];
  failed: string[];
  /** Pyp's own words when a run made no card ("too soon for another reminder…"). */
  notes: string[];
  /** For a workflow that only runs on a PayPal event, or a day that isn't today. */
  message?: string;
}

/**
 * The plan for one subject from the first workflow (oldest first) whose diagram
 * reaches a Then that runs a skill. Null: no workflow applies, Pyp does its usual.
 */
export function firstPlan(workflows: StoredWorkflow[], subject: "invoice" | "dispute", facts: WorkflowFacts) {
  for (const w of workflows) {
    const plan = planFor(w.name, subject, evaluate(w.graph, facts));
    if (plan) return { workflow: w, plan };
  }
  return null;
}

/** One skill run from a workflow's plan, saved like any run. */
export async function runPlan(
  deps: Pick<SweepDeps, "pool" | "agent">,
  merchantId: string,
  ctx: SkillContext,
  subject: SubjectRef,
  found: NonNullable<ReturnType<typeof firstPlan>>,
): Promise<{ status: string; cardIds: string[]; failure?: string; summary?: string }> {
  const trigger = `workflow:${found.workflow.name}`;
  const result = await runSkill({
    skill: getSkill(found.plan.skill),
    subject,
    ctx,
    agent: deps.agent,
    trigger,
    instruction: found.plan.instruction,
    onlyCommands: found.plan.commands ?? undefined,
  });
  const saved = await saveRun(deps.pool, { merchantId, skill: found.plan.skill, subject, trigger, result, now: ctx.now() });
  return { status: result.status, cardIds: saved.cardIds, failure: result.failure, summary: result.response?.summary };
}

/**
 * Runs one workflow now, for everything its When block covers today. Called
 * inside the merchant's sweep lock (the daily "workflows" sweep, or Run now).
 * `force` runs a weekly workflow whatever the day (Run now).
 */
export async function runWorkflowLocked(deps: SweepDeps, merchantId: string, w: StoredWorkflow, force = false): Promise<WorkflowRunOutcome> {
  const now = deps.now ?? (() => new Date());
  const out: WorkflowRunOutcome = { status: "ok", found: 0, matched: 0, skipped: 0, ran: 0, cardIds: [], failed: [], notes: [] };
  const { merchant, rules } = await loadMerchant(deps.pool, merchantId);
  if (rules.killSwitch) return { ...out, status: "paused" };
  const when = whenOf(w.graph);
  const trigger = when ? triggerDef(when.trigger) : undefined;
  if (!when || !trigger || workflowProblems(w.graph).length) return { ...out, status: "waiting", message: "Finish this workflow before running it" };
  const ctx = { merchant, rules, read: deps.read, db: engineDb(deps.pool, merchantId), now };

  if (trigger.id === "invoice_paid") {
    return { ...out, status: "waiting", message: "This runs when PayPal tells Pyp an invoice is paid" };
  }

  if (trigger.id === "weekly") {
    const day = new Intl.DateTimeFormat("en-US", { timeZone: merchant.timezone, weekday: "short" }).format(now());
    if (!force && day !== when.params?.weekday) return { ...out, status: "waiting", message: `Runs on ${when.params?.weekday}` };
    out.found = 1;
    for (const t of evaluate(w.graph, {})) {
      const sweep = actionDef(t.action)?.sweep;
      if (!sweep) continue;
      out.matched++;
      const r = await sweepLocked(deps, merchantId, sweep, SWEEP_LIMIT).catch((err: Error) => ({ status: "error" as const, message: err.message }));
      if (r.status === "ok") {
        out.ran += r.ran;
        out.cardIds.push(...r.cardIds);
        out.failed.push(...r.failed);
      } else if (r.status === "error") out.failed.push(`${sweep}: ${r.message}`);
    }
    return out;
  }

  // Invoices or disputes: list what the When covers, with code's facts for each.
  const today = localDate(now(), merchant.timezone);
  let items: { subject: SubjectRef; facts: () => Promise<WorkflowFacts> }[] = [];
  if (trigger.id === "invoice_overdue") {
    const list = await deps.read.overdueInvoices(today);
    items = list.map((i) => ({ subject: { kind: "invoice", id: i.id }, facts: () => invoiceFacts(i, ctx) }));
  } else if (trigger.id === "invoice_due_soon") {
    const days = Number(when.params?.days ?? 3);
    const unpaid = (await deps.read.unpaidInvoices?.()) ?? [];
    const soon = unpaid.filter((i) => {
      if (!i.dueDate) return false;
      const left = -daysBetween(i.dueDate, now(), merchant.timezone);
      return left >= 0 && left <= days;
    });
    items = soon.map((i) => ({ subject: { kind: "invoice", id: i.id }, facts: () => invoiceFacts(i, ctx) }));
  } else {
    const horizon = trigger.id === "dispute_deadline" ? DEADLINE_HOURS * 3_600_000 : 365 * 86_400_000;
    const list = await deps.read.disputesDueBefore(new Date(now().getTime() + horizon));
    items = list.map((d) => ({
      subject: { kind: "dispute", id: d.id },
      // Tracking comes with the full read.
      facts: async () => disputeFacts((await deps.read.getDispute?.(d.id)) ?? d, now()),
    }));
  }

  out.found = items.length;
  const busy = await busySubjects(deps.pool, merchantId);
  const subjectKind = trigger.subject === "dispute" ? "dispute" : "invoice";
  for (const item of items) {
    if (busy.has(subjectRef(item.subject))) {
      out.skipped++;
      continue;
    }
    if (out.ran >= SWEEP_LIMIT) break;
    try {
      const found = firstPlan([w], subjectKind, await item.facts());
      if (!found) continue; // this one doesn't match the workflow's checks
      out.matched++;
      const r = await runPlan(deps, merchantId, ctx, item.subject, found);
      if (r.status === "failed") out.failed.push(`${item.subject.id}: ${r.failure ?? "run failed"}`);
      else {
        out.ran++;
        out.cardIds.push(...r.cardIds);
        if (!r.cardIds.length && r.summary) out.notes.push(r.summary);
      }
    } catch (err) {
      out.failed.push(`${item.subject.id}: ${(err as Error).message}`);
    }
  }
  return out;
}

/** The daily "workflows" sweep: due-soon, open-dispute and weekly workflows that are on. */
export async function runScheduledWorkflows(deps: SweepDeps, merchantId: string): Promise<WorkflowRunOutcome> {
  const total: WorkflowRunOutcome = { status: "ok", found: 0, matched: 0, skipped: 0, ran: 0, cardIds: [], failed: [], notes: [] };
  for (const w of await enabledWorkflows(deps.pool, merchantId, ["invoice_due_soon", "dispute_opened", "weekly"])) {
    const r = await runWorkflowLocked(deps, merchantId, w);
    if (r.status === "paused") return r;
    total.found += r.found;
    total.matched += r.matched;
    total.skipped += r.skipped;
    total.ran += r.ran;
    total.cardIds.push(...r.cardIds);
    total.notes.push(...r.notes);
    total.failed.push(...r.failed.map((f) => `${w.name}: ${f}`));
  }
  return total;
}

/**
 * A paid invoice (a PayPal event): "invoice is paid" workflows that are on leave
 * a heads-up in the Inbox. No model call, nothing sent anywhere.
 */
export async function runPaidWorkflows(pool: Pool, merchantId: string, inv: Invoice, ctx: SkillContext): Promise<string[]> {
  const cardIds: string[] = [];
  const facts = await invoiceFacts(inv, ctx);
  for (const w of await enabledWorkflows(pool, merchantId, ["invoice_paid"])) {
    const tell = evaluate(w.graph, facts).some((t) => actionDef(t.action)?.notice);
    if (!tell) continue;
    const who = inv.recipientName ?? inv.recipientEmail ?? "Your client";
    const id = await saveNotice(pool, {
      merchantId,
      subject: { kind: "invoice", id: inv.id },
      trigger: `workflow:${w.name}`,
      title: `Invoice ${inv.number} is paid`,
      subtitle: `${who} · ${inv.currency} ${inv.total}`,
      body: `${who} paid invoice ${inv.number}.`,
      reason: `From your workflow “${w.name}”.`,
    });
    cardIds.push(id);
  }
  return cardIds;
}
