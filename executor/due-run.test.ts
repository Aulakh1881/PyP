// The worker tick on a real Postgres (skipped without TEST_DATABASE_URL; CI
// runs them): Auto actions after the undo window, Undo, the kill switch, and
// follow-ups that start a fresh Collections run. The model is scripted and
// PayPal is a fake that records each write.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getSkill } from "@/engine/registry";
import { runSkill } from "@/engine/run-skill";
import type { Invoice, PayPalReads } from "@/engine/types";
import { ScriptedAgentClient } from "@/gateway/scripted";
import { executeProposal } from "./execute";
import type { PayPalWriteClient } from "@/paypal/write-client";
import { acmeInvoice, context, friendlyReminder, NOW, rules } from "@/skills/collections/evals/fixtures";
import { runDueWork } from "@/jobs/due-run";
import { listCards, saveRun, undo } from "@/jobs/store";
import { DEMO_MERCHANT, TEST_DB_URL, freshDatabase } from "@/jobs/test-db";

const subject = { kind: "invoice", id: acmeInvoice.id };
const at = (seconds: number) => new Date(NOW.getTime() + seconds * 1000);
const AUTO_REMINDERS = rules({ commands: { "invoice.sendReminder": { dial: "auto" } } });

function followUpAnswer(inDays = 3) {
  return {
    title: "Watch invoice 0042",
    summary: "Nothing to send yet; look again in a few days.",
    actions: [{ command: "invoice.scheduleFollowUp", params: { invoiceId: acmeInvoice.id, inDays }, why: "Reminded recently." }],
    confidence: "high",
    questionForMerchant: null,
  };
}

describe.skipIf(!TEST_DB_URL)("worker: scheduled proposals (Postgres)", () => {
  let pool: Pool;
  let drop: () => Promise<void>;
  let reminders: string[];
  let invoice: Invoice;

  beforeAll(async () => {
    ({ pool, drop } = await freshDatabase());
  });
  afterAll(async () => drop?.());
  beforeEach(async () => {
    reminders = [];
    invoice = acmeInvoice;
    // Each test starts with an empty queue and the kill switch off.
    // No reminder history either, so one test's sent reminder can't block the next.
    await pool.query("update proposals set status = 'obsolete' where status in ('scheduled', 'executing', 'executed')");
    await pool.query("update merchants set kill_switch = false where id = $1", [DEMO_MERCHANT]);
  });

  const read: PayPalReads = { getInvoice: async (id) => (id === invoice.id ? invoice : null), recentClients: async () => [] };
  const write = {
    async remindInvoice(_id: string, _msg: unknown, requestId: string) {
      reminders.push(requestId);
      return { status: 204, debugId: "dbg", body: null };
    },
  } as unknown as PayPalWriteClient;

  function tick(seconds: number, agent = new ScriptedAgentClient([])) {
    const now = () => at(seconds);
    return runDueWork({ pool, read, agent, now, execute: (m, p) => executeProposal({ db: pool, read, write, now }, m, p) });
  }

  /** One Collections run stored at NOW, the way a sweep would store it. */
  async function stored(answer: object, r = AUTO_REMINDERS): Promise<string> {
    const result = await runSkill({
      skill: getSkill("collections"),
      subject,
      ctx: context({ invoices: { [acmeInvoice.id]: acmeInvoice } }, r),
      agent: new ScriptedAgentClient([answer]),
      trigger: "sweep:overdue-invoices",
    });
    const { cardIds } = await saveRun(pool, { merchantId: DEMO_MERCHANT, skill: "collections", subject, trigger: "sweep", result, now: NOW });
    expect(cardIds).toHaveLength(1);
    return cardIds[0];
  }
  const card = async (id: string) => (await listCards(pool, DEMO_MERCHANT)).find((c) => c.id === id)!;

  it("an Auto reminder waits out the 60 s undo window, then the executor sends it once", async () => {
    const id = await stored(friendlyReminder());
    expect(await card(id)).toMatchObject({ state: "scheduled", front: { scheduledFor: at(60).toISOString() } });

    expect(await tick(30)).toEqual([]);
    expect(reminders).toEqual([]);

    const out = await tick(61);
    expect(out).toEqual([
      { proposalId: expect.any(String), commandId: "invoice.sendReminder", status: "executed", message: "Reminder 1 sent for invoice 0042 ($1,200.00)" },
    ]);
    expect(reminders).toEqual([out[0].proposalId]);
    expect((await card(id)).state).toBe("executed");
    expect(await tick(120)).toEqual([]); // nothing runs twice
  });

  it("Undo inside the window: nothing is sent, and it's too late to undo once it ran", async () => {
    const id = await stored(friendlyReminder());
    expect(await undo(pool, DEMO_MERCHANT, id)).toBe(true);
    expect((await card(id)).state).toBe("undone");
    expect(await tick(61)).toEqual([]);
    expect(reminders).toEqual([]);

    const other = await stored(friendlyReminder());
    await tick(61);
    expect(await undo(pool, DEMO_MERCHANT, other)).toBe(false);
  });

  it("the kill switch holds scheduled work until it's off", async () => {
    await stored(friendlyReminder());
    await pool.query("update merchants set kill_switch = true where id = $1", [DEMO_MERCHANT]);
    expect(await tick(61)).toEqual([]);
    await pool.query("update merchants set kill_switch = false where id = $1", [DEMO_MERCHANT]);
    expect((await tick(62)).map((r) => r.status)).toEqual(["executed"]);
  });

  it("paid during the window: the re-check stops it and nothing is sent", async () => {
    const id = await stored(friendlyReminder());
    invoice = { ...acmeInvoice, status: "PAID", amountDue: "0.00" };
    expect((await tick(61)).map((r) => r.status)).toEqual(["obsolete"]);
    expect(reminders).toEqual([]);
    expect((await card(id)).state).toBe("obsolete");
  });

  it("two workers ticking at once run each proposal once", async () => {
    await stored(friendlyReminder());
    const [a, b] = await Promise.all([tick(61), tick(61)]);
    expect(a.length + b.length).toBe(1);
    expect(reminders).toHaveLength(1);
  });

  it("a follow-up comes due after its days and starts a fresh Collections run", async () => {
    const id = await stored(followUpAnswer(3), rules());
    expect(await card(id)).toMatchObject({ state: "scheduled", front: { scheduledFor: at(3 * 86_400).toISOString() } });
    expect(await tick(2 * 86_400)).toEqual([]);

    const agent = new ScriptedAgentClient([friendlyReminder()]);
    const out = await tick(3 * 86_400 + 1, agent);
    expect(out).toEqual([
      { proposalId: expect.any(String), commandId: "invoice.scheduleFollowUp", status: "executed", message: "Followed up on invoice INV2-ACME-0042: 1 new card" },
    ]);
    expect((await card(id)).state).toBe("executed");
    const fresh = (await listCards(pool, DEMO_MERCHANT)).find((c) => c.id !== id && c.state === "awaiting_approval" && c.front.title === "Acme is 7 days late");
    expect(fresh).toBeDefined();
    const runs = await pool.query("select count(*)::int as n from runs where trigger = 'follow-up'");
    expect(runs.rows[0].n).toBe(1);
  });
});
