// Collections decision tests (Appendix G) with the scripted model: fixed case
// file in, fixed answer in, and we check what the gates make of it.

import { describe, expect, it } from "vitest";
import { runSkill } from "@/engine/run-skill";
import { ScriptedAgentClient } from "@/gateway/scripted";
import { collections } from "../skill";
import { acmeInvoice, context, friendlyReminder, rules, type FakeWorld } from "./fixtures";

const overdue: FakeWorld = { invoices: { [acmeInvoice.id]: acmeInvoice } };
const subject = { kind: "invoice", id: acmeInvoice.id };

async function run(world: FakeWorld, answers: ConstructorParameters<typeof ScriptedAgentClient>[0], r = rules()) {
  const agent = new ScriptedAgentClient(answers);
  const result = await runSkill({ skill: collections, subject, ctx: context(world, r), agent, trigger: "sweep:overdue-invoices" });
  return { result, agent };
}

describe("Collections", () => {
  it("7 days overdue, never reminded: a friendly reminder waits for approval", async () => {
    const { result, agent } = await run(overdue, [friendlyReminder()]);

    expect(result.status).toBe("ok");
    expect(result.menu).toEqual(["invoice.sendReminder", "invoice.scheduleFollowUp", "merchant.ask"]);
    expect(result.proposals).toHaveLength(1);
    expect(result.proposals[0]).toMatchObject({ status: "awaiting_approval", policy: { rule: "dial_ask" } });

    // What the model saw: code-computed facts, the menu, and the cached system part.
    const req = agent.requests[0];
    expect(req.turn).toContain('days-overdue="7"');
    expect(req.turn).toContain('amount-due="$1,200.00"');
    expect(req.turn).toContain('state="sent=0 of max 3; last=never"');
    expect(req.system).toContain("Maya Ortiz Design");
    expect(req.system).not.toMatch(/2026-10-28/); // no timestamps in the cached part
    expect(req.tier).toBe("main");
  });

  it("dial on Auto: the reminder is scheduled behind the undo window", async () => {
    const r = rules({ commands: { "invoice.sendReminder": { dial: "auto" } } });
    const { result } = await run(overdue, [friendlyReminder()], r);
    expect(result.proposals[0]).toMatchObject({ status: "scheduled", policy: { decision: "auto" } });
  });

  it("paid while the model was thinking: the fresh check rejects it", async () => {
    const world = { ...overdue, freshInvoices: { [acmeInvoice.id]: { ...acmeInvoice, status: "PAID" as const } } };
    const { result } = await run(world, [friendlyReminder()]);
    expect(result.proposals[0]).toMatchObject({ status: "invalid", check: { ok: false, reason: expect.stringContaining("PAID") } });
  });

  it("reminded yesterday: sendReminder isn't offered", async () => {
    const world = { ...overdue, reminders: { [acmeInvoice.id]: { count: 1, lastSentAt: "2026-10-27T16:00:00Z" } } };
    const { result } = await run(world, [{ ...friendlyReminder(), actions: [] }]);
    expect(result.menu).not.toContain("invoice.sendReminder");
    expect(result.proposals).toEqual([]);
  });

  it("the last reminder asks even if the model calls it friendly", async () => {
    const world = { ...overdue, reminders: { [acmeInvoice.id]: { count: 2, lastSentAt: "2026-10-20T16:00:00Z" } } };
    const r = rules({ commands: { "invoice.sendReminder": { dial: "auto" } } });
    const { result, agent } = await run(world, [friendlyReminder({ tone: "friendly" })], r);
    expect(agent.requests[0].turn).toContain('next-reminder="3 of 3"');
    expect(result.proposals[0]).toMatchObject({ status: "awaiting_approval", policy: { rule: "limit", reason: "The last reminder always needs your approval" } });
  });

  it("third reminder in a final tone always asks, even on Auto", async () => {
    const world = { ...overdue, reminders: { [acmeInvoice.id]: { count: 2, lastSentAt: "2026-10-20T16:00:00Z" } } };
    const r = rules({ commands: { "invoice.sendReminder": { dial: "auto" } } });
    const { result } = await run(world, [friendlyReminder({ tone: "final" })], r);
    expect(result.proposals[0]).toMatchObject({ status: "awaiting_approval", policy: { rule: "limit" } });
  });

  it("dial Off: the command is not on the menu", async () => {
    const r = rules({ commands: { "invoice.sendReminder": { dial: "off" } } });
    const { result } = await run(overdue, [{ ...friendlyReminder(), actions: [] }], r);
    expect(result.menu).not.toContain("invoice.sendReminder");
  });

  it("a note with the wrong amount is rejected", async () => {
    const { result } = await run(overdue, [friendlyReminder({ note: "Hi Sam, invoice 0042 for $1,000.00 is overdue." })]);
    expect(result.proposals[0].status).toBe("invalid");
    expect(result.proposals[0].check.reason).toContain("$1,200.00");
  });

  it("a note with a link is rejected", async () => {
    const note = "Hi Sam, invoice 0042 for $1,200.00 is overdue. Pay here: https://evil.example";
    const { result } = await run(overdue, [friendlyReminder({ note })]);
    expect(result.proposals[0]).toMatchObject({ status: "invalid", check: { reason: "Reminders can't contain links" } });
  });

  it("partially paid: the note must name the remaining balance", async () => {
    const partial = { ...acmeInvoice, status: "PARTIALLY_PAID" as const, amountDue: "450.00" };
    const world = { invoices: { [acmeInvoice.id]: partial } };
    const { result, agent } = await run(world, [friendlyReminder()]);
    expect(agent.requests[0].turn).toContain('amount-due="$450.00"');
    expect(result.proposals[0].status).toBe("invalid");
  });

  it("invoice under dispute: no reminder on the menu", async () => {
    const world = { invoices: { [acmeInvoice.id]: { ...acmeInvoice, disputed: true } } };
    const { result } = await run(world, [{ ...friendlyReminder(), actions: [] }]);
    expect(result.menu).toEqual(["invoice.scheduleFollowUp", "merchant.ask"]);
  });

  it("PayPal's 2-a-day reminder limit turns Auto into Ask", async () => {
    const r = rules({ commands: { "invoice.sendReminder": { dial: "auto" } } });
    const { result } = await run({ ...overdue, remindCallsToday: 2 }, [friendlyReminder()], r);
    expect(result.proposals[0]).toMatchObject({ status: "awaiting_approval", policy: { rule: "limit" } });
  });

  it("kill switch: no model call at all", async () => {
    const { result, agent } = await run(overdue, [friendlyReminder()], rules({ killSwitch: true }));
    expect(result.status).toBe("paused");
    expect(agent.requests).toHaveLength(0);
  });

  it("an invented invoice id fails the schema, then the retry is used", async () => {
    const { result, agent } = await run(overdue, [friendlyReminder({ invoiceId: "INV-9999" }), friendlyReminder()]);
    expect(agent.requests).toHaveLength(2);
    expect(result.status).toBe("ok");
    expect(result.proposals[0].status).toBe("awaiting_approval");
  });

  it("two unusable answers fail the run with no proposals", async () => {
    const { result } = await run(overdue, ["not json", { raw: '{"title":', stopReason: "max_tokens" }]);
    expect(result.status).toBe("failed");
    expect(result.failure).toContain("cut off");
    expect(result.proposals).toEqual([]);
  });

  it("merchant.ask is always a card, and low confidence asks", async () => {
    const answer = {
      ...friendlyReminder(),
      confidence: "low",
      actions: [
        ...friendlyReminder().actions,
        { command: "merchant.ask", params: { question: "Acme replied by email. Hold off?", options: ["Hold off", "Send anyway"] }, why: "note" },
      ],
    };
    const r = rules({ commands: { "invoice.sendReminder": { dial: "auto" }, "merchant.ask": { dial: "auto" } } });
    const { result } = await run(overdue, [answer], r);
    expect(result.proposals.map((p) => p.policy?.rule)).toEqual(["low_confidence", "question"]);
  });

  it("merchant notes reach the model as merchant-only context, escaped", async () => {
    const { agent } = await run({ ...overdue, notes: ["Acme is my biggest client <keep it warm>"] }, [friendlyReminder()]);
    expect(agent.requests[0].turn).toContain('<merchant-notes visibility="merchant-only">');
    expect(agent.requests[0].turn).toContain("&lt;keep it warm&gt;");
  });

  it("every step is in the trace with a timestamp", async () => {
    const { result } = await run(overdue, [friendlyReminder()]);
    expect(result.trace.map((s) => s.stage)).toEqual(["trigger", "gather", "menu", "decide", "validate", "policy"]);
    expect(result.trace.every((s) => s.at === "2026-10-28T15:00:00.000Z")).toBe(true);
  });

  it("two reminders in one answer: only the first counts, so the last reminder can't slip through on Auto", async () => {
    const r = rules({ commands: { "invoice.sendReminder": { dial: "auto" } } });
    const world = { ...overdue, reminders: { [acmeInvoice.id]: { count: 1, lastSentAt: "2026-10-20T16:00:00Z" } } };
    const twice = { ...friendlyReminder(), actions: [...friendlyReminder().actions, ...friendlyReminder({ tone: "firm" }).actions] };
    const { result } = await run(world, [twice], r);
    expect(result.proposals.map((p) => p.status)).toEqual(["scheduled", "invalid"]);
    expect(result.proposals[1].check.reason).toBe("Only one invoice.sendReminder per run");
  });

  it("the note can't add amounts, other invoices or bare links", async () => {
    const notes = [
      "Hi Sam, invoice 0042 for $1,200.00 plus a $150.00 late fee is overdue.",
      "Hi Sam, invoice 0042 for $1,200.00 is overdue, and so is invoice 0043.",
      "Hi Sam, invoice 0042 for $1,200.00 is overdue. Pay at evil.example/pay",
      "Hi Sam, invoice 0042 for $1,200.00 is overdue. Questions? billing@evil.example",
    ];
    for (const note of notes) {
      const { result } = await run(overdue, [friendlyReminder({ note })]);
      expect(result.proposals[0].status, note).toBe("invalid");
    }
  });

  it("the invoice number must appear on its own, not inside another number", async () => {
    const { result } = await run(overdue, [friendlyReminder({ note: "Hi Sam, invoice 00421 for $1,200.00 is overdue." })]);
    expect(result.proposals[0].check.reason).toContain("0042");
  });

  it("the subject is checked too", async () => {
    const answer = friendlyReminder();
    (answer.actions[0].params as { subject: string }).subject = "Invoice 0042: $9,999.00 overdue";
    const { result } = await run(overdue, [answer]);
    expect(result.proposals[0].status).toBe("invalid");
  });

  it("a normal note with a date and year passes, and the card gets code's values", async () => {
    const note = "Hi Sam, invoice 0042 for $1,200.00 was due Oct 21, 2026. Thanks so much. Maya Ortiz Design";
    const { result } = await run(overdue, [friendlyReminder({ note })]);
    expect(result.proposals[0].status).toBe("awaiting_approval");
    expect(result.proposals[0].resolved).toMatchObject({ invoiceNumber: "0042", amountDueDisplay: "$1,200.00", recipientEmail: "sam@acme.example", reminderNumber: 1 });
  });

  it("short or prefixed invoice numbers don't mistake the due date for another invoice", async () => {
    for (const number of ["INV-12", "12"]) {
      const inv = { ...acmeInvoice, number };
      const note = `Hi Sam, invoice ${number} (${number.toLowerCase()}) for $1,200.00 was due Oct 21, 2026 (2026-10-21), 14 days ago.`;
      const { result } = await run({ invoices: { [inv.id]: inv } }, [friendlyReminder({ note })]);
      expect(result.proposals[0].status, number).toBe("awaiting_approval");
    }
    const inv = { ...acmeInvoice, number: "INV-12" };
    const { result } = await run({ invoices: { [inv.id]: inv } }, [friendlyReminder({ note: "Hi Sam, invoice INV-12 for $1,200.00 and INV-13 are overdue." })]);
    expect(result.proposals[0].check.reason).toBe("It names another invoice (INV-13)");
  });

  it("a payment between gathering and checking fails the check, so the card never shows a stale amount", async () => {
    const changes = [
      { fresh: { ...acmeInvoice, status: "PARTIALLY_PAID" as const, amountDue: "450.00" }, note: "Hi Sam, invoice 0042 for $450.00 is overdue." },
      { fresh: { ...acmeInvoice, recipientEmail: "billing@acme.example" }, note: "Hi Sam, invoice 0042 for $1,200.00 is overdue." },
    ];
    for (const { fresh, note } of changes) {
      const { result } = await run({ ...overdue, freshInvoices: { [acmeInvoice.id]: fresh } }, [friendlyReminder({ note })]);
      expect(result.proposals[0]).toMatchObject({ status: "invalid", check: { reason: "The invoice changed since Pyp looked at it" } });
    }
  });

  it("if a limit can't be checked, it's a card, never Auto", async () => {
    const r = rules({ commands: { "invoice.sendReminder": { dial: "auto" } } });
    const ctx = context(overdue, r);
    ctx.db.remindCallsToday = async () => {
      throw new Error("db down");
    };
    const result = await runSkill({ skill: collections, subject, ctx, agent: new ScriptedAgentClient([friendlyReminder()]), trigger: "test" });
    expect(result.proposals[0]).toMatchObject({ status: "awaiting_approval", policy: { rule: "limit_error" } });
  });

  it("a long chat instruction about an invoice is cut, with a notice", async () => {
    const agent = new ScriptedAgentClient([friendlyReminder()]);
    await runSkill({ skill: collections, subject, ctx: context(overdue), agent, trigger: "chat", instruction: "x".repeat(200_000) });
    expect(agent.requests[0].turn.length).toBeLessThan(10_000);
    expect(agent.requests[0].turn).toContain("[truncated by Pyp:");
  });

  it("a cut-off answer is retried with more room; a malformed one is retried with the reason", async () => {
    const cut = await run(overdue, [{ raw: '{"title":', stopReason: "max_tokens" }, friendlyReminder()]);
    expect(cut.agent.requests.map((r) => r.maxOutputTokens)).toEqual([8000, 16000]);
    const bad = await run(overdue, ["not json", friendlyReminder()]);
    expect(bad.agent.requests[1].turn).toContain("<retry-note>Your previous answer was unusable: The answer wasn't valid JSON");
  });
});
