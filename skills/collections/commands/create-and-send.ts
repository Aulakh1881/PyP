// invoice.createAndSend (Appendix B.1a, C). The model only picks a known
// client, which parsed amounts go on which line, and the terms, and writes the
// wording. Code resolves every value (amounts, due date, recipient). Never
// Auto: it starts from typed chat text, so it is always a tap (design §8.1).
// The executor (owner C) creates the draft, then sends it, with request ids
// "<proposal id>:create" and "<proposal id>:send".

import { z } from "zod";
import { formatMoney, toCents } from "@/engine/format";
import type { CaseFile, CommandDef } from "@/engine/types";
import { fail, ok } from "@/engine/validator";
import type { CollectionsFacts, NewInvoiceFacts } from "../case-file";
import { hasLink, onlyAmounts } from "@/engine/content-checks";
import { centsToDecimal, mentionsClient } from "../request-parser";

export interface CreateAndSendParams {
  clientId: string;
  items: { description: string; amountRef: string }[];
  terms: string;
  note: string;
}

export const createAndSend: CommandDef<CreateAndSendParams, CollectionsFacts> = {
  id: "invoice.createAndSend",
  description: "Create a PayPal invoice for a known client and send it.",
  aiRule:
    "Use when the merchant asked for an invoice for a client marked named-in-request and an amount from <amounts>. Use the terms the merchant named, or the default. Keep the merchant's own words for line descriptions where possible.",
  params: (cf) =>
    z.object({
      clientId: z.enum(cf.ids.clientIds as [string, ...string[]]),
      items: z
        .array(
          z.object({
            description: z.string().max(200).describe("Line description, under 200 characters."),
            amountRef: z.enum(cf.ids.amountIds as [string, ...string[]]),
          }),
        )
        .min(1)
        .max(10),
      terms: z.enum(cf.ids.termIds as [string, ...string[]]),
      note: z.string().max(500).describe("Optional short note to the client, under 500 characters. Can be empty."),
    }),
  available: (cf) =>
    cf.facts.mode === "new-invoice" &&
    cf.facts.mentionedClientIds.length > 0 &&
    cf.facts.amounts.length > 0 &&
    cf.facts.problems.length === 0,
  risk: "message",
  editable: ["note"],

  check: async (p, ctx) => {
    const facts = newInvoiceFacts(ctx.caseFile);
    const client = facts.clients.find((c) => c.id === p.clientId);
    if (!client) return fail("Unknown client");
    if (!mentionsClient(facts.request, client)) {
      return fail(`The request doesn't mention ${client.businessName ?? client.name ?? client.email}`);
    }
    // Fresh read: the client must still be one PayPal knows about.
    const fresh = await ctx.read.recentClients();
    if (!fresh.some((c) => c.email.toLowerCase() === client.email.toLowerCase())) return fail("Client no longer found in PayPal");

    const refs = p.items.map((i) => i.amountRef);
    if (new Set(refs).size !== refs.length) return fail("The same amount is used on two lines");
    if (p.items.some((i) => !i.description.trim())) return fail("Every line needs a description");
    // Text may only repeat amounts that are on the invoice: a line amount or the total.
    const lines = refs.map((r) => toCents(facts.amounts.find((a) => a.id === r)!.value));
    const allowed = [...lines, lines.reduce((s, c) => s + c, 0n)];
    const texts = [...p.items.map((i) => i.description), p.note];
    for (const t of texts) {
      const problem = onlyAmounts(t, allowed);
      if (problem) return fail(problem);
      if (hasLink(t)) return fail("Invoices can't contain links");
    }
    return ok();
  },

  resolve: (p, cf) => {
    const facts = newInvoiceFacts(cf);
    const client = facts.clients.find((c) => c.id === p.clientId)!;
    const term = facts.terms.find((t) => t.id === p.terms)!;
    const currency = facts.currency;
    const items = p.items.map((i) => {
      const amount = facts.amounts.find((a) => a.id === i.amountRef)!;
      return { description: i.description, amount: amount.value, display: amount.display };
    });
    const total = centsToDecimal(items.reduce((sum, i) => sum + toCents(i.amount), 0n));
    return {
      client: { name: client.name, businessName: client.businessName, email: client.email },
      items,
      currency,
      total,
      totalDisplay: formatMoney(total, currency),
      termType: term.type,
      issueDate: facts.issueDate,
      dueDate: term.dueDate,
      note: p.note,
    };
  },
};

function newInvoiceFacts(cf: CaseFile<CollectionsFacts>): NewInvoiceFacts {
  if (cf.facts.mode !== "new-invoice") throw new Error("invoice.createAndSend needs a new-invoice case file");
  return cf.facts;
}
