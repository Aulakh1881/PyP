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

/**
 * Fails if `text` names an invoice number other than `own`: any token with the
 * same shape (digits for digits, letters for letters). Years are allowed.
 */
export function otherInvoiceNumber(text: string, own: string): string | null {
  const shape = [...own]
    .map((ch) => (/\p{L}/u.test(ch) ? "\\p{L}" : /\d/.test(ch) ? "\\d" : /[-\s]/.test(ch) ? "[-\\s]?" : escapeRegExp(ch)))
    .join("");
  const re = new RegExp(`(?<![\\p{L}\\p{N}])${shape}(?![\\p{L}\\p{N}])`, "gu");
  for (const m of text.replace(MONEY, " ").matchAll(re)) {
    if (m[0] !== own && !/^(19|20)\d\d$/.test(m[0])) return `It names another invoice (${m[0]})`;
  }
  return null;
}

function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
