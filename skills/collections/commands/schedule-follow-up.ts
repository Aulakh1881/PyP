// invoice.scheduleFollowUp (Appendix C): look at this invoice again in N days.
// Internal only: a queue timer, no PayPal write.

import { z } from "zod";
import type { CommandDef } from "@/engine/types";
import { fail, ok } from "@/engine/validator";
import { REMINDABLE, reminderLimits, type CollectionsFacts } from "../case-file";

/** Pyp follows up on one invoice at most this many times; after that it's the merchant's call. */
export const MAX_FOLLOW_UPS = 5;

export interface ScheduleFollowUpParams {
  invoiceId: string;
  inDays: number;
}

export const scheduleFollowUp: CommandDef<ScheduleFollowUpParams, CollectionsFacts> = {
  id: "invoice.scheduleFollowUp",
  description: "Check this invoice again in a number of days (1 to 14).",
  aiRule: "Use when nothing should go out now but the invoice still needs watching, for example right after a reminder.",
  params: (cf) =>
    z.object({
      invoiceId: z.enum(cf.ids.invoiceIds as [string, ...string[]]),
      inDays: z.number().int().min(1).max(14),
    }),
  // Once every reminder has gone out, watching again changes nothing: the merchant decides.
  available: (cf, rules) =>
    cf.facts.mode === "overdue" && REMINDABLE.includes(cf.facts.invoice.status) && cf.facts.reminders.sent < reminderLimits(rules).maxPerInvoice,
  risk: "internal",
  check: async (p, ctx) => {
    const inv = await ctx.read.getInvoice(p.invoiceId);
    if (!inv) return fail("Invoice not found in PayPal");
    if (!REMINDABLE.includes(inv.status)) return fail(`Invoice is ${inv.status}, nothing to follow up`);
    // One follow-up at a time, and a cap, so follow-ups can't chain forever.
    const f = ctx.db.followUps ? await ctx.db.followUps(p.invoiceId) : { pending: 0, done: 0 };
    if (f.pending > 0) return fail("A follow-up is already scheduled");
    if (f.done >= MAX_FOLLOW_UPS) return fail(`Pyp has followed up ${f.done} times; it's your call now`);
    return ok();
  },
};
