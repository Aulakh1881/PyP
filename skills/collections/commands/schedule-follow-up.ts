// invoice.scheduleFollowUp (Appendix C): look at this invoice again in N days.
// Internal only: a queue timer, no PayPal write.

import { z } from "zod";
import type { CommandDef } from "@/engine/types";
import { fail, ok } from "@/engine/validator";
import { REMINDABLE, type CollectionsFacts } from "../case-file";

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
  available: (cf) => cf.facts.mode === "overdue" && REMINDABLE.includes(cf.facts.invoice.status),
  risk: "internal",
  check: async (p, ctx) => {
    const inv = await ctx.read.getInvoice(p.invoiceId);
    if (!inv) return fail("Invoice not found in PayPal");
    if (!REMINDABLE.includes(inv.status)) return fail(`Invoice is ${inv.status}, nothing to follow up`);
    return ok();
  },
};
