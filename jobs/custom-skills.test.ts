// Custom skills on a real Postgres (skipped without TEST_DATABASE_URL). PayPal
// reads are faked and the model is scripted.

import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { SkillSpec } from "@/engine/custom-skills";
import type { Invoice } from "@/engine/types";
import { ScriptedAgentClient } from "@/gateway/scripted";
import { acmeInvoice, friendlyReminder, NOW } from "@/skills/collections/evals/fixtures";
import { getSkillById, listSkills, runDueSkills, runSkillNow, saveSkill } from "./custom-skills";
import type { SweepReads } from "./sweep-run";
import { DEMO_MERCHANT, TEST_DB_URL, freshDatabase } from "./test-db";

// NOW is Wednesday 2026-10-28 08:00 in Los Angeles. acmeInvoice ($1,200) was due Oct 21.
const LA = "America/Los_Angeles";
const small: Invoice = { ...acmeInvoice, id: "INV2-ACME-0050", number: "0050", total: "100.00", amountDue: "100.00" };

const bigOnes: SkillSpec = {
  watch: "invoice_overdue",
  filters: [{ field: "amount", op: "gte", value: "500" }],
  schedule: { kind: "daily", time: "09:00" },
  actions: [{ action: "remind", askFirst: true }],
  playbook: "These are my biggest clients. Be firm but respectful.",
  tone: "firm",
};

function reads(overdue: Invoice[]): SweepReads {
  return {
    getInvoice: async (id) => overdue.find((i) => i.id === id) ?? null,
    recentClients: async () => [],
    overdueInvoices: async () => overdue,
    disputesDueBefore: async () => [],
    unpaidInvoices: async () => overdue,
  };
}

const firm = () => friendlyReminder({ tone: "firm", note: "Hi Sam, invoice 0042 for $1,200.00 was due Oct 21. Please pay this week. Maya Ortiz Design" });

describe.skipIf(!TEST_DB_URL)("custom skills (Postgres)", () => {
  let pool: Pool;
  let drop: (() => Promise<void>) | undefined;

  beforeAll(async () => {
    ({ pool, drop } = await freshDatabase());
  });
  afterAll(async () => drop?.());
  beforeEach(async () => {
    await pool.query("delete from custom_skills");
    await pool.query("update proposals set status = 'obsolete' where status in ('awaiting_approval', 'scheduled', 'executing', 'executed')");
    await pool.query("update merchants set kill_switch = false where id = $1", [DEMO_MERCHANT]);
  });

  it("an unfinished skill is a switched-off draft; switching one on sets its next run", async () => {
    const draft = await saveSkill(pool, DEMO_MERCHANT, { name: "Draft", enabled: true, spec: { ...bigOnes, actions: [] } }, { now: NOW, timeZone: LA });
    expect(draft).toMatchObject({ skill: { enabled: false, nextRunAt: null }, problems: ["Pick at least one thing this skill may do"] });
    const on = await saveSkill(pool, DEMO_MERCHANT, { name: "Big ones", enabled: true, spec: bigOnes }, { id: draft!.skill.id, now: NOW, timeZone: LA });
    expect(on).toMatchObject({ skill: { enabled: true, nextRunAt: "2026-10-28T16:00:00.000Z" }, problems: [] }); // today 09:00 LA
    expect(await listSkills(pool, DEMO_MERCHANT)).toHaveLength(1);
  });

  it("Run now: code's checks pick the invoices, Pyp is limited to the allowed actions, and ask-first makes a card", async () => {
    const { skill } = (await saveSkill(pool, DEMO_MERCHANT, { name: "Big ones", enabled: true, spec: bigOnes }, { now: NOW, timeZone: LA }))!;
    const agent = new ScriptedAgentClient([firm()]);
    const out = await runSkillNow({ pool, read: reads([acmeInvoice, small]), agent, now: () => NOW }, DEMO_MERCHANT, skill.id);
    expect(out).toMatchObject({ status: "ok", found: 2, matched: 1, ran: 1, failed: [] });

    // Only the $1,200 invoice passed "amount ≥ $500"; $100 was never sent to the model.
    expect(agent.requests).toHaveLength(1);
    const turn = agent.requests[0].turn;
    expect(turn).toContain("INV2-ACME-0042");
    expect(turn).toContain("My custom skill &quot;Big ones&quot;");
    expect(turn).toContain("My playbook: These are my biggest clients.");
    expect(turn).toContain('<command id="invoice.sendReminder"');
    expect(turn).not.toContain('<command id="invoice.cancel"');

    const p = await pool.query("select p.status, p.policy_rule, r.trigger from proposals p join runs r on r.id = p.run_id where r.trigger = 'skill:Big ones'");
    expect(p.rows).toEqual([{ status: "awaiting_approval", policy_rule: "skill_ask_first", trigger: "skill:Big ones" }]);
    expect((await getSkillById(pool, DEMO_MERCHANT, skill.id))?.lastOutcome).toMatchObject({ status: "ok", matched: 1, ran: 1 });
  });

  it("Try it: says what Pyp would do, and saves nothing", async () => {
    const { skill } = (await saveSkill(pool, DEMO_MERCHANT, { name: "Big ones", enabled: true, spec: bigOnes }, { now: NOW, timeZone: LA }))!;
    const before = (await pool.query("select count(*)::int as n from runs")).rows[0].n;
    const agent = new ScriptedAgentClient([firm()]);
    const out = await runSkillNow({ pool, read: reads([acmeInvoice]), agent, now: () => NOW }, DEMO_MERCHANT, skill.id, { dryRun: true });
    expect(out).toMatchObject({ status: "ok", ran: 1, cardIds: [] });
    expect((out as { previews: unknown[] }).previews).toEqual([
      {
        subject: { kind: "invoice", id: "INV2-ACME-0042" },
        title: "Acme is 7 days late",
        summary: "First reminder for invoice 0042. A friendly nudge fits.",
        actions: [{ label: "Send a reminder", outcome: "would ask you", reason: "Your skill “Big ones” asks you first" }],
      },
    ]);
    expect((await pool.query("select count(*)::int as n from runs")).rows[0].n).toBe(before);
    expect((await getSkillById(pool, DEMO_MERCHANT, skill.id))?.lastRunAt).toBeNull();
  });

  it("the worker runs a skill when its time comes, once, and moves it to the next time", async () => {
    await saveSkill(pool, DEMO_MERCHANT, { name: "Big ones", enabled: true, spec: bigOnes }, { now: NOW, timeZone: LA });
    const agent = new ScriptedAgentClient([firm()]);
    const deps = (at: Date) => ({ pool, read: reads([acmeInvoice]), agent, now: () => at });
    expect(await runDueSkills(deps(NOW))).toEqual([]); // 08:00: not yet

    const nineOhOne = new Date("2026-10-28T16:01:00Z");
    const done = await runDueSkills(deps(nineOhOne));
    expect(done).toHaveLength(1);
    expect(done[0].outcome).toMatchObject({ status: "ok", ran: 1 });
    expect(await runDueSkills(deps(nineOhOne))).toEqual([]); // claimed: not again
    const s = (await listSkills(pool, DEMO_MERCHANT))[0];
    expect(s.nextRunAt).toBe("2026-10-29T16:00:00.000Z");
    expect(s.lastRunAt).toBe(nineOhOne.toISOString());
  });

  it("the kill switch: no model call, and the skill moves on without a backlog", async () => {
    await saveSkill(pool, DEMO_MERCHANT, { name: "Big ones", enabled: true, spec: bigOnes }, { now: NOW, timeZone: LA });
    await pool.query("update merchants set kill_switch = true where id = $1", [DEMO_MERCHANT]);
    const agent = new ScriptedAgentClient([]);
    const done = await runDueSkills({ pool, read: reads([acmeInvoice]), agent, now: () => new Date("2026-10-28T16:01:00Z") });
    expect(done[0].outcome).toMatchObject({ status: "paused" });
    expect(agent.requests).toHaveLength(0);
    expect((await listSkills(pool, DEMO_MERCHANT))[0].nextRunAt).toBe("2026-10-29T16:00:00.000Z");
  });

  it("allowing Cancel is standing permission, not a request: cancel stays off the menu until the reminders are used up", async () => {
    const spec: SkillSpec = { ...bigOnes, filters: [], actions: [{ action: "remind", askFirst: false }, { action: "cancel", askFirst: true }], playbook: "Never cancel or void anything small." };
    const { skill } = (await saveSkill(pool, DEMO_MERCHANT, { name: "Cleanup", enabled: true, spec }, { now: NOW, timeZone: LA }))!;
    const agent = new ScriptedAgentClient([firm()]);
    await runSkillNow({ pool, read: reads([acmeInvoice]), agent, now: () => NOW }, DEMO_MERCHANT, skill.id);
    const turn = agent.requests[0].turn;
    expect(turn).toContain('<command id="invoice.sendReminder"');
    expect(turn).not.toContain('<command id="invoice.cancel"'); // 0 reminders sent, and the merchant didn't ask about this invoice
  });

  it("a scheduled run that fails before any invoice is tried again in 15 minutes, and says why on the page", async () => {
    await saveSkill(pool, DEMO_MERCHANT, { name: "Big ones", enabled: true, spec: bigOnes }, { now: NOW, timeZone: LA });
    const broken: SweepReads = { ...reads([]), overdueInvoices: async () => { throw new Error("PayPal 503"); } };
    const at = new Date("2026-10-28T16:01:00Z");
    const done = await runDueSkills({ pool, read: broken, agent: new ScriptedAgentClient([]), now: () => at });
    expect(done[0].outcome).toMatchObject({ status: "error", message: "PayPal 503" });
    const s = (await listSkills(pool, DEMO_MERCHANT))[0];
    expect(s.nextRunAt).toBe("2026-10-28T16:16:00.000Z");
    expect(s.lastOutcome).toMatchObject({ status: "error", message: "PayPal 503" });
  });

  it("a failing skill backs off (15, 30… minutes), and never overwrites a schedule the merchant just changed", async () => {
    const { skill } = (await saveSkill(pool, DEMO_MERCHANT, { name: "Big ones", enabled: true, spec: bigOnes }, { now: NOW, timeZone: LA }))!;
    const at1 = new Date("2026-10-28T16:01:00Z");
    const broken = (onRead?: () => Promise<void>): SweepReads => ({ ...reads([]), overdueInvoices: async () => { await onRead?.(); throw new Error("PayPal 503"); } });
    await runDueSkills({ pool, read: broken(), agent: new ScriptedAgentClient([]), now: () => at1 });
    const at2 = new Date("2026-10-28T16:16:00Z");
    await runDueSkills({ pool, read: broken(), agent: new ScriptedAgentClient([]), now: () => at2 });
    let s = (await listSkills(pool, DEMO_MERCHANT))[0];
    expect(s.lastOutcome).toMatchObject({ status: "error", failures: 2 });
    expect(s.nextRunAt).toBe("2026-10-28T16:46:00.000Z"); // 30 minutes after the second failure

    // The merchant moves it to manual while a run is in flight; the failed run's retry must not undo that.
    const at3 = new Date("2026-10-28T16:46:00Z");
    const edit = () => saveSkill(pool, DEMO_MERCHANT, { name: "Big ones", enabled: true, spec: { ...bigOnes, schedule: { kind: "manual" } } }, { id: skill.id, now: at3, timeZone: LA }).then(() => {});
    await runDueSkills({ pool, read: broken(edit), agent: new ScriptedAgentClient([]), now: () => at3 });
    s = (await listSkills(pool, DEMO_MERCHANT))[0];
    expect(s.nextRunAt).toBeNull();
  });

  it("claims a due skill whatever the timestamp's precision (set by SQL now())", async () => {
    await saveSkill(pool, DEMO_MERCHANT, { name: "Big ones", enabled: true, spec: bigOnes }, { now: NOW, timeZone: LA });
    await pool.query("update custom_skills set next_run_at = now() - interval '1 minute'");
    const done = await runDueSkills({ pool, read: reads([acmeInvoice]), agent: new ScriptedAgentClient([firm()]), now: () => new Date() });
    expect(done).toHaveLength(1);
    expect(await runDueSkills({ pool, read: reads([acmeInvoice]), agent: new ScriptedAgentClient([]), now: () => new Date() })).toEqual([]);
  });

  it("editing a skill without touching its schedule keeps its next run (every N days keeps its rhythm)", async () => {
    const spec: SkillSpec = { ...bigOnes, schedule: { kind: "every", days: 5, time: "09:00" } };
    const first = (await saveSkill(pool, DEMO_MERCHANT, { name: "Every 5", enabled: true, spec }, { now: NOW, timeZone: LA }))!;
    const later = new Date(NOW.getTime() + 2 * 86_400_000);
    const renamed = (await saveSkill(pool, DEMO_MERCHANT, { name: "Every five", enabled: true, spec: { ...spec, playbook: "New words." } }, { id: first.skill.id, now: later, timeZone: LA }))!;
    expect(renamed.skill.nextRunAt).toBe(first.skill.nextRunAt);
    const moved = (await saveSkill(pool, DEMO_MERCHANT, { name: "Every five", enabled: true, spec: { ...spec, schedule: { kind: "daily", time: "09:00" } } }, { id: first.skill.id, now: later, timeZone: LA }))!;
    expect(moved.skill.nextRunAt).toBe("2026-10-30T16:00:00.000Z"); // the new schedule, from now
  });

  it("a manual skill never runs by itself", async () => {
    await saveSkill(pool, DEMO_MERCHANT, { name: "By hand", enabled: true, spec: { ...bigOnes, schedule: { kind: "manual" } } }, { now: NOW, timeZone: LA });
    expect((await listSkills(pool, DEMO_MERCHANT))[0].nextRunAt).toBeNull();
    expect(await runDueSkills({ pool, read: reads([acmeInvoice]), agent: new ScriptedAgentClient([]), now: () => new Date("2027-01-01T00:00:00Z") })).toEqual([]);
  });
});
