// Gathers the facts for one weekly brief (design Appendix B.3). Code works out
// every number (money in, fees, refunds, what's owed, who's late, the change on
// last week) in integer cents; the model only words them, and its check makes
// sure every number it writes is one of these.
//
// The week is the 7 days up to the run, so the Friday brief covers Friday to
// Friday, and the previous 7 days are the comparison.

import { formatMoney, localDate, shortDate, toCents, minorDigits } from "@/engine/format";
import type { CaseFile, GatherContext, Invoice, SubjectRef, Transaction } from "@/engine/types";
import { block, tag, textTag } from "@/engine/xml";

export const WINDOW_DAYS = 7;
/** Top clients and late payers listed, each. */
export const TOP_N = 3;
/** Longest payer name we put in a case file (it's buyer-controlled text). */
const MAX_NAME = 60;

export interface Metric {
  id: string;
  label: string;
  /** Exactly how the text must write it: "$1,200.00", "3", "+12%". */
  display: string;
}

export interface InsightsFacts {
  currency: string;
  from: string; // YYYY-MM-DD, merchant-local
  to: string;
  metrics: Metric[];
  /** Nothing came in and nothing is owed: say it was quiet. */
  quiet: boolean;
  /** Currencies we saw but didn't total (the brief is in the merchant's currency). */
  otherCurrencies: string[];
  /** Every number the text may contain, as written ("1,200.00", "12", "31"). */
  allowedNumbers: string[];
}

/** Integer cents → a PayPal decimal string ("120000" → "1200.00"). */
export function centsToAmount(cents: bigint, currency: string): string {
  const digits = minorDigits(currency) === 0 ? 0 : 2;
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  return digits ? `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}` : `${sign}${abs / 100n}`;
}

const abs = (c: bigint) => (c < 0n ? -c : c);
const NUMBER = /\d[\d,]*(?:\.\d+)?/g;

export function numbersIn(text: string): string[] {
  return [...text.matchAll(NUMBER)].map((m) => m[0].replace(/[.,]$/, ""));
}

export async function buildInsightsCaseFile(ctx: GatherContext, subject: SubjectRef): Promise<CaseFile<InsightsFacts>> {
  if (subject.kind !== "week") throw new Error(`Insights can't handle subject kind "${subject.kind}"`);
  if (!ctx.read.transactions || !ctx.read.unpaidInvoices) throw new Error("PayPal reads don't include transactions and unpaid invoices");
  const now = ctx.now();
  const tz = ctx.merchant.timezone;
  const currency = ctx.merchant.currency;
  const start = new Date(now.getTime() - WINDOW_DAYS * 86_400_000);
  const prevStart = new Date(start.getTime() - WINDOW_DAYS * 86_400_000);

  const [txns, unpaid] = await Promise.all([ctx.read.transactions(prevStart, now), ctx.read.unpaidInvoices()]);
  const ok = txns.filter((t) => t.status === "S");
  const otherCurrencies = [...new Set(ok.filter((t) => t.currency !== currency).map((t) => t.currency))].sort();
  const mine = ok.filter((t) => t.currency === currency);
  const thisWeek = mine.filter((t) => Date.parse(t.at) >= start.getTime());
  const lastWeek = mine.filter((t) => Date.parse(t.at) < start.getTime());

  const paymentsIn = (ts: Transaction[]) => ts.filter((t) => t.kind === "payment" && toCents(t.amount) > 0n);
  const sum = (cs: bigint[]) => cs.reduce((a, b) => a + b, 0n);
  const payments = paymentsIn(thisWeek);
  const moneyIn = sum(payments.map((t) => toCents(t.amount)));
  const prevIn = sum(paymentsIn(lastWeek).map((t) => toCents(t.amount)));
  const fees = sum(payments.map((t) => (t.fee ? abs(toCents(t.fee)) : 0n)));
  const refunds = sum(thisWeek.filter((t) => t.kind === "refund").map((t) => abs(toCents(t.amount))));
  const net = moneyIn - fees - refunds;

  const owedInvoices = unpaid.filter((i) => i.currency === currency);
  const today = localDate(now, tz);
  const overdue = owedInvoices.filter((i) => i.dueDate && i.dueDate < today);
  const owed = sum(owedInvoices.map((i) => toCents(i.amountDue)));
  const overdueTotal = sum(overdue.map((i) => toCents(i.amountDue)));

  const money = (c: bigint) => formatMoney(centsToAmount(c, currency), currency);
  const metrics: Metric[] = [
    { id: "m_in", label: "Money in this week", display: money(moneyIn) },
    { id: "m_payments", label: "Payments this week", display: String(payments.length) },
    { id: "m_fees", label: "PayPal fees this week", display: money(fees) },
    { id: "m_refunds", label: "Refunds this week", display: money(refunds) },
    { id: "m_net", label: "Net this week", display: money(net) },
    { id: "m_in_prev", label: "Money in the week before", display: money(prevIn) },
  ];
  if (prevIn > 0n) {
    const pct = Math.round((Number(moneyIn - prevIn) / Number(prevIn)) * 100);
    metrics.push({ id: "m_change", label: "Change on the week before", display: `${pct >= 0 ? "+" : ""}${pct}%` });
  }
  metrics.push(
    { id: "m_owed", label: "Owed to you now", display: money(owed) },
    { id: "m_owed_count", label: "Unpaid invoices", display: String(owedInvoices.length) },
    { id: "m_overdue", label: "Overdue now", display: money(overdueTotal) },
    { id: "m_overdue_count", label: "Overdue invoices", display: String(overdue.length) },
  );

  // Who paid most this week, and who owes the most overdue: grouped by name in code.
  const byName = (rows: { name: string; cents: bigint }[]) => {
    const totals = new Map<string, bigint>();
    for (const r of rows) totals.set(r.name, (totals.get(r.name) ?? 0n) + r.cents);
    return [...totals.entries()].sort((a, b) => (b[1] > a[1] ? 1 : b[1] < a[1] ? -1 : a[0].localeCompare(b[0]))).slice(0, TOP_N);
  };
  const clean = (s: string | null) => (s ?? "Unknown").replace(/\s+/g, " ").trim().slice(0, MAX_NAME);
  byName(payments.map((t) => ({ name: clean(t.counterparty), cents: toCents(t.amount) }))).forEach(([name, cents], i) =>
    metrics.push({ id: `client_${i + 1}`, label: `Top client ${i + 1}: ${name}`, display: money(cents) }),
  );
  byName(overdue.map((inv: Invoice) => ({ name: clean(inv.recipientName ?? inv.recipientEmail), cents: toCents(inv.amountDue) }))).forEach(([name, cents], i) =>
    metrics.push({ id: `late_${i + 1}`, label: `Late payer ${i + 1}: ${name}`, display: money(cents) }),
  );

  const from = localDate(start, tz);
  const quiet = payments.length === 0 && owedInvoices.length === 0;
  const dates = [shortDate(from), shortDate(today)];
  const allowedNumbers = [...new Set([...metrics, ...dates.map((d) => ({ display: d }))].flatMap((m) => numbersIn(m.display)).concat([String(WINDOW_DAYS)]))];

  const facts: InsightsFacts = { currency, from, to: today, metrics, quiet, otherCurrencies, allowedNumbers };
  const xml = block("case-file", { skill: "insights", "generated-at": now.toISOString() }, [
    tag("merchant", { name: ctx.merchant.name, currency }),
    tag("week", { from: dates[0], to: dates[1], days: WINDOW_DAYS, quiet: quiet ? "yes" : null }),
    block(
      "metrics",
      { source: "computed in code from PayPal; copy values exactly as written" },
      metrics.map((m) => tag("metric", { id: m.id, label: m.label, value: m.display })),
    ),
    otherCurrencies.length ? textTag("note", {}, `Payments in ${otherCurrencies.join(", ")} aren't in these totals.`) : "",
  ]);

  return {
    skill: "insights",
    subject,
    generatedAt: now.toISOString(),
    xml,
    ids: { metricIds: metrics.map((m) => m.id) },
    facts,
  };
}
