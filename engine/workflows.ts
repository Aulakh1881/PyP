// Workflows: the merchant's own rules for how Pyp handles something, drawn as
// blocks. "When" (a PayPal event or a schedule) → "If" (a check on code's facts)
// → "Then" (what Pyp should do). A workflow works like a custom case file: it
// doesn't act by itself. Its Then becomes the merchant's instruction to a skill,
// and limits the skill to the actions it names (plus asking the merchant), so
// every proposal still goes through the checks, the dials, the undo window and
// the kill switch. A workflow can't do anything the merchant couldn't approve by hand.
//
// Code walks the diagram: conditions compare numbers code computed (money in
// cents), never anything the model said.

import { z } from "zod";
import type { CommandId, SkillId } from "./types";

// ---------- The catalog: every block a merchant can use ----------

export type WorkflowSubject = "invoice" | "dispute" | "week";

export type TriggerId = "invoice_overdue" | "invoice_due_soon" | "invoice_paid" | "dispute_opened" | "dispute_deadline" | "weekly";

export type ParamDef =
  | { key: string; label: string; type: "number"; min: number; max: number; default: number; unit?: string }
  | { key: string; label: string; type: "select"; options: { value: string; label: string }[]; default: string };

export interface TriggerDef {
  id: TriggerId;
  label: string;
  /** When it runs, in the merchant's words. */
  when: string;
  subject: WorkflowSubject;
  params: ParamDef[];
}

export type FieldType = "money" | "number" | "text" | "choice" | "yesno";

export interface FieldDef {
  id: string;
  label: string;
  type: FieldType;
  subject: WorkflowSubject;
  options?: { value: string; label: string }[];
}

export type ActionId =
  | "remind"
  | "follow_up"
  | "ask_me"
  | "cancel"
  | "pyp_decides"
  | "tell_me"
  | "offer_refund"
  | "send_proof"
  | "weekly_brief"
  | "check_overdue"
  | "check_disputes";

export interface ActionDef {
  id: ActionId;
  label: string;
  /** The triggers it can follow. */
  triggers: TriggerId[];
  params: ParamDef[];
  /** A skill run limited to these commands (merchant.ask is always allowed). Null: any of the skill's. */
  run?: { skill: SkillId; commands: CommandId[] | null };
  /** A sweep the workflow runs (weekly workflows). */
  sweep?: "weekly-brief" | "overdue-invoices" | "dispute-deadlines";
  /** No model call: a heads-up card in the Inbox. */
  notice?: true;
}

const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"];
const INVOICE_OPEN: TriggerId[] = ["invoice_overdue", "invoice_due_soon"];
const DISPUTES: TriggerId[] = ["dispute_opened", "dispute_deadline"];

export const TRIGGERS: TriggerDef[] = [
  { id: "invoice_overdue", label: "An invoice is overdue", when: "Every morning, for each unpaid invoice past its due date", subject: "invoice", params: [] },
  {
    id: "invoice_due_soon",
    label: "An invoice is due soon",
    when: "Every morning, for each unpaid invoice due within the days you pick",
    subject: "invoice",
    params: [{ key: "days", label: "Due within", type: "number", min: 1, max: 30, default: 3, unit: "days" }],
  },
  { id: "invoice_paid", label: "An invoice is paid", when: "As soon as PayPal tells Pyp a payment came in", subject: "invoice", params: [] },
  { id: "dispute_opened", label: "A dispute needs a response", when: "Every morning, for each dispute waiting on you", subject: "dispute", params: [] },
  { id: "dispute_deadline", label: "A dispute deadline is near", when: "Every morning, for disputes due within 3 days", subject: "dispute", params: [] },
  {
    id: "weekly",
    label: "Every week",
    when: "Once a week, on the day you pick, from 8:00",
    subject: "week",
    params: [{ key: "weekday", label: "On", type: "select", options: WEEKDAYS.map((d) => ({ value: d, label: d })), default: "Mon" }],
  },
];

export const FIELDS: FieldDef[] = [
  { id: "amount", label: "Amount", type: "money", subject: "invoice" },
  { id: "days_overdue", label: "Days overdue", type: "number", subject: "invoice" },
  { id: "days_until_due", label: "Days until due", type: "number", subject: "invoice" },
  { id: "client", label: "Client", type: "text", subject: "invoice" },
  { id: "reminders_sent", label: "Reminders sent", type: "number", subject: "invoice" },
  { id: "amount", label: "Amount", type: "money", subject: "dispute" },
  { id: "days_left", label: "Days left to respond", type: "number", subject: "dispute" },
  {
    id: "reason",
    label: "Reason",
    type: "choice",
    subject: "dispute",
    options: [
      { value: "not_received", label: "Not received" },
      { value: "not_as_described", label: "Not as described" },
      { value: "unauthorized", label: "Unauthorized" },
      { value: "other", label: "Something else" },
    ],
  },
  { id: "has_tracking", label: "Has tracking", type: "yesno", subject: "dispute" },
  { id: "buyer", label: "Buyer", type: "text", subject: "dispute" },
];

export const OPS: Record<FieldType, { value: string; label: string }[]> = {
  money: [
    { value: "gte", label: "is at least" },
    { value: "lt", label: "is less than" },
  ],
  number: [
    { value: "gte", label: "is at least" },
    { value: "lt", label: "is less than" },
  ],
  text: [{ value: "contains", label: "contains" }],
  choice: [{ value: "is", label: "is" }],
  yesno: [{ value: "is", label: "is" }],
};

export const ACTIONS: ActionDef[] = [
  {
    id: "remind",
    label: "Send a reminder",
    triggers: ["invoice_overdue"],
    params: [{ key: "tone", label: "Tone", type: "select", options: [{ value: "friendly", label: "Friendly" }, { value: "firm", label: "Firm" }], default: "friendly" }],
    run: { skill: "collections", commands: ["invoice.sendReminder"] },
  },
  {
    id: "follow_up",
    label: "Check again later",
    triggers: INVOICE_OPEN,
    params: [{ key: "days", label: "In", type: "number", min: 1, max: 30, default: 7, unit: "days" }],
    run: { skill: "collections", commands: ["invoice.scheduleFollowUp"] },
  },
  { id: "cancel", label: "Cancel the invoice", triggers: ["invoice_overdue"], params: [], run: { skill: "collections", commands: ["invoice.cancel"] } },
  { id: "ask_me", label: "Ask me what to do", triggers: [...INVOICE_OPEN, ...DISPUTES], params: [], run: { skill: "collections", commands: [] } },
  { id: "pyp_decides", label: "Let Pyp decide", triggers: [...INVOICE_OPEN, ...DISPUTES], params: [], run: { skill: "collections", commands: null } },
  { id: "offer_refund", label: "Offer a full refund", triggers: DISPUTES, params: [], run: { skill: "disputes", commands: ["dispute.makeOffer"] } },
  { id: "send_proof", label: "Send tracking as proof", triggers: DISPUTES, params: [], run: { skill: "disputes", commands: ["dispute.provideEvidence"] } },
  { id: "tell_me", label: "Tell me in the Inbox", triggers: ["invoice_paid"], params: [], notice: true },
  { id: "weekly_brief", label: "Make the weekly brief", triggers: ["weekly"], params: [], sweep: "weekly-brief" },
  { id: "check_overdue", label: "Check overdue invoices", triggers: ["weekly"], params: [], sweep: "overdue-invoices" },
  { id: "check_disputes", label: "Check dispute deadlines", triggers: ["weekly"], params: [], sweep: "dispute-deadlines" },
];

export const CATALOG = { triggers: TRIGGERS, fields: FIELDS, ops: OPS, actions: ACTIONS };

export const triggerDef = (id: string) => TRIGGERS.find((t) => t.id === id);
export const actionDef = (id: string) => ACTIONS.find((a) => a.id === id);
export const fieldDef = (subject: WorkflowSubject, id: string) => FIELDS.find((f) => f.subject === subject && f.id === id);

/** The skill an action runs for a subject (ask_me and pyp_decides follow the subject). */
export function skillFor(action: ActionDef, subject: WorkflowSubject): SkillId | null {
  if (!action.run) return null;
  if (action.id === "ask_me" || action.id === "pyp_decides") return subject === "dispute" ? "disputes" : "collections";
  return action.run.skill;
}

// ---------- The diagram ----------

const id = z.string().regex(/^[a-z0-9_-]{1,40}$/i);
const params = z.record(z.string().max(40), z.union([z.string().max(40), z.number().finite()]));

export const WorkflowNode = z.discriminatedUnion("type", [
  z.object({ id, type: z.literal("when"), x: z.number().finite().optional(), y: z.number().finite().optional(), trigger: z.string().max(40), params: params.optional() }),
  z.object({
    id,
    type: z.literal("if"),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    field: z.string().max(40),
    op: z.string().max(20),
    value: z.union([z.string().max(120), z.number().finite()]),
  }),
  z.object({
    id,
    type: z.literal("then"),
    x: z.number().finite().optional(),
    y: z.number().finite().optional(),
    action: z.string().max(40),
    params: params.optional(),
    /** The merchant's own words to Pyp: the "custom case file" part. */
    note: z.string().max(300).optional(),
  }),
]);
export type WorkflowNode = z.infer<typeof WorkflowNode>;

export const WorkflowEdge = z.object({ from: id, to: id, branch: z.enum(["yes", "no"]).optional() });
export type WorkflowEdge = z.infer<typeof WorkflowEdge>;

export const WorkflowGraph = z.object({ nodes: z.array(WorkflowNode).max(30), edges: z.array(WorkflowEdge).max(60) });
export type WorkflowGraph = z.infer<typeof WorkflowGraph>;

/**
 * What's wrong with a diagram, in the merchant's words. Empty means it can be
 * turned on. A workflow with problems can still be saved as a draft.
 */
export function workflowProblems(graph: WorkflowGraph): string[] {
  const problems: string[] = [];
  const whens = graph.nodes.filter((n) => n.type === "when");
  if (whens.length !== 1) return [whens.length ? "Use one When block" : "Add a When block to say when this runs"];
  const when = whens[0] as Extract<WorkflowNode, { type: "when" }>;
  const trigger = triggerDef(when.trigger);
  if (!trigger) return ["Pick when this runs"];
  for (const p of trigger.params) {
    if (!paramOk(p, when.params?.[p.key])) problems.push(`When: pick ${p.label.toLowerCase()}`);
  }

  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  if (byId.size !== graph.nodes.length) problems.push("Two blocks share an id");
  const incoming = new Map<string, number>();
  for (const e of graph.edges) {
    const from = byId.get(e.from);
    const to = byId.get(e.to);
    if (!from || !to) {
      problems.push("An arrow points at a block that isn't there");
      continue;
    }
    if (from.type === "then") problems.push("A Then block is the end of a path: nothing comes after it");
    if (to.type === "when") problems.push("Nothing can lead into the When block");
    if (from.type === "if" && !e.branch) problems.push("An arrow from an If block must be Yes or Otherwise");
    if (from.type !== "if" && e.branch) problems.push("Only If blocks have Yes and Otherwise");
    incoming.set(e.to, (incoming.get(e.to) ?? 0) + 1);
  }
  for (const [to, n] of incoming) if (n > 1) problems.push(`${label(byId.get(to))} has more than one arrow coming in`);

  // Everything must hang off the When block.
  const reached = reachable(graph, when.id);
  const loose = graph.nodes.filter((n) => !reached.has(n.id));
  if (loose.length) problems.push(`Connect ${loose.length === 1 ? "this block" : `these ${loose.length} blocks`}: ${loose.map(label).join(", ")}`);

  for (const n of graph.nodes) {
    if (n.type === "if") {
      const field = fieldDef(trigger.subject, n.field);
      if (!field) problems.push(`If: pick something to check for ${trigger.label.toLowerCase()}`);
      else {
        if (!OPS[field.type].some((o) => o.value === n.op)) problems.push(`If ${field.label.toLowerCase()}: pick how to compare`);
        if (!valueOk(field, n.value)) problems.push(`If ${field.label.toLowerCase()}: enter a value`);
      }
      const outs = graph.edges.filter((e) => e.from === n.id);
      if (!outs.length) problems.push(`If ${field?.label.toLowerCase() ?? ""}: add what happens next`.replace("If :", "If:"));
    }
    if (n.type === "then") {
      const action = actionDef(n.action);
      if (!action) problems.push("Then: pick what Pyp should do");
      else {
        if (!action.triggers.includes(trigger.id)) problems.push(`"${action.label}" doesn't go with "${trigger.label}"`);
        for (const p of action.params) if (!paramOk(p, n.params?.[p.key])) problems.push(`${action.label}: pick ${p.label.toLowerCase()}`);
      }
    }
  }
  if (!graph.nodes.some((n) => n.type === "then" && reached.has(n.id))) problems.push("Add a Then block: what should Pyp do?");
  if (hasCycle(graph)) problems.push("Arrows go round in a circle");
  return [...new Set(problems)];
}

function label(n: WorkflowNode | undefined): string {
  if (!n) return "a block";
  if (n.type === "when") return "When";
  if (n.type === "if") return `If ${FIELDS.find((f) => f.id === n.field)?.label.toLowerCase() ?? "…"}`;
  return actionDef(n.action)?.label ?? "Then";
}

function paramOk(p: ParamDef, v: unknown): boolean {
  if (p.type === "number") return typeof v === "number" && Number.isInteger(v) && v >= p.min && v <= p.max;
  return typeof v === "string" && p.options.some((o) => o.value === v);
}

function valueOk(field: FieldDef, v: unknown): boolean {
  switch (field.type) {
    case "money":
      return typeof v === "string" ? /^\d{1,9}(\.\d{1,2})?$/.test(v) : typeof v === "number" && v >= 0 && v < 1e9;
    case "number":
      return typeof v === "number" && Number.isInteger(v) && v >= -3650 && v <= 3650;
    case "text":
      return typeof v === "string" && v.trim().length > 0;
    case "choice":
      return typeof v === "string" && (field.options ?? []).some((o) => o.value === v);
    case "yesno":
      return v === "yes" || v === "no";
  }
}

function reachable(graph: WorkflowGraph, start: string): Set<string> {
  const seen = new Set([start]);
  const queue = [start];
  while (queue.length) {
    const at = queue.shift()!;
    for (const e of graph.edges) {
      if (e.from !== at || seen.has(e.to)) continue;
      seen.add(e.to);
      queue.push(e.to);
    }
  }
  return seen;
}

function hasCycle(graph: WorkflowGraph): boolean {
  const state = new Map<string, 1 | 2>();
  const visit = (n: string): boolean => {
    if (state.get(n) === 1) return true;
    if (state.get(n) === 2) return false;
    state.set(n, 1);
    for (const e of graph.edges) if (e.from === n && visit(e.to)) return true;
    state.set(n, 2);
    return false;
  };
  return graph.nodes.some((n) => visit(n.id));
}

// ---------- Running: code walks the diagram ----------

/** Facts code computed about one invoice or dispute. Money is in cents. */
export interface WorkflowFacts {
  amountCents?: number;
  daysOverdue?: number | null;
  daysUntilDue?: number | null;
  client?: string | null;
  remindersSent?: number;
  daysLeft?: number | null;
  reason?: "not_received" | "not_as_described" | "unauthorized" | "other";
  hasTracking?: boolean;
  buyer?: string | null;
}

export function whenOf(graph: WorkflowGraph): Extract<WorkflowNode, { type: "when" }> | null {
  return (graph.nodes.find((n) => n.type === "when") as Extract<WorkflowNode, { type: "when" }> | undefined) ?? null;
}

/** The Then blocks this subject reaches, following Yes or Otherwise at each If. */
export function evaluate(graph: WorkflowGraph, facts: WorkflowFacts): Extract<WorkflowNode, { type: "then" }>[] {
  const when = whenOf(graph);
  const subject = when ? triggerDef(when.trigger)?.subject : undefined;
  if (!when || !subject) return [];
  const byId = new Map(graph.nodes.map((n) => [n.id, n]));
  const out: Extract<WorkflowNode, { type: "then" }>[] = [];
  const seen = new Set<string>();
  const walk = (nodeId: string, depth: number) => {
    if (depth > 40 || seen.has(nodeId)) return;
    seen.add(nodeId);
    const node = byId.get(nodeId);
    if (!node) return;
    if (node.type === "then") {
      out.push(node);
      return;
    }
    const branch = node.type === "if" ? (check(subject, node, facts) ? "yes" : "no") : undefined;
    for (const e of graph.edges) if (e.from === nodeId && e.branch === branch) walk(e.to, depth + 1);
  };
  walk(when.id, 0);
  return out;
}

/** One If check. A fact code doesn't have counts as "no". */
export function check(subject: WorkflowSubject, node: Extract<WorkflowNode, { type: "if" }>, facts: WorkflowFacts): boolean {
  const field = fieldDef(subject, node.field);
  if (!field) return false;
  const have = factFor(node.field, facts);
  if (have === null || have === undefined) return false;
  switch (field.type) {
    case "money": {
      const want = moneyToCents(node.value);
      if (want === null || typeof have !== "number") return false;
      return node.op === "gte" ? have >= want : have < want;
    }
    case "number":
      if (typeof have !== "number" || typeof node.value !== "number") return false;
      return node.op === "gte" ? have >= node.value : have < node.value;
    case "text":
      return String(have).toLowerCase().includes(String(node.value).trim().toLowerCase());
    case "choice":
      return have === node.value;
    case "yesno":
      return (have === true) === (node.value === "yes");
  }
}

function factFor(field: string, f: WorkflowFacts): unknown {
  return (
    {
      amount: f.amountCents,
      days_overdue: f.daysOverdue,
      days_until_due: f.daysUntilDue,
      client: f.client,
      reminders_sent: f.remindersSent,
      days_left: f.daysLeft,
      reason: f.reason,
      has_tracking: f.hasTracking,
      buyer: f.buyer,
    } as Record<string, unknown>
  )[field];
}

/** "500", "500.5" or 500 → cents. Code does the maths, in whole cents. */
export function moneyToCents(v: string | number): number | null {
  const s = typeof v === "number" ? v.toFixed(2) : v.trim();
  const m = /^(\d{1,9})(?:\.(\d{1,2}))?$/.exec(s);
  if (!m) return null;
  return Number(m[1]) * 100 + Number((m[2] ?? "0").padEnd(2, "0"));
}

/** PayPal's dispute reason code → the workflow's choice. */
export function disputeReason(code: string): NonNullable<WorkflowFacts["reason"]> {
  if (code === "MERCHANDISE_OR_SERVICE_NOT_RECEIVED") return "not_received";
  if (code === "MERCHANDISE_OR_SERVICE_NOT_AS_DESCRIBED") return "not_as_described";
  if (code === "UNAUTHORISED" || code === "UNAUTHORIZED") return "unauthorized";
  return "other";
}

/**
 * What the skill run gets from the Then blocks a subject reached: the merchant's
 * instruction (their workflow in words, plus their notes) and the commands it
 * may use. merchant.ask is always allowed, so Pyp can ask instead of guessing.
 */
export function planFor(workflowName: string, subject: WorkflowSubject, thens: Extract<WorkflowNode, { type: "then" }>[]): { skill: SkillId; instruction: string; commands: CommandId[] | null } | null {
  const runs = thens.map((t) => ({ t, a: actionDef(t.action) })).filter((x) => x.a?.run);
  if (!runs.length) return null;
  const skill = skillFor(runs[0].a!, subject)!;
  const same = runs.filter((x) => skillFor(x.a!, subject) === skill);
  const anyCommand = same.some((x) => x.a!.run!.commands === null);
  const commands = anyCommand ? null : [...new Set<CommandId>(["merchant.ask", ...same.flatMap((x) => x.a!.run!.commands ?? [])])];
  const lines = same.map((x) => `- ${sentence(x.a!, x.t)}${x.t.note?.trim() ? ` My note: ${x.t.note.trim()}` : ""}`);
  const instruction = `My workflow "${workflowName}" applies here. It says:\n${lines.join("\n")}`;
  return { skill, instruction, commands };
}

function sentence(a: ActionDef, t: Extract<WorkflowNode, { type: "then" }>): string {
  switch (a.id) {
    case "remind":
      return `Send a ${t.params?.tone === "firm" ? "firm" : "friendly"} reminder.`;
    case "follow_up":
      return `Check this invoice again in ${Number(t.params?.days ?? 7)} days.`;
    case "cancel":
      return "Cancel this invoice.";
    case "ask_me":
      return "Ask me what to do before anything else.";
    case "pyp_decides":
      return "Decide what's best.";
    case "offer_refund":
      return "Offer the buyer a full refund inside the dispute.";
    case "send_proof":
      return "Send the tracking as proof of delivery.";
    default:
      return a.label + ".";
  }
}

/** The workflow in one line, for the list and the card trace. */
export function describeWorkflow(graph: WorkflowGraph): string {
  const when = whenOf(graph);
  const trigger = when ? triggerDef(when.trigger) : undefined;
  if (!when || !trigger) return "Not set up yet";
  const day = trigger.id === "weekly" ? ` (${when.params?.weekday ?? "Mon"})` : trigger.id === "invoice_due_soon" ? ` (within ${when.params?.days ?? 3} days)` : "";
  const thens = graph.nodes.filter((n) => n.type === "then").map((n) => actionDef((n as { action: string }).action)?.label).filter(Boolean);
  const ifs = graph.nodes.filter((n) => n.type === "if").length;
  return `${trigger.label}${day}${ifs ? `, ${ifs} check${ifs > 1 ? "s" : ""}` : ""} → ${thens.length ? thens.join(" / ") : "nothing yet"}`;
}
