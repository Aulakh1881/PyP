// Sweeps on a real Postgres (skipped without TEST_DATABASE_URL; CI runs them).
// PayPal reads are faked and the model is scripted.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import type { Dispute, Invoice } from "@/engine/types";
import { ScriptedAgentClient } from "@/gateway/scripted";
import { acmeInvoice, friendlyReminder, NOW } from "@/skills/collections/evals/fixtures";
import { calmFacts, evidenceAnswer, notReceived } from "@/skills/disputes/evals/fixtures";
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
});
