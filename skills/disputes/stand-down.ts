// A dispute update that closes it needs no judgment: stand down with no model
// call. Any other update (new message, new deadline) is a normal run.

import { formatMoney } from "@/engine/format";
import type { CommandId, EventHandler } from "@/engine/types";
import { OPEN_STATES } from "./case-file";

export const CLOSED_OBSOLETES: CommandId[] = [
  "dispute.provideEvidence",
  "dispute.sendMessage",
  "dispute.makeOffer",
  "dispute.acceptClaim",
  "merchant.ask",
];

export const disputeUpdated: EventHandler = async (ctx, subject) => {
  if (subject.kind !== "dispute") return { kind: "ignore", reason: `Expected a dispute, got ${subject.kind}` };
  if (!ctx.read.getDispute) return { kind: "run" };
  const d = await ctx.read.getDispute(subject.id);
  if (!d) return { kind: "ignore", reason: `Dispute ${subject.id} not found in PayPal` };
  if (OPEN_STATES.includes(d.status)) return { kind: "run" };
  return {
    kind: "stand_down",
    message: `The ${formatMoney(d.amount, d.currency)} dispute ${d.id} is ${d.status === "RESOLVED" ? "resolved" : d.status.toLowerCase().replace(/_/g, " ")}. Pending dispute cards closed.`,
    obsoleteCommands: CLOSED_OBSOLETES,
    cancelFollowUps: true,
  };
};
