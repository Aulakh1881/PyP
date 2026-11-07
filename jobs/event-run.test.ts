// Webhook events and holds on a real Postgres (skipped without
// TEST_DATABASE_URL; CI runs them). The model is scripted and PayPal is faked.

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { runSkill } from "@/engine/run-skill";
import type { Invoice, PayPalReads } from "@/engine/types";
import { ScriptedAgentClient } from "@/gateway/scripted";
import { acmeInvoice, context, friendlyReminder } from "@/skills/collections/evals/fixtures";
import { getSkill } from "@/engine/registry";
import { calmFacts, evidenceAnswer, notReceived } from "@/skills/disputes/evals/fixtures";
import { processEvent, type PayPalEvent } from "./event-run";
import { engineDb, insertEvent, liftHolds, saveRun, setHold } from "./store";
import { DEMO_MERCHANT, TEST_DB_URL, freshDatabase } from "./test-db";

const NOW = new Date("2026-10-28T15:00:00Z");
const invoiceSubject = { kind: "invoice", id: acmeInvoice.id };

function reads(invoice: Invoice): PayPalReads {
  return {
    getInvoice: async (id) => (id === invoice.id ? invoice : null),
    recentClients: async () => [],
    getDispute: async (id) => (id === notReceived.id ? notReceived : null),
  };
}

describe.skipIf(!TEST_DB_URL)("webhook events and holds (Postgres)", () => {
  let pool: Pool;
  let drop: () => Promise<void>;

  beforeAll(async () => {
    ({ pool, drop } = await freshDatabase());
  });
  afterAll(async () => drop?.());

  /** A waiting reminder card for invoice 0042, stored the way a sweep would. */
  async function pendingReminder(): Promise<string> {
    const result = await runSkill({
      skill: getSkill("collections"),
      subject: invoiceSubject,
      ctx: context({ invoices: { [acmeInvoice.id]: acmeInvoice } }),
      agent: new ScriptedAgentClient([friendlyReminder()]),
      trigger: "sweep:overdue-invoices",
    });
    const { cardIds } = await saveRun(pool, { merchantId: DEMO_MERCHANT, skill: "collections", subject: invoiceSubject, trigger: "sweep", result });
    expect(cardIds).toHaveLength(1);
    return cardIds[0];
  }

  async function deliver(event: PayPalEvent, invoice: Invoice, agent = new ScriptedAgentClient([])) {
    const isNew = await insertEvent(pool, { id: event.id, merchantId: DEMO_MERCHANT, type: event.event_type, resourceId: null, raw: event });
    expect(isNew).toBe(true);
    return { out: await processEvent({ pool, read: reads(invoice), agent, now: () => NOW }, DEMO_MERCHANT, event), agent };
  }

  it("INVOICE.PAID: the waiting reminder card goes obsolete, with no model call", async () => {
    const cardId = await pendingReminder();
    const paid = { ...acmeInvoice, status: "PAID" as const, amountDue: "0.00" };
    const { out, agent } = await deliver({ id: "WH-PAID-1", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: acmeInvoice.id } } }, paid);

    expect(out.status).toBe("stood_down");
    expect(agent.requests).toHaveLength(0);
    const card = await pool.query("select state from cards where id = $1", [cardId]);
    expect(card.rows[0].state).toBe("obsolete");
    const ev = await pool.query("select status from events where id = 'WH-PAID-1'");
    expect(ev.rows[0].status).toBe("done");
    const log = await pool.query("select summary from activity_log where merchant_id = $1 order by id desc limit 1", [DEMO_MERCHANT]);
    expect(log.rows[0].summary).toBe("Sam Lee paid $1,200.00 on invoice 0042. Reminders stopped; nothing to do.");
  });

  it("the same event delivered twice is stored once", async () => {
    const e = { id: "WH-DUP", merchantId: DEMO_MERCHANT, type: "INVOICING.INVOICE.PAID", resourceId: null, raw: {} };
    expect(await insertEvent(pool, e)).toBe(true);
    expect(await insertEvent(pool, e)).toBe(false);
  });

  it("a PAID event PayPal doesn't agree with is ignored and the card stays", async () => {
    const cardId = await pendingReminder();
    const { out } = await deliver({ id: "WH-PAID-2", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: acmeInvoice.id } } }, acmeInvoice);
    expect(out).toMatchObject({ status: "ignored", reason: "PayPal shows invoice 0042 as UNPAID" });
    const card = await pool.query("select state from cards where id = $1", [cardId]);
    expect(card.rows[0].state).toBe("awaiting_approval");
  });

  it("DISPUTE.CREATED: one run with a card, linked to the event; a replay can't make a second run", async () => {
    const event = { id: "WH-DISP-1", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: notReceived.id } };
    const { out } = await deliver(event, acmeInvoice, new ScriptedAgentClient([calmFacts, evidenceAnswer()]));
    expect(out).toMatchObject({ status: "ran", cardIds: [expect.any(String)] });
    const runs = await pool.query("select skill, trigger from runs where trigger_event_id = 'WH-DISP-1'");
    expect(runs.rows).toEqual([{ skill: "disputes", trigger: "event:CUSTOMER.DISPUTE.CREATED" }]);

    const again = await processEvent(
      { pool, read: reads(acmeInvoice), agent: new ScriptedAgentClient([calmFacts, evidenceAnswer()]), now: () => NOW },
      DEMO_MERCHANT,
      event,
    );
    expect(again.status).toBe("failed");
    expect((await pool.query("select count(*)::int as n from runs where trigger_event_id = 'WH-DISP-1'")).rows[0].n).toBe(1);
  });

  it("holds: set, read by the engine, lifted", async () => {
    const db = engineDb(pool, DEMO_MERCHANT);
    expect(await db.activeHold!(invoiceSubject)).toBeNull();
    await setHold(pool, DEMO_MERCHANT, invoiceSubject, "Sam replied: paying Friday", "2026-10-31");
    expect(await db.activeHold!(invoiceSubject)).toMatchObject({ reason: "Sam replied: paying Friday", until: "2026-10-31" });
    expect(await liftHolds(pool, DEMO_MERCHANT, invoiceSubject)).toBe(1);
    expect(await db.activeHold!(invoiceSubject)).toBeNull();
  });
});
