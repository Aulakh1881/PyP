// DEMO DATA for Insights tests: Maya Ortiz Design's sandbox week, with the
// totals worked by hand in insights.test.ts. Fake PayPal reads.

import type { EngineDb, Invoice, PayPalReads, SkillContext, Transaction } from "@/engine/types";
import { merchant, rules } from "@/skills/collections/evals/fixtures";

export const NOW = new Date("2026-10-30T16:00:00Z"); // Friday 09:00 in Los Angeles
export const subject = { kind: "week", id: "2026-10-30" };

export const txn = (id: string, at: string, amount: string, over: Partial<Transaction> = {}): Transaction => ({
  id,
  at,
  kind: "payment",
  status: "S",
  currency: "USD",
  amount,
  fee: null,
  counterparty: null,
  ...over,
});

export const week: Transaction[] = [
  txn("T1", "2026-10-28T18:00:00Z", "1200.00", { fee: "-35.10", counterparty: "Acme Studio" }),
  txn("T2", "2026-10-29T18:00:00Z", "300.00", { fee: "-9.00", counterparty: "Jordan Kim" }),
  txn("T3", "2026-10-27T18:00:00Z", "-50.00", { kind: "refund" }),
  txn("T4", "2026-10-29T19:00:00Z", "999.00", { status: "P", counterparty: "Pending Co" }), // pending: not counted
  txn("T5", "2026-10-29T20:00:00Z", "100.00", { currency: "EUR", counterparty: "Lisbon Ltd" }), // other currency
  txn("T6", "2026-10-26T20:00:00Z", "-500.00", { kind: "other" }), // a withdrawal isn't a refund
  txn("T7", "2026-10-20T18:00:00Z", "1000.00", { counterparty: "Acme Studio" }), // the week before
];

export const inv = (id: string, amountDue: string, dueDate: string, recipientName: string): Invoice => ({
  id,
  number: id.slice(-4),
  status: "UNPAID",
  currency: "USD",
  total: amountDue,
  amountDue,
  dueDate,
  recipientName,
  recipientEmail: `${recipientName.split(" ")[0].toLowerCase()}@example.com`,
});
export const unpaid = [inv("INV2-0042", "1200.00", "2026-10-21", "Sam Lee"), inv("INV2-0051", "450.00", "2026-11-15", "Jordan Kim")];

export function insightsContext(txns = week, open = unpaid): SkillContext {
  const read: PayPalReads = {
    getInvoice: async () => null,
    recentClients: async () => [],
    transactions: async () => txns,
    unpaidInvoices: async () => open,
  };
  const db: EngineDb = { remindersSent: async () => ({ count: 0, lastSentAt: null }), remindCallsToday: async () => 0, merchantNotes: async () => [] };
  return { merchant, rules: rules(), read, db, now: () => NOW };
}
