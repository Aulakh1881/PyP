// Shared Gate 2 helpers for dispute commands: a fresh read of the dispute,
// and the outbound text rules (no links, no amounts but the allowed ones).

import { hasLink, onlyAmounts } from "@/engine/content-checks";
import type { CheckContext, CheckResult, CommandRule, Dispute } from "@/engine/types";
import { fail } from "@/engine/validator";
import { AWAITING_SELLER, type DisputeFacts } from "./case-file";

/** Re-read the dispute. Returns it, or the failed check to return. */
export async function freshDispute(
  ctx: CheckContext<DisputeFacts>,
  id: string,
  states: Dispute["status"][] = AWAITING_SELLER,
): Promise<{ dispute: Dispute } | { failed: CheckResult }> {
  if (!ctx.read.getDispute) return { failed: fail("PayPal reads don't include getDispute") };
  const d = await ctx.read.getDispute(id);
  if (!d) return { failed: fail("Dispute not found in PayPal") };
  if (!states.includes(d.status)) return { failed: fail(`Dispute is ${d.status}, not waiting on you`) };
  if (d.sellerResponseDueDate && Date.parse(d.sellerResponseDueDate) < ctx.now().getTime()) {
    return { failed: fail("The response deadline has passed") };
  }
  // The card shows the case file's amount, so it must still be PayPal's.
  const seen = ctx.caseFile.facts.dispute;
  if (d.amount !== seen.amount || d.currency !== seen.currency) return { failed: fail("The dispute changed since Pyp looked at it") };
  return { dispute: d };
}

/** Outbound text to a buyer: no links, and no amount except `allowed` (integer cents). */
export function textProblem(text: string, allowed: bigint[]): string | null {
  if (!text.trim()) return "The text can't be empty";
  if (hasLink(text)) return "Messages to the buyer can't contain links";
  return onlyAmounts(text, allowed);
}

/** Policy: anything after suspicious buyer text waits for the merchant, whatever the dial. */
export async function suspiciousLimit(
  _p: unknown,
  _rule: CommandRule,
  ctx: CheckContext<DisputeFacts>,
): Promise<string | null> {
  return ctx.caseFile.facts.suspicious ? "The buyer's text looked like an attempt to steer Pyp" : null;
}
