// invoice.suggestAutoReminders (Appendix C, Could). A card only: it suggests
// the merchant turn on PayPal's own automatic reminders for a client who always
// pays after one nudge. Nothing is written to PayPal; the merchant flips the
// setting in PayPal themselves. Code decides who qualifies (client history).

import { z } from "zod";
import type { CommandDef } from "@/engine/types";
import { fail, ok } from "@/engine/validator";
import { REMINDABLE, type CollectionsFacts } from "../case-file";

export interface SuggestAutoRemindersParams {
  invoiceId: string;
}

export const suggestAutoReminders: CommandDef<SuggestAutoRemindersParams, CollectionsFacts> = {
  id: "invoice.suggestAutoReminders",
  description: "Suggest the merchant turn on PayPal's automatic reminders for this client. A card only; nothing is sent.",
  aiRule: "Consider it when <client-history pays-after-one-nudge=\"yes\">: this client reliably pays after one reminder, so PayPal's own reminders would do the job.",
  params: (cf) => z.object({ invoiceId: z.enum(cf.ids.invoiceIds as [string, ...string[]]) }),
  available: (cf) =>
    cf.facts.mode === "overdue" && REMINDABLE.includes(cf.facts.invoice.status) && cf.facts.history?.paysAfterOneNudge === true,
  risk: "config",
  check: async (p, ctx) => {
    const inv = await ctx.read.getInvoice(p.invoiceId);
    if (!inv) return fail("Invoice not found in PayPal");
    if (!REMINDABLE.includes(inv.status)) return fail(`Invoice is ${inv.status}, nothing to remind`);
    return ok();
  },
  resolve: (_p, cf) => {
    if (cf.facts.mode !== "overdue") throw new Error("invoice.suggestAutoReminders needs an overdue case file");
    const { invoice, history } = cf.facts;
    return {
      invoiceId: invoice.id,
      recipientName: invoice.recipientName,
      recipientEmail: invoice.recipientEmail,
      paidBefore: history?.paid ?? 0,
      avgDaysLate: history?.avgDaysLate ?? null,
    };
  },
};
