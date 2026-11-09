// Pulls money amounts and payment terms out of a merchant's chat sentence
// (design B.1a step 2). Plain code, no model: the model may only pick among
// what this finds, by id. Anything it can't read with certainty becomes a
// problem, and a request with problems can only be answered with a question.

import { formatMoney, toCents } from "@/engine/format";
import type { Client } from "@/engine/types";

export interface ParsedAmount {
  id: string; // amt_1, amt_2, ...
  value: string; // "1200.00", a PayPal decimal string
  display: string; // "$1,200.00"
  writtenAs: string; // what the merchant typed, e.g. "$1.2k"
}

/** PayPal's payment_term_type values we offer. */
export type TermType = "DUE_ON_RECEIPT" | "NET_10" | "NET_15" | "NET_30" | "NET_45" | "NET_60" | "NET_90";

export interface ParsedTerm {
  id: string; // due_on_receipt, net_30, ...
  type: TermType;
  days: number;
}

export const ALL_TERMS: ParsedTerm[] = [
  { id: "due_on_receipt", type: "DUE_ON_RECEIPT", days: 0 },
  ...[10, 15, 30, 45, 60, 90].map((d) => ({ id: `net_${d}`, type: `NET_${d}` as TermType, days: d })),
];

/** Larger amounts are almost certainly a typo; ask instead. */
export const MAX_AMOUNT_CENTS = 100_000_000n; // 1,000,000.00

const NUMBER = String.raw`(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?`;
// "$1,200", "€450.50", "$ 450", "$1.2k"
const SYMBOL_PREFIX = new RegExp(String.raw`([$€£])\s?(${NUMBER})(\s?k\b)?`, "gi");
// "1200 USD", "1,200 dollars", "1.2k eur"
const WORD_SUFFIX = new RegExp(String.raw`\b(${NUMBER})(\s?k)?\s?(usd|eur|gbp|cad|aud|dollars?|bucks)\b`, "gi");

const SYMBOLS: Record<string, string> = { "€": "EUR", "£": "GBP" };
/** Currencies a bare "$" or "dollars" can mean: the merchant's own if it's a dollar, else USD. */
const DOLLAR_CURRENCIES = ["USD", "CAD", "AUD", "NZD", "SGD", "HKD"];

export interface AmountParse {
  amounts: ParsedAmount[];
  /** Things the merchant typed that look like money but can't be used as is. */
  problems: string[];
}

export function parseAmounts(text: string, currency: string): AmountParse {
  const found: { index: number; end: number; cents: bigint; writtenAs: string }[] = [];
  const problems: string[] = [];
  const dollar = DOLLAR_CURRENCIES.includes(currency) ? currency : "USD";

  const scan = (re: RegExp, numberAt: number, kAt: number, unitAt: number) => {
    for (const m of text.matchAll(re)) {
      const index = m.index ?? 0;
      const end = index + m[0].length;
      if (found.some((f) => index < f.end && end > f.index)) continue; // "$1,200 USD" matches both patterns
      const writtenAs = m[0].trim();
      const before = text.slice(0, index);
      const after = text.slice(end);
      // "$1,20", "$1.2.3", "$1200.999", "$1,2000", "1,20 dollars": the number goes on past what we read.
      if (/^[.,]?\d/.test(after) || /[\d.,]$/.test(before)) {
        problems.push(`I couldn't read "${writtenAs}${/^[\d.,]+/.exec(after)?.[0] ?? ""}" as an amount`);
        continue;
      }
      if (/-\s?$/.test(before)) {
        problems.push(`"-${writtenAs}" is negative; invoices can't have negative amounts`);
        continue;
      }
      const unit = m[unitAt].toLowerCase();
      const unitCurrency = SYMBOLS[unit] ?? (["$", "dollar", "dollars", "bucks"].includes(unit) ? dollar : unit.toUpperCase());
      if (unitCurrency !== currency) {
        problems.push(`"${writtenAs}" is in ${unitCurrency}, but your invoices are in ${currency}`);
        continue;
      }
      let cents = toCents(m[numberAt].replace(/,/g, ""));
      if (m[kAt]) cents *= 1000n;
      if (cents <= 0n) continue;
      if (cents > MAX_AMOUNT_CENTS) {
        problems.push(`"${writtenAs}" is larger than Pyp will invoice in one line`);
        continue;
      }
      found.push({ index, end, cents, writtenAs });
    }
  };
  scan(SYMBOL_PREFIX, 2, 3, 1);
  scan(WORD_SUFFIX, 1, 2, 3);

  const amounts = found
    .sort((a, b) => a.index - b.index)
    .map((f, i) => {
      const value = centsToDecimal(f.cents);
      return { id: `amt_${i + 1}`, value, display: formatMoney(value, currency), writtenAs: f.writtenAs };
    });
  return { amounts, problems };
}

export interface TermsParse {
  terms: ParsedTerm[];
  /** Terms the merchant named that PayPal's standard terms don't cover. */
  problems: string[];
}

export function parseTerms(text: string): TermsParse {
  const out = new Map<string, ParsedTerm>();
  const problems: string[] = [];
  if (/\b(?:due\s+)?(?:on|upon)\s+receipt\b/i.test(text)) out.set("due_on_receipt", ALL_TERMS[0]);
  for (const m of text.matchAll(/\b(?:net[\s-]?(\d{1,3})|(?:due|payable)\s+(?:in|within)\s+(\d{1,3})\s+days)\b/gi)) {
    const days = Number(m[1] ?? m[2]);
    const term = ALL_TERMS.find((t) => t.days === days && t.days > 0);
    if (term) out.set(term.id, term);
    else problems.push(`"${m[0]}" isn't one of PayPal's standard terms (due on receipt, or net 10, 15, 30, 45, 60 or 90)`);
  }
  return { terms: [...out.values()], problems };
}

/** YYYY-MM-DD plus whole days. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

/** Words that don't identify a business on their own ("Acme Studio" is matched by "acme"). */
const GENERIC = new Set(["the", "and", "inc", "llc", "ltd", "co", "corp", "company", "studio", "studios", "design", "group", "shop", "store"]);

/** A plausible email address. Clients without one can't be invoiced. */
export const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * Did the merchant's sentence name this client? By the full email, every
 * distinctive word of the business name, or the person's full name. A single
 * shared word isn't enough: "Bill Acme" must not match a client called Bill Jones.
 */
export function mentionsClient(text: string, client: Client): boolean {
  if (!EMAIL.test(client.email)) return false;
  const lower = text.toLowerCase();
  if (new RegExp(`(?<![\\w.+-])${escapeRegExp(client.email.toLowerCase())}(?![\\w-]|\\.\\w)`, "u").test(lower)) return true;
  // Emails are matched whole above; their parts ("acme" in "notsam@acme.example.org") don't count as words.
  const words = new Set(tokens(lower.replace(/\S+@\S+/g, " ")));
  const business = tokens(client.businessName ?? "");
  const distinctive = business.filter((w) => !GENERIC.has(w));
  const matchesAll = (ws: string[]) => ws.length > 0 && ws.every((w) => words.has(w));
  return (
    matchesAll(distinctive.length ? distinctive : business) ||
    matchesAll(tokens(client.name ?? "")) ||
    (client.nicknames ?? []).some((n) => matchesAll(tokens(n)))
  );
}

/**
 * Words that never pick a client on their own: request words ("bill", "net", "due")
 * and generic ones. "Bill NewCo" must not reach a client called Bill Jones.
 */
const NOT_A_NAME = new Set([
  ...GENERIC,
  ...["bill", "invoice", "charge", "send", "chase", "remind", "pay", "payable", "net", "due", "receipt", "upon", "on", "within", "days"],
  ...["for", "to", "a", "an", "of", "my", "new", "client", "customer", "test", "please", "can", "you"],
]);

/**
 * The clients a sentence names. A full match (mentionsClient) wins. Without one,
 * a single word that belongs to exactly one client's name, business or nickname
 * counts ("Pyp" is PyP Test); if it fits two clients, it names neither and
 * the model asks which.
 */
export function clientsNamed(text: string, clients: Client[]): string[] {
  const full = clients.filter((c) => mentionsClient(text, c)).map((c) => c.id);
  if (full.length) return full;
  const words = new Set(tokens(text.replace(/\S+@\S+/g, " ")).filter((w) => w.length >= 2 && !NOT_A_NAME.has(w)));
  const partial = clients.filter((c) => {
    if (!EMAIL.test(c.email)) return false;
    const own = [c.name, c.businessName, ...(c.nicknames ?? [])].flatMap((n) => tokens(n ?? ""));
    return own.some((w) => words.has(w));
  });
  return partial.length === 1 ? [partial[0].id] : [];
}

/** Lowercase words, Unicode-aware, so "Ramírez" is one word, not "ram" and "rez". */
function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

export function centsToDecimal(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}
