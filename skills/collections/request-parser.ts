// Pulls money amounts and payment terms out of a merchant's chat sentence
// (design B.1a step 2). Plain code, no model: the model may only pick among
// what this finds, by id.

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

// "$1,200", "$1200.50", "$ 450", "$1.2k"
const DOLLAR_PREFIX = /\$\s?((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(\s?k\b)?/gi;
// "1200 USD", "1,200 dollars", "1.2k usd"
const WORD_SUFFIX = /\b((?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d{1,2})?)(\s?k)?\s?(?:usd|dollars?|bucks)\b/gi;

export function parseAmounts(text: string, currency: string): ParsedAmount[] {
  const found: { index: number; end: number; cents: bigint; writtenAs: string }[] = [];
  for (const re of [DOLLAR_PREFIX, WORD_SUFFIX]) {
    for (const m of text.matchAll(re)) {
      const index = m.index ?? 0;
      const end = index + m[0].length;
      if (found.some((f) => index < f.end && end > f.index)) continue; // "$1,200 USD" matches both patterns
      let cents = toCents(m[1].replace(/,/g, ""));
      if (m[2]) cents *= 1000n;
      if (cents <= 0n) continue;
      found.push({ index, end, cents, writtenAs: m[0].trim() });
    }
  }
  return found
    .sort((a, b) => a.index - b.index)
    .map((f, i) => {
      const value = centsToDecimal(f.cents);
      return { id: `amt_${i + 1}`, value, display: formatMoney(value, currency), writtenAs: f.writtenAs };
    });
}

export function parseTerms(text: string): ParsedTerm[] {
  const out = new Map<string, ParsedTerm>();
  if (/\b(?:due\s+)?(?:on|upon)\s+receipt\b/i.test(text)) out.set("due_on_receipt", ALL_TERMS[0]);
  for (const m of text.matchAll(/\b(?:net[\s-]?(\d{2})|due\s+in\s+(\d{2})\s+days)\b/gi)) {
    const term = ALL_TERMS.find((t) => t.days === Number(m[1] ?? m[2]) && t.days > 0);
    if (term) out.set(term.id, term);
  }
  return [...out.values()];
}

/** YYYY-MM-DD plus whole days. */
export function addDays(isoDate: string, days: number): string {
  const d = new Date(`${isoDate}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

const GENERIC = new Set(["the", "and", "inc", "llc", "ltd", "co", "corp", "company", "studio", "studios", "design", "group", "shop", "store"]);

/** Did the merchant's sentence name this client (by name, business or email)? */
export function mentionsClient(text: string, client: Client): boolean {
  const lower = text.toLowerCase();
  if (lower.includes(client.email.toLowerCase())) return true;
  const words = `${client.name ?? ""} ${client.businessName ?? ""}`
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length >= 3 && !GENERIC.has(w));
  return words.some((w) => new RegExp(`\\b${w}\\b`).test(lower));
}

export function centsToDecimal(cents: bigint): string {
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  return `${sign}${abs / 100n}.${(abs % 100n).toString().padStart(2, "0")}`;
}
