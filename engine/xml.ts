// Tiny XML helpers for case files and prompts. Everything that came from
// outside our code (names, notes, buyer text) passes through esc().

export function esc(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

type AttrValue = string | number | boolean | null | undefined;

/** A self-closing tag, skipping null/undefined attributes: tag("invoice", { id: "X" }). */
export function tag(name: string, attrs: Record<string, AttrValue>): string {
  return `<${name}${attrString(attrs)}/>`;
}

/** A tag with escaped text content. */
export function textTag(name: string, attrs: Record<string, AttrValue>, text: string): string {
  return `<${name}${attrString(attrs)}>${esc(text)}</${name}>`;
}

/** A tag wrapping already-built XML children (not escaped). */
export function block(name: string, attrs: Record<string, AttrValue>, children: string[]): string {
  const inner = children.filter(Boolean).map((c) => indent(c)).join("\n");
  return `<${name}${attrString(attrs)}>\n${inner}\n</${name}>`;
}

/**
 * Text someone outside the business wrote (buyers, another Pyp). Escaped and
 * wrapped so the model treats it as data (design §7.6).
 */
export function untrusted(text: string, maxChars = 4000): string {
  const clipped = text.length > maxChars ? `${text.slice(0, maxChars)} [truncated by Pyp]` : text;
  return `<untrusted-buyer-text>${esc(clipped)}</untrusted-buyer-text>`;
}

function attrString(attrs: Record<string, AttrValue>): string {
  return Object.entries(attrs)
    .filter(([, v]) => v !== null && v !== undefined)
    .map(([k, v]) => ` ${k}="${esc(String(v))}"`)
    .join("");
}

function indent(xml: string): string {
  return xml
    .split("\n")
    .map((line) => `  ${line}`)
    .join("\n");
}
