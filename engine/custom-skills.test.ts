import { describe, expect, it } from "vitest";
import { describeSchedule, describeSkill, nextRun, passesFilters, skillPlan, skillProblems, zonedTime, type SkillSpec } from "./custom-skills";
import { normalise } from "./skill-draft";

const LA = "America/Los_Angeles";

const friday: SkillSpec = {
  watch: "invoice_overdue",
  filters: [
    { field: "days_overdue", op: "gte", value: 30 },
    { field: "amount", op: "gte", value: "200" },
  ],
  schedule: { kind: "weekly", weekday: "Fri", time: "09:00" },
  actions: [
    { action: "remind", askFirst: false },
    { action: "cancel", askFirst: true },
  ],
  playbook: "Send one last firm reminder, then suggest cancelling anything over 90 days.",
  tone: "firm",
};

describe("zonedTime", () => {
  it("turns a local time into the right instant, either side of DST", () => {
    expect(zonedTime("2026-07-01", "09:00", LA).toISOString()).toBe("2026-07-01T16:00:00.000Z"); // PDT, UTC-7
    expect(zonedTime("2026-12-01", "09:00", LA).toISOString()).toBe("2026-12-01T17:00:00.000Z"); // PST, UTC-8
    expect(zonedTime("2026-11-01", "09:00", LA).toISOString()).toBe("2026-11-01T17:00:00.000Z"); // the day clocks go back
    expect(zonedTime("2026-03-08", "09:00", LA).toISOString()).toBe("2026-03-08T16:00:00.000Z"); // the day clocks go forward
    expect(zonedTime("2026-07-01", "09:00", "Asia/Kolkata").toISOString()).toBe("2026-07-01T03:30:00.000Z");
  });
});

describe("nextRun", () => {
  // Wednesday Oct 28 2026, 08:00 in Los Angeles.
  const wed8am = new Date("2026-10-28T15:00:00Z");

  it("daily: later today, else tomorrow", () => {
    expect(nextRun({ kind: "daily", time: "09:00" }, wed8am, LA)?.toISOString()).toBe("2026-10-28T16:00:00.000Z");
    expect(nextRun({ kind: "daily", time: "07:00" }, wed8am, LA)?.toISOString()).toBe("2026-10-29T14:00:00.000Z");
  });

  it("weekly: the next matching weekday, across the DST change", () => {
    expect(nextRun({ kind: "weekly", weekday: "Fri", time: "09:00" }, wed8am, LA)?.toISOString()).toBe("2026-10-30T16:00:00.000Z");
    // Next Wednesday is after clocks go back (Nov 1): 09:00 PST is 17:00 UTC.
    expect(nextRun({ kind: "weekly", weekday: "Wed", time: "07:00" }, wed8am, LA)?.toISOString()).toBe("2026-11-04T15:00:00.000Z");
  });

  it("monthly: the day this month if still ahead, else next month", () => {
    expect(nextRun({ kind: "monthly", day: 28, time: "09:00" }, wed8am, LA)?.toISOString()).toBe("2026-10-28T16:00:00.000Z");
    expect(nextRun({ kind: "monthly", day: 1, time: "09:00" }, wed8am, LA)?.toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });

  it("every N days keeps its rhythm from the anchor", () => {
    const anchor = new Date("2026-10-26T16:30:00Z"); // Mon Oct 26
    expect(nextRun({ kind: "every", days: 3, time: "09:00" }, wed8am, LA, anchor)?.toISOString()).toBe("2026-10-29T16:00:00.000Z");
    // Right after a run at 09:00 Thursday, the next is Sunday.
    const thuRun = new Date("2026-10-29T16:00:00Z");
    expect(nextRun({ kind: "every", days: 3, time: "09:00" }, thuRun, LA, thuRun)?.toISOString()).toBe("2026-11-01T17:00:00.000Z");
  });

  it("is strictly after now, and null for manual", () => {
    const at9 = new Date("2026-10-28T16:00:00Z");
    expect(nextRun({ kind: "daily", time: "09:00" }, at9, LA)?.toISOString()).toBe("2026-10-29T16:00:00.000Z");
    expect(nextRun({ kind: "manual" }, wed8am, LA)).toBeNull();
  });
});

describe("skillProblems", () => {
  it("accepts a complete skill", () => {
    expect(skillProblems(friday)).toEqual([]);
  });

  it("says what's missing or doesn't fit, in the merchant's words", () => {
    const bad: SkillSpec = {
      ...friday,
      filters: [{ field: "has_tracking", op: "is", value: "yes" }, { field: "amount", op: "gte", value: "lots" }],
      actions: [{ action: "offer", askFirst: false }],
    };
    expect(skillProblems(bad)).toEqual([
      "A check doesn't apply to overdue invoices",
      'Check "Amount": enter a value',
      '"Offer a refund in the dispute" doesn\'t go with overdue invoices',
    ]);
    expect(skillProblems({ ...friday, actions: [] })).toContain("Pick at least one thing this skill may do");
  });
});

describe("passesFilters", () => {
  it("needs every check to pass, on code's own numbers", () => {
    expect(passesFilters(friday, { daysOverdue: 45, amountCents: 50_000 })).toBe(true);
    expect(passesFilters(friday, { daysOverdue: 45, amountCents: 19_999 })).toBe(false);
    expect(passesFilters(friday, { daysOverdue: 10, amountCents: 50_000 })).toBe(false);
    expect(passesFilters(friday, { amountCents: 50_000 })).toBe(false); // a fact code doesn't have is "no"
  });
});

describe("skillPlan", () => {
  it("limits the run to the allowed actions plus asking, with ask-first and the playbook", () => {
    const plan = skillPlan("Friday cleanup", friday)!;
    expect(plan.skill).toBe("collections");
    expect(plan.commands).toEqual(["merchant.ask", "invoice.sendReminder", "invoice.cancel"]);
    expect(plan.askFirst).toEqual(["invoice.cancel"]);
    expect(plan.instruction).toContain('My custom skill "Friday cleanup"');
    expect(plan.instruction).toContain("Tone: firm.");
    expect(plan.instruction).toContain("My playbook: Send one last firm reminder");
    expect(plan.instruction.length).toBeLessThanOrEqual(1000);
  });

  it("refuses a skill with problems", () => {
    expect(skillPlan("x", { ...friday, actions: [] })).toBeNull();
  });
});

describe("describing", () => {
  it("says the schedule and the skill in one line", () => {
    expect(describeSchedule(friday.schedule)).toBe("Every Friday at 09:00");
    expect(describeSchedule({ kind: "monthly", day: 1, time: "08:30" })).toBe("On the 1st of every month at 08:30");
    expect(describeSkill(friday)).toBe("Overdue invoices, 2 checks → Send a reminder · Cancel the invoice");
  });
});

describe("normalise (code's pass over Pyp's draft)", () => {
  it("keeps what fits, cleans values, and says what it dropped", () => {
    const out = normalise({
      name: "Friday cleanup",
      watch: "invoice_overdue",
      dueWithinDays: null,
      filters: [
        { field: "days_overdue", op: "gte", value: "30" },
        { field: "amount", op: "gte", value: "$1,500" },
        { field: "has_tracking", op: "is", value: "yes" },
      ],
      schedule: { kind: "weekly", time: "9am", weekday: "Fri", day: null, days: null },
      actions: [
        { action: "remind", askFirst: false },
        { action: "offer", askFirst: false },
        { action: "remind", askFirst: true },
      ],
      playbook: "Be firm. See https://example.com for my policy.",
      tone: "firm",
      unclear: "Pyp can't text clients yet.",
    });
    expect(out.spec.filters).toEqual([
      { field: "days_overdue", op: "gte", value: 30 },
      { field: "amount", op: "gte", value: "1500" },
    ]);
    expect(out.spec.schedule).toEqual({ kind: "weekly", time: "09:00", weekday: "Fri" });
    expect(out.spec.actions).toEqual([{ action: "remind", askFirst: false }]);
    expect(out.spec.playbook).toBe("Be firm. See  for my policy.");
    expect(out.problems).toEqual([]);
    expect(out.notes).toEqual([
      "Pyp can't text clients yet.",
      'Left out a check on "has tracking": it doesn\'t apply to overdue invoices.',
      'Left out "Offer a refund in the dispute": it doesn\'t go with overdue invoices.',
    ]);
  });

  it("clamps schedule numbers into range", () => {
    const base = { name: "x", watch: "invoice_due_soon", dueWithinDays: 90, filters: [], actions: [{ action: "remind", askFirst: false }], playbook: "", tone: "warm" as const, unclear: null };
    expect(normalise({ ...base, schedule: { kind: "monthly", time: "10:00", weekday: null, day: 31, days: null } }).spec.schedule).toEqual({ kind: "monthly", time: "10:00", day: 28 });
    expect(normalise({ ...base, schedule: { kind: "every", time: null, weekday: null, day: null, days: 1 } }).spec).toMatchObject({ schedule: { kind: "every", time: "09:00", days: 2 }, dueWithinDays: 30 });
  });
});
