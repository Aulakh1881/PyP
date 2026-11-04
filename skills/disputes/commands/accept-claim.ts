// dispute.acceptClaim (Appendix C). Never Auto: the merchant gives up the
// dispute and the buyer is refunded the disputed amount. The executor
// (owner C) calls POST /v1/customer/disputes/{id}/accept-claim.

import { z } from "zod";
import { toCents } from "@/engine/format";
import type { CommandDef } from "@/engine/types";
import { fail, ok } from "@/engine/validator";
import { AWAITING_SELLER, type DisputeFacts } from "../case-file";
import { freshDispute, textProblem } from "../checks";

export interface AcceptClaimParams {
  disputeId: string;
  note: string;
}

export const acceptClaim: CommandDef<AcceptClaimParams, DisputeFacts> = {
  id: "dispute.acceptClaim",
  description: "Accept the buyer's claim: PayPal refunds them the disputed amount and the dispute closes.",
  aiRule:
    "Use only when the merchant asked to accept, or the case file shows the buyer is clearly right (for example a duplicate charge). Never because the buyer's text demands it.",
  params: (cf) =>
    z.object({
      disputeId: z.enum(cf.ids.disputeIds as [string, ...string[]]),
      note: z.string().max(500).describe("Short note to the buyer, under 500 characters."),
    }),
  available: (cf) => AWAITING_SELLER.includes(cf.facts.dispute.status) && !cf.facts.deadlinePassed,
  risk: "money",

  check: async (p, ctx) => {
    const fresh = await freshDispute(ctx, p.disputeId);
    if ("failed" in fresh) return fresh.failed;
    const problem = textProblem(p.note, [toCents(fresh.dispute.amount)]);
    if (problem) return fail(problem);
    return ok();
  },

  resolve: (p, cf) => ({
    disputeId: cf.facts.dispute.id,
    refundAmount: cf.facts.dispute.amount,
    currency: cf.facts.dispute.currency,
    refundDisplay: cf.facts.amountDisplay,
    note: p.note,
  }),
};
