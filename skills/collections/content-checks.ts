// Checks on text the model writes to a client (reminder subject and note,
// invoice lines and note). Code, not the model, decides what money, invoice
// numbers and links may appear: anything else fails the check (Appendix G).

import { toCents } from "@/engine/format";

// Anything that reads as money: "$1,200.00", "€50", "1,200.00 EUR", "300 dollars".
const MONEY = /[$€£]\s?\d[\d,]*(?:\.\d+)?|\b\d[\d,]*(?:\.\d+)?\s?(?:usd|eur|gbp|cad|aud|jpy|dollars?|bucks)\b/giu;

// Links in any form: a URL, "www.", a bare domain ("evil.example/pay") or an email address.
const LINK = /https?:\/\/|www\.|[\p{L}\p{N}-]+\.[a-z]{2,24}\b|\S+@\S+/iu;

/** Every money amount written in `text`, as integer cents, or null for one we can't read. */
export function moneyIn(text: string): (bigint | null)[] {
  return [...text.matchAll(MONEY)].map((m) => {
    const digits = /\d[\d,]*(?:\.\d+)?/.exec(m[0])![0].replace(/,/g, "");
    try {
      return toCents(digits);
    } catch {
      return null;
    }
  });
}

/** Fails if `text` names any amount other than `allowed` (integer cents). */
export function onlyAmounts(text: string, allowed: bigint[]): string | null {
  for (const cents of moneyIn(text)) {
    if (cents === null || !allowed.includes(cents)) return "It mentions an amount that isn't on the invoice";
  }
  return null;
}

export function hasLink(text: string): boolean {
  return LINK.test(text);
}

/** `number` appears as a whole token, so "0042" doesn't match inside "00421". */
export function namesNumber(text: string, number: string): boolean {
  return new RegExp(`(?<![\\p{L}\\p{N}])${escapeRegExp(number)}(?![\\p{L}\\p{N}])`, "u").test(text);
}

// Dates a note may mention: "Oct 21", "October 21st, 2026", "2026-10-21", "10/21/2026".
const DATE =
  /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|sept|oct|nov|dec)[a-z]*\.?\s+\d{1,2}(?:st|nd|rd|th)?(?:,?\s+\d{4})?\b|\b\d{4}-\d{2}-\d{2}\b|\b\d{1,2}\/\d{1,2}(?:\/\d{2,4})?\b/giu;

/**
 * Fails if `text` names an invoice number other than `own`: any token with the
 * same shape (digits for digits) and the same letter prefix. Dates and years are
 * allowed. A number of 1 to 3 bare digits can't be told apart from "14 days",
 * so for those only the exact-number check in the command applies.
 */
export function otherInvoiceNumber(text: string, own: string): string | null {
  if (/^\d{1,3}$/.test(own)) return null;
  const shape = [...own]
    .map((ch) => (/\p{L}/u.test(ch) ? escapeRegExp(ch) : /\d/.test(ch) ? "\\d" : /[-\s]/.test(ch) ? "[-\\s]?" : escapeRegExp(ch)))
    .join("");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${shape}(?![\\p{L}\\p{N}])`, "giu");
  for (const m of text.replace(MONEY, " ").replace(DATE, " ").matchAll(re)) {
    if (sameNumber(m[0], own) || /^(19|20)\d\d$/.test(m[0])) continue;
    return `It names another invoice (${m[0]})`;
  }
  return null;
}

/** "inv-12", "INV 12" and "INV-12" are the same invoice. */
function sameNumber(a: string, b: string): boolean {
  const norm = (s: string) => s.toUpperCase().replace(/[-\s]/g, "");
  return norm(a) === norm(b);
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
