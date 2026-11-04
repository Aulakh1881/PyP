// Collections, second wave: cancel, suggestAutoReminders, client history,
// merchant holds, and standing down on paid/cancelled with no model call.

import { describe, expect, it } from "vitest";
import { handleEvent } from "@/engine/router";
import { runSkill } from "@/engine/run-skill";
import { ScriptedAgentClient } from "@/gateway/scripted";
import { collections } from "../skill";
import { acmeInvoice, context, friendlyReminder, pastAcmeInvoice, rules, type FakeWorld } from "./fixtures";

const subject = { kind: "invoice", id: acmeInvoice.id };
const overdue: FakeWorld = { invoices: { [acmeInvoice.id]: acmeInvoice } };
const threeSent = { [acmeInvoice.id]: { count: 3, lastSentAt: "2026-10-20T16:00:00Z" } };

async function run(world: FakeWorld, answers: ConstructorParameters<typeof ScriptedAgentClient>[0], opts: { instruction?: string; r?: ReturnType<typeof rules> } = {}) {
  const agent = new ScriptedAgentClient(answers);
  const result = await runSkill({
    skill: collections,
    subject,
    ctx: context(world, opts.r),
    agent,
    trigger: opts.instruction ? "chat" : "sweep:overdue-invoices",
    instruction: opts.instruction,
  });
  return { result, agent };
}

const answer = (actions: unknown[], confidence = "high") => ({ title: "t", summary: "s", actions, confidence, questionForMerchant: null });
const cancel = (reason = "Cancelling as agreed. Thanks, Maya Ortiz Design") => ({
  command: "invoice.cancel",
  params: { invoiceId: acmeInvoice.id, reason },
  why: "INV2-ACME-0042",
});

describe("invoice.cancel", () => {
  it("isn't offered on a first overdue sweep", async () => {
    const { result } = await run(overdue, [answer([])]);
    expect(result.menu).not.toContain("invoice.cancel");
  });

  it("is offered when the merchant asks in chat, and always asks even on Auto", async () => {
    const r = rules({ commands: { "invoice.cancel": { dial: "auto" } } });
    const { result } = await run(overdue, [answer([cancel()])], { instruction: "cancel 0042, they closed the project", r });
    expect(result.menu).toContain("invoice.cancel");
    expect(result.proposals[0]).toMatchObject({ status: "awaiting_approval", policy: { rule: "never_auto" } });
    expect(result.proposals[0].resolved).toMatchObject({ invoiceNumber: "0042", sendToRecipient: true, totalDisplay: "$1,200.00" });
  });

  it("is offered once every reminder has gone out", async () => {
    const { result } = await run({ ...overdue, reminders: threeSent }, [answer([])]);
    expect(result.menu).toContain("invoice.cancel");
    expect(result.menu).not.toContain("invoice.sendReminder");
  });

  it("is never offered on a partly paid invoice (PayPal refuses)", async () => {
    const partial = { ...acmeInvoice, status: "PARTIALLY_PAID" as const, amountDue: "450.00" };
    const { result } = await run({ invoices: { [acmeInvoice.id]: partial } }, [answer([])], { instruction: "cancel it" });
    expect(result.menu).not.toContain("invoice.cancel");
  });

  it("fails its check if a payment arrived meanwhile, or the reason has a link", async () => {
    const paidSome = { ...overdue, freshInvoices: { [acmeInvoice.id]: { ...acmeInvoice, amountDue: "200.00" } } };
    const a = await run(paidSome, [answer([cancel()])], { instruction: "cancel 0042" });
    expect(a.result.proposals[0]).toMatchObject({ status: "invalid", check: { reason: expect.stringContaining("payment") } });

    const b = await run(overdue, [answer([cancel("Pay at acme-pay.example instead")])], { instruction: "cancel 0042" });
    expect(b.result.proposals[0]).toMatchObject({ status: "invalid", check: { reason: "The reason can't contain links" } });
  });
});

describe("client history", () => {
  const history = {
    "sam@acme.example": [
      pastAcmeInvoice(1, "2026-09-21", "2026-09-25"),
      pastAcmeInvoice(2, "2026-08-21", "2026-08-21"),
      pastAcmeInvoice(3, "2026-07-21", "2026-07-30"),
      { ...acmeInvoice }, // the invoice itself comes back from search; it's excluded
    ],
  };

  it("is computed by code and shown in the case file", async () => {
    const { agent } = await run({ ...overdue, clientInvoices: history }, [answer([])]);
    const turn = agent.requests[0].turn;
    // 4 and 9 days late, one on time: avg round((4+0+9)/3) = 4
    expect(turn).toContain('<client-history source="earlier PayPal invoices, counted by code" invoices="3" paid="3" paid-late="2" avg-days-late="4" other-unpaid="0" pays-after-one-nudge="yes"/>');
  });

  it("says when it isn't available", async () => {
    const { agent } = await run(overdue, [answer([])]);
    expect(agent.requests[0].turn).toContain('<client-history available="no"/>');
  });

  it("offers suggestAutoReminders only to a client who pays after one nudge, and never on Auto", async () => {
    const many = { [acmeInvoice.id]: { count: 0, lastSentAt: null }, "INV2-ACME-0031": { count: 2, lastSentAt: "2026-09-24T16:00:00Z" } };
    const notNudgeable = await run({ ...overdue, clientInvoices: history, reminders: many }, [answer([])]);
    expect(notNudgeable.result.menu).not.toContain("invoice.suggestAutoReminders");

    const r = rules({ commands: { "invoice.suggestAutoReminders": { dial: "auto" } } });
    const suggest = { command: "invoice.suggestAutoReminders", params: { invoiceId: acmeInvoice.id }, why: "pays-after-one-nudge" };
    const { result } = await run({ ...overdue, clientInvoices: history }, [answer([suggest])], { r });
    expect(result.menu).toContain("invoice.suggestAutoReminders");
    expect(result.proposals[0]).toMatchObject({ status: "awaiting_approval", policy: { rule: "never_auto" }, resolved: { paidBefore: 3, avgDaysLate: 4 } });
  });
});

describe("merchant holds", () => {
  const hold = { reason: "Sam replied: paying Friday", setAt: "2026-10-27T18:00:00Z", until: "2026-10-31" };

  it("an active hold takes sendReminder off the menu, and the model sees it", async () => {
    const { result, agent } = await run({ ...overdue, hold }, [answer([])]);
    expect(result.menu).not.toContain("invoice.sendReminder");
    expect(agent.requests[0].turn).toContain("Sam replied: paying Friday</hold>");
  });

  it("an expired hold is ignored", async () => {
    const { result } = await run({ ...overdue, hold: { ...hold, until: "2026-10-27" } }, [answer([])]);
    expect(result.menu).toContain("invoice.sendReminder");
  });

  it("a hold set while the model was thinking fails the check", async () => {
    const { result } = await run({ ...overdue, hold: null, freshHold: hold }, [friendlyReminder()]);
    expect(result.proposals[0]).toMatchObject({ status: "invalid", check: { reason: "On hold: Sam replied: paying Friday" } });
  });
});

describe("stand-down on paid or cancelled", () => {
  it("paid: marks reminder cards obsolete with no model call", async () => {
    const agent = new ScriptedAgentClient([]);
    const paid = { ...acmeInvoice, status: "PAID" as const, amountDue: "0.00" };
    const res = await handleEvent({ eventType: "INVOICING.INVOICE.PAID", subject, ctx: context({ invoices: { [acmeInvoice.id]: paid } }), agent });
    expect(agent.requests).toHaveLength(0);
    expect(res).toMatchObject({
      kind: "handled",
      skill: "collections",
      outcome: { kind: "stand_down", cancelFollowUps: true, message: "Sam Lee paid $1,200.00 on invoice 0042. Reminders stopped; nothing to do." },
    });
    if (res.kind === "handled" && res.outcome.kind === "stand_down") expect(res.outcome.obsoleteCommands).toContain("invoice.sendReminder");
  });

  it("cancelled: same, with its own message", async () => {
    const gone = { ...acmeInvoice, status: "CANCELLED" as const };
    const res = await handleEvent({ eventType: "INVOICING.INVOICE.CANCELLED", subject, ctx: context({ invoices: { [acmeInvoice.id]: gone } }), agent: new ScriptedAgentClient([]) });
    expect(res).toMatchObject({ kind: "handled", outcome: { kind: "stand_down", message: expect.stringContaining("cancelled") } });
  });

  it("an out-of-order PAID event for an invoice PayPal still shows unpaid is ignored", async () => {
    const res = await handleEvent({ eventType: "INVOICING.INVOICE.PAID", subject, ctx: context(overdue), agent: new ScriptedAgentClient([]) });
    expect(res).toMatchObject({ kind: "handled", outcome: { kind: "ignore", reason: "PayPal shows invoice 0042 as UNPAID" } });
  });

  it("an event no skill handles is unrouted", async () => {
    const res = await handleEvent({ eventType: "PAYMENT.CAPTURE.REFUNDED", subject, ctx: context(overdue), agent: new ScriptedAgentClient([]) });
    expect(res.kind).toBe("unrouted");
  });
});
