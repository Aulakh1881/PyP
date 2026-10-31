// "Invoice Acme $1,200, net 30" and friends (design B.1a, Appendix G).

import { describe, expect, it } from "vitest";
import { runSkill } from "@/engine/run-skill";
import { ScriptedAgentClient } from "@/gateway/scripted";
import { addDays, mentionsClient, parseAmounts, parseTerms } from "../request-parser";
import { collections } from "../skill";
import { context, demoClients, rules, type FakeWorld } from "./fixtures";

const world: FakeWorld = { invoices: {} };
const subject = { kind: "new-invoice", id: "chat_msg_1" };

function invoiceAnswer(over: Partial<{ clientId: string; items: { description: string; amountRef: string }[]; terms: string; note: string }> = {}) {
  return {
    title: "Invoice Acme Studio $1,200",
    summary: "New invoice for Acme Studio, net 30.",
    actions: [
      {
        command: "invoice.createAndSend",
        params: {
          clientId: over.clientId ?? "cl_1",
          items: over.items ?? [{ description: "Design work", amountRef: "amt_1" }],
          terms: over.terms ?? "net_30",
          note: over.note ?? "Thanks, Sam!",
        },
        why: "The request names Acme (cl_1), $1,200 (amt_1) and net 30.",
      },
    ],
    confidence: "high",
    questionForMerchant: null,
  };
}

async function run(instruction: string, answers: ConstructorParameters<typeof ScriptedAgentClient>[0], w: FakeWorld = world) {
  const agent = new ScriptedAgentClient(answers);
  const result = await runSkill({ skill: collections, subject, ctx: context(w, rules()), agent, trigger: "chat", instruction });
  return { result, agent };
}

const amounts = (text: string, currency = "USD") => parseAmounts(text, currency);
const terms = (text: string) => parseTerms(text).terms.map((t) => t.type);

describe("request parser", () => {
  it("finds amounts in the ways people type them", () => {
    const found = amounts("Invoice Acme $1,200 for the logo and $450.50 for edits, plus 300 USD travel and a $1.2k retainer");
    expect(found.amounts.map((a) => [a.id, a.value, a.display])).toEqual([
      ["amt_1", "1200.00", "$1,200.00"],
      ["amt_2", "450.50", "$450.50"],
      ["amt_3", "300.00", "$300.00"],
      ["amt_4", "1200.00", "$1,200.00"],
    ]);
    expect(found.problems).toEqual([]);
    expect(amounts("$1,200 USD").amounts).toHaveLength(1);
    expect(amounts("net 30, no amount, invoice 0042").amounts).toEqual([]);
    expect(amounts("$0").amounts).toEqual([]);
    expect(amounts("€450 for the logo", "EUR").amounts.map((a) => a.display)).toEqual(["450.00 EUR"]);
  });

  it("never guesses at an amount it can't read: it reports a problem instead", () => {
    for (const typed of ["$1,20", "1,20 dollars", "$1,2000", "$1.2.3", "$1200.999", "-$50", "refund of -$50 credit", "$99999999999999999999"]) {
      const r = amounts(typed);
      expect(r.amounts, typed).toEqual([]);
      expect(r.problems, typed).toHaveLength(1);
    }
    // The wrong currency is a problem, not a silent conversion.
    expect(amounts("€500").problems[0]).toContain("EUR");
    expect(amounts("$500", "EUR").problems[0]).toContain("USD");
    expect(amounts("$500", "CAD").amounts.map((a) => a.display)).toEqual(["500.00 CAD"]);
  });

  it("finds terms, and reports terms PayPal doesn't offer", () => {
    expect(terms("net 30")).toEqual(["NET_30"]);
    expect(terms("net30")).toEqual(["NET_30"]);
    expect(terms("Net-15 please")).toEqual(["NET_15"]);
    expect(terms("due in 45 days")).toEqual(["NET_45"]);
    expect(terms("due on receipt")).toEqual(["DUE_ON_RECEIPT"]);
    for (const typed of ["net 7", "net 31", "due in 5 days", "payable within 14 days"]) {
      expect(parseTerms(typed), typed).toMatchObject({ terms: [], problems: [expect.stringContaining("standard terms")] });
    }
    expect(addDays("2026-10-28", 30)).toBe("2026-11-27");
  });

  it("matches clients by email, business name or full name", () => {
    expect(mentionsClient("Invoice Acme $1,200", demoClients[0])).toBe(true);
    expect(mentionsClient("bill sam lee", demoClients[0])).toBe(true);
    expect(mentionsClient("invoice jordan.kim@example.com", demoClients[2])).toBe(true);
    expect(mentionsClient("Invoice the studio $1,200", demoClients[0])).toBe(false);
    expect(mentionsClient("Invoice Acmeville $5", demoClients[0])).toBe(false);
  });

  it("doesn't match on one shared word, a longer email, or a client with no email", () => {
    const client = (name: string | null, businessName: string | null, email = "x@client.example") => ({ id: "c", name, businessName, email });
    expect(mentionsClient("Bill Acme $500", client("Bill Jones", null))).toBe(false);
    expect(mentionsClient("Invoice Acme $500, net 30", client(null, "Net Solutions"))).toBe(false);
    expect(mentionsClient("Invoice Acme $500, due on receipt", client(null, "Due Diligence LLC"))).toBe(false);
    expect(mentionsClient("Invoice Ram $500", client("José Ramírez", null))).toBe(false);
    expect(mentionsClient("Invoice José Ramírez $500", client("José Ramírez", null))).toBe(true);
    expect(mentionsClient("Invoice notsam@acme.example.org", demoClients[0])).toBe(false);
    expect(mentionsClient("Invoice Design Co $500", client(null, "Design Co"))).toBe(true);
    expect(mentionsClient("Invoice Al Wu $500", client("Al Wu", null))).toBe(true);
    expect(mentionsClient("Invoice NewCo $450", client("NewCo", null, ""))).toBe(false);
  });
});

describe("Collections: new invoice from chat", () => {
  it('"Invoice Acme $1,200, net 30" → an approval card with exact client, amount and due date', async () => {
    const { result, agent } = await run("Invoice Acme $1,200, net 30", [invoiceAnswer()]);

    expect(result.menu).toEqual(["invoice.createAndSend", "merchant.ask"]);
    const turn = agent.requests[0].turn;
    expect(turn).toContain("<merchant-request>Invoice Acme $1,200, net 30</merchant-request>");
    expect(turn).toContain('<amount id="amt_1" value="$1,200.00"');
    expect(turn).toContain('<term id="net_30" paypal="NET_30" due-date="2026-11-27"/>');
    expect(turn).not.toContain("<merchant-instruction>"); // already in the case file
    expect(turn).toContain("<task>Turn the merchant's request into one invoice");

    const p = result.proposals[0];
    expect(p).toMatchObject({ status: "awaiting_approval", policy: { rule: "never_auto" } });
    expect(p.resolved).toEqual({
      client: { name: "Sam Lee", businessName: "Acme Studio", email: "sam@acme.example" },
      items: [{ description: "Design work", amount: "1200.00", display: "$1,200.00" }],
      currency: "USD",
      total: "1200.00",
      totalDisplay: "$1,200.00",
      termType: "NET_30",
      issueDate: "2026-10-28",
      dueDate: "2026-11-27",
      note: "Thanks, Sam!",
    });
  });

  it("only the named terms are offered", async () => {
    const { agent } = await run("Invoice Acme $1,200, net 30", [invoiceAnswer()]);
    const params = (agent.requests[0].schema as any).properties.actions.items.anyOf[0].properties.params;
    expect(params.properties.terms.enum).toEqual(["net_30"]);
  });

  it("no terms named: every standard term is offered and net 30 is marked default", async () => {
    const { agent } = await run("Invoice Acme $1,200", [invoiceAnswer()]);
    expect(agent.requests[0].turn).toContain('<term id="net_30" paypal="NET_30" due-date="2026-11-27" default="yes"/>');
    expect(agent.requests[0].turn).toContain('<term id="due_on_receipt"');
  });

  it("two amounts become two lines with a computed total", async () => {
    const items = [
      { description: "Logo", amountRef: "amt_1" },
      { description: "Edits", amountRef: "amt_2" },
    ];
    const { result } = await run("Invoice Acme $1,200 for the logo and $450.50 for edits", [invoiceAnswer({ items })]);
    expect(result.proposals[0].resolved).toMatchObject({ total: "1650.50", totalDisplay: "$1,650.50" });
  });

  it("only clients the request names are offered", async () => {
    const { agent } = await run("Invoice Acme $1,200, net 30", [invoiceAnswer()]);
    const params = (agent.requests[0].schema as any).properties.actions.items.anyOf[0].properties.params;
    expect(params.properties.clientId.enum).toEqual(["cl_1"]);
    expect(agent.requests[0].turn).toContain('email="sam@acme.example" named-in-request="yes"/>');
    expect(agent.requests[0].turn).toContain('<client id="cl_2" name="Priya Shah" business="Beta LLC" email="priya@beta.example"/>');
  });

  it('"Invoice NewCo $450" with clients on file but none named → merchant.ask only', async () => {
    const { result } = await run("Invoice NewCo $450", [{ ...invoiceAnswer(), actions: [] }]);
    expect(result.menu).toEqual(["merchant.ask"]);
  });

  it('"Invoice NewCo $450" with no known email → merchant.ask only', async () => {
    const ask = {
      title: "Who is NewCo?",
      summary: "NewCo isn't in your recent clients.",
      actions: [{ command: "merchant.ask", params: { question: "I don't have NewCo's email yet. Add them as a client in PayPal, then ask again?", options: ["OK"] }, why: "No client matches NewCo" }],
      confidence: "high",
      questionForMerchant: null,
    };
    const { result } = await run("Invoice NewCo $450", [ask], { invoices: {}, clients: [] });
    expect(result.menu).toEqual(["merchant.ask"]);
    expect(result.proposals[0]).toMatchObject({ status: "awaiting_approval", policy: { rule: "question" } });
  });

  it("no amount in the request → merchant.ask only", async () => {
    const { result } = await run("Invoice Acme for last month", [{ ...invoiceAnswer(), actions: [] }]);
    expect(result.menu).toEqual(["merchant.ask"]);
  });

  it("a client the request doesn't name can't be chosen", async () => {
    const { result, agent } = await run("Invoice Acme $1,200, net 30", [invoiceAnswer({ clientId: "cl_2" }), invoiceAnswer()]);
    expect(agent.requests).toHaveLength(2); // the schema refused cl_2; the retry is used
    expect(result.proposals[0].resolved).toMatchObject({ client: { email: "sam@acme.example" } });
  });

  it("the same amount on two lines is rejected", async () => {
    const items = [
      { description: "Logo", amountRef: "amt_1" },
      { description: "Logo again", amountRef: "amt_1" },
    ];
    const { result } = await run("Invoice Acme $1,200", [invoiceAnswer({ items })]);
    expect(result.proposals[0].check.reason).toBe("The same amount is used on two lines");
  });

  it("an amount the parser didn't find can't be named", async () => {
    const items = [{ description: "Logo", amountRef: "amt_9" }];
    const { result, agent } = await run("Invoice Acme $1,200", [invoiceAnswer({ items }), invoiceAnswer()]);
    expect(agent.requests).toHaveLength(2); // the first answer failed the schema
    expect(result.proposals[0].status).toBe("awaiting_approval");
  });

  it("a link in the note is rejected", async () => {
    const { result } = await run("Invoice Acme $1,200", [invoiceAnswer({ note: "Pay at www.evil.example" })]);
    expect(result.proposals[0].check.reason).toBe("Invoices can't contain links");
  });

  it("stays Ask even if the merchant sets the dial to Auto", async () => {
    const agent = new ScriptedAgentClient([invoiceAnswer()]);
    const r = rules({ commands: { "invoice.createAndSend": { dial: "auto" } } });
    const result = await runSkill({ skill: collections, subject, ctx: context(world, r), agent, trigger: "chat", instruction: "Invoice Acme $1,200" });
    expect(result.proposals[0].policy?.rule).toBe("never_auto");
  });

  it("refuses to run without the merchant's words", async () => {
    const result = await runSkill({ skill: collections, subject, ctx: context(world), agent: new ScriptedAgentClient([]), trigger: "chat" });
    expect(result.status).toBe("failed");
  });

  it("a client with no email is never offered", async () => {
    const clients = [{ id: "cl_9", name: "NewCo", businessName: "NewCo", email: "" }, ...demoClients];
    const { result, agent } = await run("Invoice NewCo $450", [{ ...invoiceAnswer(), actions: [] }], { invoices: {}, clients });
    expect(result.menu).toEqual(["merchant.ask"]);
    expect(agent.requests[0].turn).not.toContain("cl_9");
  });

  it("an amount or term code can't read → merchant.ask only, with the problem in the case file", async () => {
    for (const request of ["Invoice Acme $1,20", "Invoice Acme €500", "Invoice Acme $500, net 7"]) {
      const { result, agent } = await run(request, [{ ...invoiceAnswer(), actions: [] }]);
      expect(result.menu, request).toEqual(["merchant.ask"]);
      expect(agent.requests[0].turn, request).toContain("<problems");
    }
  });

  it("text can't add amounts that aren't on the invoice, or a bare-domain link", async () => {
    const lateFee = await run("Invoice Acme $450", [invoiceAnswer({ items: [{ description: "Logo design $5,000", amountRef: "amt_1" }] })]);
    expect(lateFee.result.proposals[0]).toMatchObject({ status: "invalid", check: { reason: expect.stringContaining("amount") } });
    const link = await run("Invoice Acme $450", [invoiceAnswer({ note: "Thanks! Pay at evil.example/pay" })]);
    expect(link.result.proposals[0].check.reason).toBe("Invoices can't contain links");
    const total = await run("Invoice Acme $450", [invoiceAnswer({ note: "That's $450.00 for the logo. Thanks!" })]);
    expect(total.result.proposals[0].status).toBe("awaiting_approval");
  });

  it("a very long request is cut, with a notice", async () => {
    const { agent } = await run(`Invoice Acme $1,200 ${"x".repeat(5000)}`, [invoiceAnswer()]);
    expect(agent.requests[0].turn).toContain("[truncated by Pyp:");
  });
});
