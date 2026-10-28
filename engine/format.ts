// Formatting and arithmetic helpers shared by case files and checks.
// Code does the maths so the model never has to (master plan §11).

/** Money as a display string, e.g. ("1200.00", "USD") -> "$1,200.00". Same formatter everywhere. */
export function formatMoney(amount: string, currency: string): string {
  const cents = toCents(amount);
  const sign = cents < 0n ? "-" : "";
  const abs = cents < 0n ? -cents : cents;
  const whole = (abs / 100n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const frac = (abs % 100n).toString().padStart(2, "0");
  const symbol = currency === "USD" ? "$" : "";
  const suffix = currency === "USD" ? "" : ` ${currency}`;
  return `${sign}${symbol}${whole}.${frac}${suffix}`;
}

/** A PayPal decimal string as integer cents. Throws on anything that isn't a plain decimal. */
export function toCents(amount: string): bigint {
  const m = /^(-?)(\d+)(?:\.(\d{1,2}))?$/.exec(amount.trim());
  if (!m) throw new Error(`Not a money amount: ${amount}`);
  const cents = BigInt(m[2]) * 100n + BigInt((m[3] ?? "0").padEnd(2, "0"));
  return m[1] ? -cents : cents;
}

/** Whole days from `from` (YYYY-MM-DD) to `to`, in the merchant's timezone. */
export function daysBetween(from: string, to: Date, timeZone: string): number {
  const today = localDate(to, timeZone);
  const ms = Date.parse(`${today}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`);
  return Math.round(ms / 86_400_000);
}

/** YYYY-MM-DD for an instant in a timezone. */
export function localDate(at: Date, timeZone: string): string {
  return new Intl.DateTimeFormat("en-CA", { timeZone, year: "numeric", month: "2-digit", day: "2-digit" }).format(at);
}

/** "2026-10-21" -> "Oct 21". */
export function shortDate(isoDate: string): string {
  return new Date(`${isoDate}T12:00:00Z`).toLocaleDateString("en-US", { month: "short", day: "numeric", timeZone: "UTC" });
}
