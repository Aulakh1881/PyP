// Gathers the facts for one Collections decision (design §7.3, Appendix B.1).
// Two kinds of subject: an existing unpaid invoice ("invoice"), or a request
// from chat to create one ("new-invoice", B.1a). Code computes every number;
// the model only reads them.

import { daysBetween, formatMoney, localDate } from "@/engine/format";
import type { CaseFile, Client, Invoice, MerchantRules, SkillContext, SubjectRef } from "@/engine/types";
import { block, tag, textTag } from "@/engine/xml";
import { truncate } from "@/engine/prompt-builder";
import { addDays, ALL_TERMS, EMAIL, mentionsClient, parseAmounts, parseTerms, type ParsedAmount, type ParsedTerm } from "./request-parser";

export interface OverdueFacts {
  mode: "overdue";
  invoice: Invoice;
  amountDueDisplay: string;
  daysOverdue: number | null;
  reminders: { sent: number; lastSentAt: string | null; daysSinceLast: number | null };
  notes: string[];
}

export interface NewInvoiceFacts {
  mode: "new-invoice";
  request: string;
  currency: string;
  issueDate: string; // YYYY-MM-DD, merchant's timezone
  clients: Client[];
  /** Ids of clients the request names, matched by code. Only these can be invoiced. */
  mentionedClientIds: string[];
  amounts: ParsedAmount[];
  /** The terms the merchant named, or every standard term if they named none. */
  terms: (ParsedTerm & { dueDate: string })[];
  termsNamed: boolean;
  /** What code couldn't read with certainty ("$1,20", "net 7", "€500" for a USD merchant). Any problem means: ask. */
  problems: string[];
}

export type CollectionsFacts = OverdueFacts | NewInvoiceFacts;

export const REMINDABLE: Invoice["status"][] = ["SENT", "UNPAID", "PARTIALLY_PAID"];

export const DEFAULT_LIMITS = { maxPerInvoice: 3, minDaysBetween: 3 };

/** Used when the merchant names no terms. TODO: make this a merchant setting. */
export const DEFAULT_TERMS = "net_30";

/** Clients listed in a new-invoice case file, newest first. */
export const MAX_CLIENTS = 25;

/** Longest chat sentence we put in a case file. */
export const MAX_REQUEST_CHARS = 1000;

export function reminderLimits(rules: MerchantRules) {
  return { ...DEFAULT_LIMITS, ...rules.commands["invoice.sendReminder"]?.limits };
}

export async function buildCollectionsCaseFile(
  ctx: SkillContext,
  subject: SubjectRef,
  instruction?: string,
): Promise<CaseFile<CollectionsFacts>> {
  if (subject.kind === "invoice") return overdueCaseFile(ctx, subject);
  if (subject.kind === "new-invoice") {
    if (!instruction?.trim()) throw new Error("A new-invoice run needs the merchant's request");
    return newInvoiceCaseFile(ctx, subject, instruction);
  }
  throw new Error(`Collections can't handle subject kind "${subject.kind}"`);
}

async function overdueCaseFile(ctx: SkillContext, subject: SubjectRef): Promise<CaseFile<CollectionsFacts>> {
  const now = ctx.now();
  const tz = ctx.merchant.timezone;

  const invoice = await ctx.read.getInvoice(subject.id);
  if (!invoice) throw new Error(`Invoice ${subject.id} not found`);
  const sent = await ctx.db.remindersSent(invoice.id);
  const notes = await ctx.db.merchantNotes(subject);
  // TODO(B): client history (paid count, average days late) computed live from
  // PayPal's invoice search once owner C's read client has searchInvoices.

  const facts: OverdueFacts = {
    mode: "overdue",
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

  const xml = block("case-file", { skill: "collections", mode: "overdue", "generated-at": now.toISOString() }, [
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
      // Code counts, so the model doesn't have to: "3 of 3" means the next one is the last.
      "next-reminder": facts.reminders.sent < limits.maxPerInvoice ? `${facts.reminders.sent + 1} of ${limits.maxPerInvoice}` : null,
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

async function newInvoiceCaseFile(ctx: SkillContext, subject: SubjectRef, instruction: string): Promise<CaseFile<CollectionsFacts>> {
  const now = ctx.now();
  const request = truncate(instruction, MAX_REQUEST_CHARS);
  const issueDate = localDate(now, ctx.merchant.timezone);
  // A client without a usable email can't be invoiced, so it never reaches the menu.
  const clients = (await ctx.read.recentClients()).filter((c) => EMAIL.test(c.email)).slice(0, MAX_CLIENTS);
  const { amounts, problems: amountProblems } = parseAmounts(request, ctx.merchant.currency);
  const { terms: named, problems: termProblems } = parseTerms(request);
  const problems = [...amountProblems, ...termProblems];
  const terms = (named.length ? named : ALL_TERMS).map((t) => ({ ...t, dueDate: addDays(issueDate, t.days) }));
  const mentionedClientIds = clients.filter((c) => mentionsClient(request, c)).map((c) => c.id);

  const facts: NewInvoiceFacts = {
    mode: "new-invoice",
    request,
    currency: ctx.merchant.currency,
    issueDate,
    clients,
    mentionedClientIds,
    amounts,
    terms,
    termsNamed: named.length > 0,
    problems,
  };

  const xml = block("case-file", { skill: "collections", mode: "new-invoice", "generated-at": now.toISOString() }, [
    tag("merchant", { name: ctx.merchant.name, currency: ctx.merchant.currency }),
    // The merchant's own words: trusted, but escaped like everything else.
    textTag("merchant-request", {}, request),
    clients.length
      ? block(
          "known-clients",
          { source: "recent PayPal invoices" },
          clients.map((c) =>
            tag("client", {
              id: c.id,
              name: c.name,
              business: c.businessName,
              email: c.email,
              "named-in-request": mentionedClientIds.includes(c.id) ? "yes" : null,
            }),
          ),
        )
      : tag("known-clients", { count: 0 }),
    amounts.length
      ? block(
          "amounts",
          { source: "parsed from the request by code" },
          amounts.map((a) => tag("amount", { id: a.id, value: a.display, "written-as": a.writtenAs })),
        )
      : tag("amounts", { count: 0, note: "no amount found in the request" }),
    block(
      "terms",
      { source: named.length ? "named in the request" : "none named; standard options" },
      terms.map((t) =>
        tag("term", { id: t.id, paypal: t.type, "due-date": t.dueDate, default: !named.length && t.id === DEFAULT_TERMS ? "yes" : null }),
      ),
    ),
    tag("issue-date", { value: issueDate }),
    problems.length ? block("problems", { source: "code; ask the merchant about these" }, problems.map((x) => textTag("problem", {}, x))) : "",
  ]);

  return {
    skill: "collections",
    subject,
    generatedAt: now.toISOString(),
    xml,
    // Only clients the request names can be invoiced (code decides, not the model).
    ids: { clientIds: mentionedClientIds, amountIds: amounts.map((a) => a.id), termIds: terms.map((t) => t.id) },
    facts,
    includesInstruction: true,
  };
}
