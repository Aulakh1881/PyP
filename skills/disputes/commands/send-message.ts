// dispute.sendMessage (Appendix C). The executor (owner C) calls
// POST /v1/customer/disputes/{id}/send-message. Ask me by default; it goes to
// the merchant whatever the dial if the buyer's text looked suspicious.

import { z } from "zod";
import { toCents } from "@/engine/format";
import type { CommandDef } from "@/engine/types";
import { fail, ok } from "@/engine/validator";
import { OPEN_STATES, type DisputeFacts } from "../case-file";
import { freshDispute, suspiciousLimit, textProblem } from "../checks";

export interface SendMessageParams {
  disputeId: string;
  message: string;
}

export const sendMessage: CommandDef<SendMessageParams, DisputeFacts> = {
  id: "dispute.sendMessage",
  description: "Send the buyer a message through PayPal's dispute thread.",
  aiRule:
    "Use to answer a question the buyer asked, or to tell them what the merchant is doing. Polite, short, factual, in the merchant's voice. No promises of money unless an offer is also proposed.",
  params: (cf) =>
    z.object({
      disputeId: z.enum(cf.ids.disputeIds as [string, ...string[]]),
      message: z.string().max(2000).describe("The message to the buyer, under 2000 characters."),
    }),
  available: (cf) => OPEN_STATES.includes(cf.facts.dispute.status) && !cf.facts.deadlinePassed,
  risk: "message",

  check: async (p, ctx) => {
    const fresh = await freshDispute(ctx, p.disputeId, OPEN_STATES);
    if ("failed" in fresh) return fresh.failed;
    const problem = textProblem(p.message, [toCents(fresh.dispute.amount)]);
    if (problem) return fail(problem);
    return ok();
  },
  overLimit: suspiciousLimit,

  resolve: (p, cf) => ({ disputeId: cf.facts.dispute.id, buyerName: cf.facts.dispute.buyerName, message: p.message }),
};
