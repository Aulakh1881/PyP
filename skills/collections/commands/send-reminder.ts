// invoice.sendReminder (Appendix C). The executor (owner C) calls
// POST /v2/invoicing/invoices/{id}/remind with the subject and note.

import { z } from "zod";
import { daysBetween, formatMoney, localDate, toCents } from "@/engine/format";
import type { CommandDef } from "@/engine/types";
import { fail, ok } from "@/engine/validator";
import { REMINDABLE, reminderLimits, type CollectionsFacts } from "../case-file";
import { hasLink, namesNumber, onlyAmounts, otherInvoiceNumber } from "../content-checks";

export interface SendReminderParams {
  invoiceId: string;
  tone: "friendly" | "firm" | "final";
  subject: string;
  note: string;
}

/** PayPal: "API caller can send only 2 reminders in a day." */
export const PAYPAL_REMINDS_PER_DAY = 2;

export const sendReminder: CommandDef<SendReminderParams, CollectionsFacts> = {
  id: "invoice.sendReminder",
  description: "Send PayPal's reminder email for this unpaid invoice, with your subject line and note.",
  aiRule:
    "Use when the invoice is overdue and the minimum gap since the last reminder has passed. Reminder 1 friendly, 2 firm and specific, 3 final. The note must state the amount due and the invoice number exactly as the case file shows them.",
  params: (cf) =>
    z.object({
      invoiceId: z.enum(cf.ids.invoiceIds as [string, ...string[]]),
      tone: z.enum(["friendly", "firm", "final"]),
      subject: z.string().max(120).describe("Email subject, under 120 characters."),
      note: z.string().max(500).describe("The message to the client, under 500 characters. States the amount due and invoice number exactly."),
    }),
  available: (cf, rules) => {
    if (cf.facts.mode !== "overdue") return false;
    const { invoice, daysOverdue, reminders } = cf.facts;
    const limits = reminderLimits(rules);
    return (
      REMINDABLE.includes(invoice.status) &&
      !invoice.disputed &&
      (daysOverdue ?? 0) > 0 &&
      reminders.sent < limits.maxPerInvoice &&
      (reminders.daysSinceLast === null || reminders.daysSinceLast >= limits.minDaysBetween)
    );
  },
  state: (cf, rules) =>
    cf.facts.mode === "overdue"
      ? `sent=${cf.facts.reminders.sent} of max ${reminderLimits(rules).maxPerInvoice}; last=${cf.facts.reminders.lastSentAt ?? "never"}`
      : undefined,
  risk: "message",

  check: async (p, ctx) => {
    const inv = await ctx.read.getInvoice(p.invoiceId); // fresh, not from the case file
    if (!inv) return fail("Invoice not found in PayPal");
    if (!REMINDABLE.includes(inv.status)) return fail(`Invoice is ${inv.status}, no longer unpaid`);
    if (inv.disputed) return fail("Invoice is under dispute");

    const limits = reminderLimits(ctx.rules);
    const sent = await ctx.db.remindersSent(p.invoiceId);
    if (sent.count >= limits.maxPerInvoice) return fail(`Already sent ${sent.count} reminders`);
    if (sent.lastSentAt) {
      const days = daysBetween(localDate(new Date(sent.lastSentAt), ctx.merchant.timezone), ctx.now(), ctx.merchant.timezone);
      if (days < limits.minDaysBetween) return fail("Reminded too recently");
    }

    if (!p.subject.trim() || !p.note.trim()) return fail("Subject and note can't be empty");
    const amount = formatMoney(inv.amountDue, inv.currency);
    if (!p.note.includes(amount)) return fail(`The note doesn't state the amount due (${amount})`);
    if (!namesNumber(p.note, inv.number)) return fail(`The note doesn't name invoice ${inv.number}`);
    // Nothing else may creep in: no other amounts (a "late fee"), invoices or links.
    const text = `${p.subject}\n${p.note}`;
    const problem = onlyAmounts(text, [toCents(inv.amountDue), toCents(inv.total)]) ?? otherInvoiceNumber(text, inv.number);
    if (problem) return fail(problem);
    if (hasLink(text)) return fail("Reminders can't contain links");
    return ok();
  },

  // What the card shows and the executor sends: code's values, not the model's text.
  resolve: (p, cf) => {
    if (cf.facts.mode !== "overdue") throw new Error("invoice.sendReminder needs an overdue case file");
    const { invoice, amountDueDisplay, reminders } = cf.facts;
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      recipientName: invoice.recipientName,
      recipientEmail: invoice.recipientEmail,
      amountDueDisplay,
      reminderNumber: reminders.sent + 1,
      tone: p.tone,
      subject: p.subject,
      note: p.note,
    };
  },

  overLimit: async (p, _rule, ctx) => {
    if (p.tone === "final") return "Final reminders always need your approval";
    // Don't trust the tone label alone: the last allowed reminder always asks.
    const sent = await ctx.db.remindersSent(p.invoiceId);
    if (sent.count + 1 >= reminderLimits(ctx.rules).maxPerInvoice) return "The last reminder always needs your approval";
    if ((await ctx.db.remindCallsToday(ctx.merchant.id)) >= PAYPAL_REMINDS_PER_DAY) {
      return `PayPal allows only ${PAYPAL_REMINDS_PER_DAY} reminders a day`;
    }
    return null;
  },
};
