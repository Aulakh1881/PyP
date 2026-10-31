// Gathers the facts for one decision about one unpaid invoice (design §7.3,
// Appendix B.1). Code computes every number; the model only reads them.

import { daysBetween, formatMoney, localDate } from "@/engine/format";
import type { CaseFile, Invoice, MerchantRules, SkillContext, SubjectRef } from "@/engine/types";
import { block, tag, textTag } from "@/engine/xml";

export interface CollectionsFacts {
  invoice: Invoice;
  amountDueDisplay: string;
  daysOverdue: number | null;
  reminders: { sent: number; lastSentAt: string | null; daysSinceLast: number | null };
  notes: string[];
}

export const REMINDABLE: Invoice["status"][] = ["SENT", "UNPAID", "PARTIALLY_PAID"];

export const DEFAULT_LIMITS = { maxPerInvoice: 3, minDaysBetween: 3 };

export function reminderLimits(rules: MerchantRules) {
  return { ...DEFAULT_LIMITS, ...rules.commands["invoice.sendReminder"]?.limits };
}

export async function buildCollectionsCaseFile(ctx: SkillContext, subject: SubjectRef): Promise<CaseFile<CollectionsFacts>> {
  if (subject.kind !== "invoice") throw new Error(`Collections can't handle subject kind "${subject.kind}" yet`);
  const now = ctx.now();
  const tz = ctx.merchant.timezone;

  const invoice = await ctx.read.getInvoice(subject.id);
  if (!invoice) throw new Error(`Invoice ${subject.id} not found`);
  const sent = await ctx.db.remindersSent(invoice.id);
  const notes = await ctx.db.merchantNotes(subject);
  // TODO(B): client history (paid count, average days late) computed live from
  // PayPal's invoice search once owner C's read client has searchInvoices.

  const facts: CollectionsFacts = {
    invoice,
    amountDueDisplay: formatMoney(invoice.amountDue, invoice.currency),
    daysOverdue: invoice.dueDate ? daysBetween(invoice.dueDate, now, tz) : null,
    reminders: {
      sent: sent.count,
      lastSentAt: sent.lastSentAt,
      daysSinceLast: sent.lastSentAt ? daysBetween(localDate(new Date(sent.lastSentAt), tz), now, tz) : null,
    },
    notes,
  };
  const limits = reminderLimits(ctx.rules);

  const xml = block("case-file", { skill: "collections", "generated-at": now.toISOString() }, [
    tag("merchant", { name: ctx.merchant.name, currency: ctx.merchant.currency }),
    tag("invoice", {
      id: invoice.id,
      number: invoice.number,
      status: invoice.status,
      total: formatMoney(invoice.total, invoice.currency),
      "amount-due": facts.amountDueDisplay,
      due: invoice.dueDate,
      "days-overdue": facts.daysOverdue,
      "recipient-name": invoice.recipientName,
      "recipient-email": invoice.recipientEmail,
      disputed: invoice.disputed ? "yes" : null,
    }),
    tag("reminders", {
      invoice: invoice.id,
      sent: facts.reminders.sent,
      "last-sent": facts.reminders.lastSentAt ?? "never",
      "days-since-last": facts.reminders.daysSinceLast,
    }),
    notes.length
      ? block(
          "merchant-notes",
          { visibility: "merchant-only" },
          notes.map((n) => textTag("note", {}, n)),
        )
      : "",
    tag("rules", { "max-reminders": limits.maxPerInvoice, "min-days-between": limits.minDaysBetween }),
  ]);

  return {
    skill: "collections",
    subject,
    generatedAt: now.toISOString(),
    xml,
    ids: { invoiceIds: [invoice.id] },
    facts,
  };
}
