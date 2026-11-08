// Sweeps on a real Postgres (skipped without TEST_DATABASE_URL; CI runs them).
// PayPal reads are faked and the model is scripted.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Dispute, Invoice } from "@/engine/types";
import { ScriptedAgentClient } from "@/gateway/scripted";
import { acmeInvoice, friendlyReminder, NOW } from "@/skills/collections/evals/fixtures";
import { calmFacts, evidenceAnswer, notReceived } from "@/skills/disputes/evals/fixtures";
import { approveAndExecute, type ExecutorDeps } from "@/executor/execute";
import { updateControls } from "./controls";
import { runDailySweeps, runSweep, type SweepReads } from "./sweep-run";
import { DEMO_MERCHANT, TEST_DB_URL, freshDatabase } from "./test-db";

// NOW is 2026-10-28 08:00 in Los Angeles, the demo merchant's time zone.
const second: Invoice = { ...acmeInvoice, id: "INV2-ACME-0043", number: "0043" };
/** A reminder that names 0043 (the check rejects one that names another invoice). */
function reminder0043() {
  const a = friendlyReminder({ invoiceId: second.id, note: "Hi Sam, a friendly nudge on invoice 0043 for $1,200.00. Thanks so much. Maya Ortiz Design" });
  a.actions[0].params.subject = "Quick reminder: invoice 0043";
  return a;
}

function reads(over: { overdue?: Invoice[]; disputes?: Dispute[] } = {}) {
  const asked: { today?: string; before?: Date } = {};
  const invoices = over.overdue ?? [acmeInvoice];
  const disputes = over.disputes ?? [];
  const read: SweepReads = {
    getInvoice: async (id) => invoices.find((i) => i.id === id) ?? null,
    recentClients: async () => [],
    getDispute: async (id) => disputes.find((d) => d.id === id) ?? null,
    overdueInvoices: async (today) => {
      asked.today = today;
      return invoices;
    },
    disputesDueBefore: async (before) => {
      asked.before = before;
      return disputes.filter((d) => Date.parse(d.sellerResponseDueDate!) < before.getTime());
    },
    transactions: async () => [
      { id: "T1", at: "2026-10-29T18:00:00Z", kind: "payment", status: "S", currency: "USD", amount: "1200.00", fee: "-35.10", counterparty: "Acme Studio" },
    ],
    unpaidInvoices: async () => invoices,
  };
  return { read, asked };
}

describe.skipIf(!TEST_DB_URL)("sweeps (Postgres)", () => {
  let pool: Pool;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ pool, drop } = await freshDatabase());
  });
  afterAll(async () => drop?.());
  beforeEach(async () => {
    // Nothing pending, nothing swept today, kill switch off.
    await pool.query("update proposals set status = 'obsolete' where status in ('awaiting_approval', 'scheduled', 'executing', 'executed')");
    await pool.query("delete from sweep_runs");
    await pool.query("update merchants set kill_switch = false where id = $1", [DEMO_MERCHANT]);
  });

  const sweep = (r: ReturnType<typeof reads>, agent: ScriptedAgentClient, name: "overdue-invoices" | "dispute-deadlines" = "overdue-invoices", at = NOW) =>
    runSweep({ pool, read: r.read, agent, now: () => at }, DEMO_MERCHANT, name);

  it("overdue: one Collections run per overdue invoice, asked with the merchant-local date", async () => {
    const r = reads({ overdue: [acmeInvoice, second] });
    const out = await sweep(r, new ScriptedAgentClient([friendlyReminder(), reminder0043()]));
    expect(out).toMatchObject({ status: "ok", found: 2, skipped: 0, ran: 2, failed: [] });
    expect(out.status === "ok" && out.cardIds).toHaveLength(2);
    expect(r.asked.today).toBe("2026-10-28");
    const runs = await pool.query("select subject_ref, trigger from runs where trigger = 'sweep:overdue-invoices' order by subject_ref");
    expect(runs.rows).toEqual([
      { subject_ref: "invoice:INV2-ACME-0042", trigger: "sweep:overdue-invoices" },
      { subject_ref: "invoice:INV2-ACME-0043", trigger: "sweep:overdue-invoices" },
    ]);
  });

  it("an invoice with a card already waiting is skipped, with no model call", async () => {
    await sweep(reads(), new ScriptedAgentClient([friendlyReminder()]));
    const agent = new ScriptedAgentClient([]);
    const out = await sweep(reads(), agent);
    expect(out).toMatchObject({ status: "ok", found: 1, skipped: 1, ran: 0 });
  });

  it("the kill switch: no reads, no model calls", async () => {
    await pool.query("update merchants set kill_switch = true where id = $1", [DEMO_MERCHANT]);
    const r = reads();
    expect(await sweep(r, new ScriptedAgentClient([]))).toEqual({ status: "paused" });
    expect(r.asked.today).toBeUndefined();
  });

  it("deadlines: a dispute due within 72 h gets a Disputes run; one due later doesn't", async () => {
    const soon = { ...notReceived, sellerResponseDueDate: "2026-10-30T15:00:00Z" }; // 48 h after NOW
    const later = { ...notReceived, id: "PP-D-999", sellerResponseDueDate: "2026-11-06T15:00:00Z" };
    const r = reads({ overdue: [], disputes: [soon, later] });
    const out = await sweep(r, new ScriptedAgentClient([calmFacts, evidenceAnswer()]), "dispute-deadlines");
    expect(out).toMatchObject({ status: "ok", found: 1, ran: 1 });
    expect(r.asked.before?.toISOString()).toBe("2026-10-31T15:00:00.000Z");
    const runs = await pool.query("select subject_ref from runs where trigger = 'sweep:dispute-deadlines'");
    expect(runs.rows).toEqual([{ subject_ref: "dispute:PP-D-123" }]);
  });

  it("one subject failing is reported and the rest still run", async () => {
    const r = reads({ overdue: [acmeInvoice, second] });
    r.read.getInvoice = async (id) => {
      if (id === acmeInvoice.id) throw new Error("PayPal timed out");
      return second;
    };
    const out = await sweep(r, new ScriptedAgentClient([reminder0043()]));
    expect(out).toMatchObject({ status: "ok", ran: 1, failed: ["INV2-ACME-0042: Couldn't build the case file: PayPal timed out"] });
  });

  it("daily: nothing before 08:00 local, then each sweep once that day", async () => {
    const r = reads({ overdue: [acmeInvoice], disputes: [] });
    const at = (iso: string) => ({ pool, read: r.read, agent: new ScriptedAgentClient([friendlyReminder()]), now: () => new Date(iso) });

    expect(await runDailySweeps(at("2026-10-28T14:59:00Z"))).toEqual([]); // 07:59 in Los Angeles
    const first = await runDailySweeps(at("2026-10-28T15:01:00Z"));
    expect(first.map((s) => [s.name, s.outcome.status])).toEqual([
      ["overdue-invoices", "ok"],
      ["dispute-deadlines", "ok"],
    ]);
    expect(await runDailySweeps(at("2026-10-28T20:00:00Z"))).toEqual([]); // same local day
    const row = await pool.query("select outcome from sweep_runs where name = 'overdue-invoices'");
    expect(JSON.parse(row.rows[0].outcome)).toMatchObject({ status: "ok", ran: 1 });
  });

  it("Fridays only: the weekly brief joins the daily run, and its card shows at once (nothing to undo)", async () => {
    const r = reads({ overdue: [], disputes: [] });
    const briefAnswer = {
      title: "Weekly brief",
      summary: "This week in numbers.",
      actions: [{ command: "insight.publish", params: { kind: "brief", title: "$1,200.00 in this week", body: "1 payment brought in $1,200.00.", metricRefs: ["m_in", "m_payments"] }, why: "Friday." }],
      confidence: "high",
      questionForMerchant: null,
    };
    // Friday Oct 30, 08:01 in Los Angeles.
    const out = await runDailySweeps({ pool, read: r.read, agent: new ScriptedAgentClient([briefAnswer]), now: () => new Date("2026-10-30T15:01:00Z") });
    expect(out.map((s) => s.name)).toEqual(["overdue-invoices", "dispute-deadlines", "weekly-brief"]);
    const brief = out.find((s) => s.name === "weekly-brief")!.outcome;
    expect(brief).toMatchObject({ status: "ok", ran: 1 });
    const card = await pool.query("select state, front_json from cards where id = $1", [(brief as { cardIds: string[] }).cardIds[0]]);
    expect(card.rows[0].state).toBe("executed");
    expect(card.rows[0].front_json).toMatchObject({ eyebrow: "INSIGHTS · WEEKLY BRIEF", title: "$1,200.00 in this week", lines: [{ description: "Money in this week", amount: "$1,200.00" }, { description: "Payments this week", amount: "1" }] });
  });

  it("the brief: 'Weekly brief now' twice makes one; on Ask me, Approve shows it", async () => {
    const r = reads({ overdue: [], disputes: [] });
    const briefAnswer = () => ({
      title: "Weekly brief",
      summary: "This week in numbers.",
      actions: [{ command: "insight.publish", params: { kind: "brief", title: "$1,200.00 in this week", body: "1 payment brought in $1,200.00.", metricRefs: ["m_in", "m_payments"] }, why: "Friday." }],
      confidence: "high",
      questionForMerchant: null,
    });
    const friday = new Date("2026-10-30T16:00:00Z");
    const now = (agent: ScriptedAgentClient) => runSweep({ pool, read: r.read, agent, now: () => friday }, DEMO_MERCHANT, "weekly-brief");

    expect(await now(new ScriptedAgentClient([briefAnswer()]))).toMatchObject({ status: "ok", ran: 1 });
    expect(await now(new ScriptedAgentClient([]))).toMatchObject({ status: "ok", found: 1, skipped: 1, ran: 0 }); // no model call

    await pool.query("update proposals set status = 'obsolete' where status = 'executed'");
    await updateControls(pool, DEMO_MERCHANT, { dials: { "insight.publish": "ask" } });
    try {
      const asked = await now(new ScriptedAgentClient([briefAnswer()]));
      const cardId = (asked as { cardIds: string[] }).cardIds[0];
      expect((await pool.query("select state from cards where id = $1", [cardId])).rows[0].state).toBe("awaiting_approval");
      const out = await approveAndExecute({ db: pool, read: r.read, write: {} as ExecutorDeps["write"], now: () => friday }, DEMO_MERCHANT, cardId);
      expect(out).toEqual({ status: "executed", message: "Brief shown: $1,200.00 in this week" });
      expect((await pool.query("select state from cards where id = $1", [cardId])).rows[0].state).toBe("executed");
    } finally {
      await pool.query("delete from rules where merchant_id = $1", [DEMO_MERCHANT]);
    }
  });

  it("the cap rotates: the subject left out today goes first next time", async () => {
    const r = reads({ overdue: [acmeInvoice, second] });
    const one = (at: Date) =>
      runSweep({ pool, read: r.read, agent: new ScriptedAgentClient([friendlyReminder(), reminder0043()]), now: () => at }, DEMO_MERCHANT, "overdue-invoices", 1);
    const first = await one(NOW);
    expect(first).toMatchObject({ status: "ok", found: 2, deferred: 1 });
    await pool.query("update proposals set status = 'obsolete' where status = 'awaiting_approval'");
    await one(new Date(NOW.getTime() + 86_400_000));
    const runs = await pool.query("select subject_ref from runs where trigger = 'sweep:overdue-invoices' order by started_at desc limit 2");
    expect(new Set(runs.rows.map((x) => x.subject_ref)).size).toBe(2);
  });

  it("one sweep per merchant at a time: a second gets busy, with no reads", async () => {
    const holder = await pool.connect();
    try {
      await holder.query("select pg_advisory_lock(hashtext($1))", [`pyp-sweep:${DEMO_MERCHANT}`]);
      const r = reads();
      expect(await sweep(r, new ScriptedAgentClient([]))).toEqual({ status: "busy" });
      expect(r.asked.today).toBeUndefined();
    } finally {
      await holder.query("select pg_advisory_unlock_all()");
      holder.release();
    }
  });

  it("daily: a failed sweep is tried again after the backoff, not lost for the day", async () => {
    const r = reads({ overdue: [acmeInvoice], disputes: [] });
    let down = true;
    const overdue = r.read.overdueInvoices;
    r.read.overdueInvoices = async (today, limit) => {
      if (down) throw new Error("PayPal timed out");
      return overdue(today, limit);
    };
    const at = (iso: string) => ({ pool, read: r.read, agent: new ScriptedAgentClient([friendlyReminder()]), now: () => new Date(iso) });

    const first = await runDailySweeps(at("2026-10-28T15:01:00Z"));
    expect(first.find((s) => s.name === "overdue-invoices")?.outcome).toMatchObject({ status: "error" });
    down = false;
    expect(await runDailySweeps(at("2026-10-28T15:10:00Z"))).toEqual([]); // inside the backoff
    const retried = await runDailySweeps(at("2026-10-28T15:20:00Z"));
    expect(retried.map((s) => [s.name, s.outcome.status])).toEqual([["overdue-invoices", "ok"]]);
  });

  it("daily: one merchant with a bad time zone doesn't stop the others", async () => {
    const broken = await pool.query("insert into merchants (name, timezone) values ('Broken', 'Mars/Base') returning id");
    try {
      const r = reads({ overdue: [], disputes: [] });
      const out = await runDailySweeps({ pool, read: r.read, agent: new ScriptedAgentClient([]), now: () => new Date("2026-10-28T15:01:00Z") });
      expect(out.find((s) => s.merchantId === broken.rows[0].id)?.outcome.status).toBe("error");
      expect(out.filter((s) => s.merchantId === DEMO_MERCHANT).map((s) => s.outcome.status)).toEqual(["ok", "ok"]);
    } finally {
      await pool.query("delete from merchants where id = $1", [broken.rows[0].id]);
    }
  });

  it("daily: limited to the given merchants", async () => {
    const r = reads({ overdue: [], disputes: [] });
    const out = await runDailySweeps({ pool, read: r.read, agent: new ScriptedAgentClient([]), now: () => NOW, merchantIds: ["00000000-0000-0000-0000-00000000ffff"] });
    expect(out).toEqual([]);
  });
});
