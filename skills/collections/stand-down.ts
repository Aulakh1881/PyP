// Collections' stand-down (design §0.14, §9.2): an invoice was paid or
// cancelled. One right answer, so plain code and no model call. It re-reads
// the invoice, because events can arrive late or out of order.

import { formatMoney } from "@/engine/format";
import type { CommandId, EventHandler } from "@/engine/types";
import { PAID } from "./case-file";

/** Every Collections command that makes no sense once the invoice is settled. */
export const SETTLED_OBSOLETES: CommandId[] = [
  "invoice.sendReminder",
  "invoice.scheduleFollowUp",
  "invoice.cancel",
  "invoice.suggestAutoReminders",
  "merchant.ask",
];

export const standDown: EventHandler = async (ctx, subject) => {
  if (subject.kind !== "invoice") return { kind: "ignore", reason: `Expected an invoice, got ${subject.kind}` };
  const inv = await ctx.read.getInvoice(subject.id);
  if (!inv) return { kind: "ignore", reason: `Invoice ${subject.id} not found in PayPal` };
  const who = inv.recipientName ?? inv.recipientEmail ?? "The client";

  if (PAID.includes(inv.status)) {
    return {
      kind: "stand_down",
      message: `${who} paid ${formatMoney(inv.total, inv.currency)} on invoice ${inv.number}. Reminders stopped; nothing to do.`,
      obsoleteCommands: SETTLED_OBSOLETES,
      cancelFollowUps: true,
    };
  }
  if (inv.status === "CANCELLED") {
    return {
      kind: "stand_down",
      message: `Invoice ${inv.number} to ${who} was cancelled. Reminders stopped.`,
      obsoleteCommands: SETTLED_OBSOLETES,
      cancelFollowUps: true,
    };
  }
  // The event says paid or cancelled, but PayPal says otherwise right now.
  return { kind: "ignore", reason: `PayPal shows invoice ${inv.number} as ${inv.status}` };
};
