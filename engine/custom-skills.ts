// Custom skills: specialists the merchant makes. A workflow is the merchant's
// rules (a flowchart: they decide, Pyp follows the branches). A custom skill is
// Pyp's judgment, their way: it watches a list (overdue invoices, open
// disputes…), keeps the ones that pass the merchant's checks, and for each one
// Pyp decides what to do, guided by the merchant's playbook and tone and
// limited to the actions they allow.
//
// It can't do anything new: its actions are commands Pyp already has, and every
// proposal still goes through the checks, the dials, the undo window and the
// kill switch. "Ask me first" can only make a dial stricter, never looser.
//
// Code does the maths: the checks compare numbers code computed (money in
// cents), and the schedule is plain date arithmetic in the merchant's time zone.

import { z } from "zod";
import type { CommandId, SkillId } from "./types";
import { check, FIELDS, OPS, type WorkflowFacts, type WorkflowSubject } from "./workflows";

// ---------- The catalog ----------

export type WatchId = "invoice_overdue" | "invoice_due_soon" | "dispute_opened" | "dispute_deadline";

export interface WatchDef {
  id: WatchId;
  label: string;
  subject: Exclude<WorkflowSubject, "week">;
  skill: SkillId;
}

export const WATCHES: WatchDef[] = [
  { id: "invoice_overdue", label: "Overdue invoices", subject: "invoice", skill: "collections" },
  { id: "invoice_due_soon", label: "Invoices due soon", subject: "invoice", skill: "collections" },
  { id: "dispute_opened", label: "Disputes waiting on you", subject: "dispute", skill: "disputes" },
  { id: "dispute_deadline", label: "Disputes near their deadline", subject: "dispute", skill: "disputes" },
];

export type SkillActionId = "remind" | "follow_up" | "cancel" | "suggest_auto" | "offer" | "evidence" | "message" | "accept";

export interface SkillActionDef {
  id: SkillActionId;
  label: string;
  subject: "invoice" | "dispute";
  command: CommandId;
  /** Pyp's own rule already makes this one always ask you (never Auto). */
  alwaysAsks: boolean;
}

export const SKILL_ACTIONS: SkillActionDef[] = [
  { id: "remind", label: "Send a reminder", subject: "invoice", command: "invoice.sendReminder", alwaysAsks: false },
  { id: "follow_up", label: "Check again later", subject: "invoice", command: "invoice.scheduleFollowUp", alwaysAsks: false },
  { id: "cancel", label: "Cancel the invoice", subject: "invoice", command: "invoice.cancel", alwaysAsks: true },
  { id: "suggest_auto", label: "Suggest automatic reminders", subject: "invoice", command: "invoice.suggestAutoReminders", alwaysAsks: true },
  { id: "offer", label: "Offer a refund in the dispute", subject: "dispute", command: "dispute.makeOffer", alwaysAsks: true },
  { id: "evidence", label: "Send proof (tracking) to PayPal", subject: "dispute", command: "dispute.provideEvidence", alwaysAsks: true },
  { id: "message", label: "Message the buyer", subject: "dispute", command: "dispute.sendMessage", alwaysAsks: false },
  { id: "accept", label: "Accept the claim", subject: "dispute", command: "dispute.acceptClaim", alwaysAsks: true },
];

export const TONES = [
  { value: "warm", label: "Warm" },
  { value: "neutral", label: "Neutral" },
  { value: "firm", label: "Firm" },
  { value: "formal", label: "Formal" },
] as const;
export type Tone = (typeof TONES)[number]["value"];

export const WEEKDAYS = ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"] as const;

export const SCHEDULE_KINDS = [
  { value: "daily", label: "Every day" },
  { value: "weekly", label: "Every week" },
  { value: "monthly", label: "Every month" },
  { value: "every", label: "Every few days" },
  { value: "manual", label: "Only when I run it" },
] as const;

export const SKILL_CATALOG = {
  watches: WATCHES,
  actions: SKILL_ACTIONS,
  fields: FIELDS.filter((f) => f.subject !== "week"),
  ops: OPS,
  tones: TONES,
  weekdays: WEEKDAYS,
  scheduleKinds: SCHEDULE_KINDS,
};

export const watchDef = (id: string) => WATCHES.find((w) => w.id === id);
export const skillActionDef = (id: string) => SKILL_ACTIONS.find((a) => a.id === id);

// ---------- The spec ----------

const time = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/);

export const Schedule = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("daily"), time }),
  z.object({ kind: z.literal("weekly"), time, weekday: z.enum(WEEKDAYS) }),
  // 1–28, so every month has the day.
  z.object({ kind: z.literal("monthly"), time, day: z.number().int().min(1).max(28) }),
  z.object({ kind: z.literal("every"), time, days: z.number().int().min(2).max(30) }),
  z.object({ kind: z.literal("manual") }),
]);
export type Schedule = z.infer<typeof Schedule>;

export const SkillFilter = z.object({
  field: z.string().max(40),
  op: z.string().max(20),
  value: z.union([z.string().max(120), z.number().finite()]),
});
export type SkillFilter = z.infer<typeof SkillFilter>;

export const SkillSpec = z.object({
  watch: z.enum(["invoice_overdue", "invoice_due_soon", "dispute_opened", "dispute_deadline"]),
  /** Invoices due soon: within this many days. */
  dueWithinDays: z.number().int().min(1).max(30).optional(),
  filters: z.array(SkillFilter).max(5),
  schedule: Schedule,
  actions: z.array(z.object({ action: z.string().max(40), askFirst: z.boolean() })).max(8),
  playbook: z.string().max(600),
  tone: z.enum(["warm", "neutral", "firm", "formal"]),
});
export type SkillSpec = z.infer<typeof SkillSpec>;

/** What's wrong with a skill, in the merchant's words. Empty means it can be switched on. */
export function skillProblems(spec: SkillSpec): string[] {
  const problems: string[] = [];
  const watch = watchDef(spec.watch);
  if (!watch) return ["Pick what this skill watches"];
  for (const f of spec.filters) {
    const field = SKILL_CATALOG.fields.find((x) => x.subject === watch.subject && x.id === f.field);
    if (!field) {
      problems.push(`A check doesn't apply to ${watch.label.toLowerCase()}`);
      continue;
    }
    if (!OPS[field.type].some((o) => o.value === f.op)) problems.push(`Check "${field.label}": pick how to compare`);
    else if (!valueLooksOk(field.type, f.value, field.options)) {
      problems.push(`Check "${field.label}": enter a value`);
    }
  }
  if (!spec.actions.length) problems.push("Pick at least one thing this skill may do");
  const seen = new Set<string>();
  for (const a of spec.actions) {
    const def = skillActionDef(a.action);
    if (!def) problems.push("An action isn't one Pyp knows");
    else if (def.subject !== watch.subject) problems.push(`"${def.label}" doesn't go with ${watch.label.toLowerCase()}`);
    if (seen.has(a.action)) problems.push("An action is listed twice");
    seen.add(a.action);
  }
  return [...new Set(problems)];
}

// A value check without running the comparison: the same rules as workflows.
function valueLooksOk(type: string, v: unknown, options?: { value: string }[]): boolean {
  switch (type) {
    case "money":
      return typeof v === "string" ? /^\d{1,9}(\.\d{1,2})?$/.test(v) : typeof v === "number" && v >= 0 && v < 1e9;
    case "number":
      return typeof v === "number" && Number.isInteger(v) && v >= -3650 && v <= 3650;
    case "text":
      return typeof v === "string" && v.trim().length > 0;
    case "choice":
      return typeof v === "string" && (options ?? []).some((o) => o.value === v);
    case "yesno":
      return v === "yes" || v === "no";
    default:
      return false;
  }
}

/** Does this invoice or dispute pass every check? A fact code doesn't have counts as "no". */
export function passesFilters(spec: SkillSpec, facts: WorkflowFacts): boolean {
  const watch = watchDef(spec.watch);
  if (!watch) return false;
  return spec.filters.every((f) => check(watch.subject, { id: "f", type: "if", ...f }, facts));
}

/**
 * What one run gets: the skill to run, the merchant's playbook as their
 * instruction, the commands it may use (merchant.ask always), and the ones
 * that must ask first.
 */
export function skillPlan(name: string, spec: SkillSpec): { skill: SkillId; instruction: string; commands: CommandId[]; askFirst: CommandId[] } | null {
  const watch = watchDef(spec.watch);
  if (!watch || skillProblems(spec).length) return null;
  const actions = spec.actions.map((a) => ({ a, def: skillActionDef(a.action)! }));
  const commands: CommandId[] = ["merchant.ask", ...actions.map((x) => x.def.command)];
  const askFirst = actions.filter((x) => x.a.askFirst).map((x) => x.def.command);
  const may = actions.map((x) => `${x.def.label.toLowerCase()}${x.a.askFirst && !x.def.alwaysAsks ? " (ask me first)" : ""}`).join("; ");
  const playbook = spec.playbook.trim();
  const instruction = [
    `My custom skill "${name}" is handling this. Use your judgment, my way.`,
    `Tone: ${spec.tone}.`,
    `You may: ${may}; or ask me.`,
    playbook ? `My playbook: ${playbook}` : "",
  ]
    .filter(Boolean)
    .join("\n");
  return { skill: watch.skill, instruction, commands: [...new Set(commands)], askFirst };
}

// ---------- The schedule (merchant-local) ----------

const DAY_MS = 86_400_000;

/** The YYYY-MM-DD date of an instant in a time zone. */
function localParts(at: Date, timeZone: string): { date: string } {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" })
      .formatToParts(at)
      .map((x) => [x.type, x.value]),
  );
  return { date: `${p.year}-${p.month}-${p.day}` };
}

/** The zone's offset from UTC at an instant, in ms. */
function offsetAt(at: number, timeZone: string): number {
  const p = Object.fromEntries(
    new Intl.DateTimeFormat("en-US", { timeZone, hourCycle: "h23", year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", minute: "2-digit", second: "2-digit" })
      .formatToParts(new Date(at))
      .map((x) => [x.type, x.value]),
  );
  const asUtc = Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day), Number(p.hour), Number(p.minute), Number(p.second));
  return asUtc - Math.floor(at / 1000) * 1000;
}

/**
 * The instant a local date and time happens in a zone. A time skipped by a DST
 * change (02:30 on spring-forward night) runs at the later of the two readings,
 * just after the clocks jump, in every zone.
 */
export function zonedTime(date: string, hhmm: string, timeZone: string): Date {
  const [y, m, d] = date.split("-").map(Number);
  const [hh, mm] = hhmm.split(":").map(Number);
  const wall = Date.UTC(y, m - 1, d, hh, mm);
  const a1 = wall - offsetAt(wall, timeZone);
  const a2 = wall - offsetAt(a1, timeZone); // once more, in case the guess crossed a DST change
  // Keep a candidate that really reads as this local time (the earlier one when the
  // clocks go back and it happens twice); none does in the spring-forward gap: the later.
  const reads = (at: number) => at + offsetAt(at, timeZone) === wall;
  const real = [a1, a2].filter(reads);
  return new Date(real.length ? Math.min(...real) : Math.max(a1, a2));
}

function addDays(date: string, n: number): string {
  const [y, m, d] = date.split("-").map(Number);
  return new Date(Date.UTC(y, m - 1, d) + n * DAY_MS).toISOString().slice(0, 10);
}

function weekdayOf(date: string): string {
  const [y, m, d] = date.split("-").map(Number);
  return ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"][new Date(Date.UTC(y, m - 1, d)).getUTCDay()];
}

/**
 * The next time a schedule runs strictly after `after`. Null for "only when I
 * run it". "Every N days" counts from `anchor` (the last run, else when it was
 * switched on), so it keeps its rhythm.
 */
export function nextRun(schedule: Schedule, after: Date, timeZone: string, anchor?: Date): Date | null {
  if (schedule.kind === "manual") return null;
  const today = localParts(after, timeZone).date;
  if (schedule.kind === "every") {
    const start = localParts(anchor ?? after, timeZone).date;
    for (let k = 0; k < 400; k++) {
      const date = addDays(start, k * schedule.days);
      if (date < today) continue;
      const at = zonedTime(date, schedule.time, timeZone);
      if (at > after) return at;
    }
    return null;
  }
  for (let i = 0; i < 400; i++) {
    const date = addDays(today, i);
    const ok =
      schedule.kind === "daily" ||
      (schedule.kind === "weekly" && weekdayOf(date) === schedule.weekday) ||
      (schedule.kind === "monthly" && Number(date.slice(8, 10)) === schedule.day);
    if (!ok) continue;
    const at = zonedTime(date, schedule.time, timeZone);
    if (at > after) return at;
  }
  return null;
}

const ORDINAL = (n: number) => `${n}${n % 10 === 1 && n !== 11 ? "st" : n % 10 === 2 && n !== 12 ? "nd" : n % 10 === 3 && n !== 13 ? "rd" : "th"}`;

/** The schedule in words: "Every Friday at 09:00". */
export function describeSchedule(s: Schedule): string {
  switch (s.kind) {
    case "manual":
      return "Only when you run it";
    case "daily":
      return `Every day at ${s.time}`;
    case "weekly":
      return `Every ${({ Mon: "Monday", Tue: "Tuesday", Wed: "Wednesday", Thu: "Thursday", Fri: "Friday", Sat: "Saturday", Sun: "Sunday" } as const)[s.weekday]} at ${s.time}`;
    case "monthly":
      return `On the ${ORDINAL(s.day)} of every month at ${s.time}`;
    case "every":
      return `Every ${s.days} days at ${s.time}`;
  }
}

/** The skill in one line, for its card on the My skills page. */
export function describeSkill(spec: SkillSpec): string {
  const watch = watchDef(spec.watch);
  const what = watch ? watch.label : "Nothing yet";
  const due = spec.watch === "invoice_due_soon" ? ` (within ${spec.dueWithinDays ?? 3} days)` : "";
  const checks = spec.filters.length ? `, ${spec.filters.length} check${spec.filters.length > 1 ? "s" : ""}` : "";
  const may = spec.actions.map((a) => skillActionDef(a.action)?.label).filter(Boolean).join(" · ");
  return `${what}${due}${checks} → ${may || "nothing allowed yet"}`;
}
