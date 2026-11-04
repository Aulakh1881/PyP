// invoice.cancel (Appendix C). Never Auto (design §8.1). The executor (owner C)
// calls POST /v2/invoicing/invoices/{id}/cancel with send_to_recipient and the
// reason as the note, taken from `resolved`.
//
// Offered only when cancelling is a real option: the merchant asked for it in
// chat, or every reminder has gone out and the invoice is still unpaid.
// PayPal won't cancel an invoice with a payment on it, so a partly paid one
// never gets the command.

import { z } from "zod";
import { formatMoney, toCents } from "@/engine/format";
import type { CommandDef, Invoice } from "@/engine/types";
import { fail, ok } from "@/engine/validator";
import { reminderLimits, type CollectionsFacts } from "../case-file";
import { hasLink, onlyAmounts } from "@/engine/content-checks";

export interface CancelParams {
  invoiceId: string;
  reason: string;
}

export const CANCELLABLE: Invoice["status"][] = ["SENT", "UNPAID"];

/** No payment on it: PayPal refuses to cancel otherwise. */
function noPayments(inv: Invoice): boolean {
  return toCents(inv.amountDue) === toCents(inv.total);
}

export const cancelInvoice: CommandDef<CancelParams, CollectionsFacts> = {
  id: "invoice.cancel",
  description: "Cancel this unpaid invoice in PayPal. PayPal emails the client your reason.",
  aiRule:
    "Use only when the merchant asked to cancel it, or every reminder has gone out and the merchant should decide whether to write it off. Always pair it with merchant.ask when the merchant didn't ask. The reason is short and polite.",
  params: (cf) =>
    z.object({
      invoiceId: z.enum(cf.ids.invoiceIds as [string, ...string[]]),
      reason: z.string().max(300).describe("Short, polite reason the client will see, under 300 characters."),
    }),
  available: (cf, rules) => {
    if (cf.facts.mode !== "overdue") return false;
    const { invoice, reminders, merchantAsked } = cf.facts;
    if (!CANCELLABLE.includes(invoice.status) || invoice.disputed || !noPayments(invoice)) return false;
    return merchantAsked || reminders.sent >= reminderLimits(rules).maxPerInvoice;
  },
  risk: "message",

  check: async (p, ctx) => {
    const inv = await ctx.read.getInvoice(p.invoiceId);
    if (!inv) return fail("Invoice not found in PayPal");
    if (!CANCELLABLE.includes(inv.status)) return fail(`Invoice is ${inv.status}, can't be cancelled`);
    if (inv.disputed) return fail("Invoice is under dispute");
    if (!noPayments(inv)) return fail("The invoice has a payment on it; PayPal won't cancel it");
    // The card shows the case file's values, so they must still be PayPal's.
    if (ctx.caseFile.facts.mode === "overdue") {
      const seen = ctx.caseFile.facts.invoice;
      if (inv.total !== seen.total || inv.currency !== seen.currency || inv.recipientEmail !== seen.recipientEmail) {
        return fail("The invoice changed since Pyp looked at it");
      }
    }
    if (!p.reason.trim()) return fail("The reason can't be empty");
    const problem = onlyAmounts(p.reason, [toCents(inv.total)]);
    if (problem) return fail(problem);
    if (hasLink(p.reason)) return fail("The reason can't contain links");
    return ok();
  },

  resolve: (p, cf) => {
    if (cf.facts.mode !== "overdue") throw new Error("invoice.cancel needs an overdue case file");
    const { invoice } = cf.facts;
    return {
      invoiceId: invoice.id,
      invoiceNumber: invoice.number,
      recipientName: invoice.recipientName,
      recipientEmail: invoice.recipientEmail,
      totalDisplay: formatMoney(invoice.total, invoice.currency),
      sendToRecipient: true,
      note: p.reason,
    };
  },
};
