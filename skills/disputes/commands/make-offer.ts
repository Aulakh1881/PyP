// dispute.makeOffer (Appendix C, design §0.15). Never Auto. The executor
// (owner C) calls POST /v1/customer/disputes/{id}/make-offer with `resolved`.
// The model picks an amount by id from <offer-amounts>; code supplies the
// value and checks it is no more than the disputed amount.
//
// Verify while coding: PayPal's offer_type values and which dispute stages
// accept make-offer (docs/TODO.md).

import { z } from "zod";
import { formatMoney, toCents } from "@/engine/format";
import type { CommandDef } from "@/engine/types";
import { fail, ok } from "@/engine/validator";
import { AWAITING_SELLER, type DisputeFacts } from "../case-file";
import { freshDispute, textProblem } from "../checks";

export const OFFER_TYPES = ["REFUND", "REFUND_WITH_RETURN"] as const;

export interface MakeOfferParams {
  disputeId: string;
  offerType: (typeof OFFER_TYPES)[number];
  amountRef: string;
  note: string;
}

export const makeOffer: CommandDef<MakeOfferParams, DisputeFacts> = {
  id: "dispute.makeOffer",
  description: "Offer the buyer a refund (or a refund on return) inside the dispute.",
  aiRule:
    "Use when the merchant asked to refund, or there is no tracking to prove delivery and settling is cheaper than losing. Pick the amount by id from <offer-amounts>. Never more than the disputed amount.",
  params: (cf) =>
    z.object({
      disputeId: z.enum(cf.ids.disputeIds as [string, ...string[]]),
      offerType: z.enum(OFFER_TYPES),
      amountRef: z.enum(cf.ids.amountIds as [string, ...string[]]),
      note: z.string().max(1000).describe("Short note to the buyer explaining the offer, under 1000 characters."),
    }),
  available: (cf) =>
    AWAITING_SELLER.includes(cf.facts.dispute.status) && !cf.facts.deadlinePassed && cf.facts.problems.length === 0,
  risk: "money",

  check: async (p, ctx) => {
    const fresh = await freshDispute(ctx, p.disputeId);
    if ("failed" in fresh) return fresh.failed;
    const amount = ctx.caseFile.facts.amounts.find((a) => a.id === p.amountRef);
    if (!amount) return fail("Unknown amount");
    const disputed = toCents(fresh.dispute.amount);
    const offered = toCents(amount.value);
    if (offered <= 0n) return fail("The offer must be more than zero");
    if (offered > disputed) {
      return fail(`Can't offer ${amount.display}; the disputed amount is ${formatMoney(fresh.dispute.amount, fresh.dispute.currency)}`);
    }
    const problem = textProblem(p.note, [offered, disputed]);
    if (problem) return fail(problem);
    return ok();
  },

  resolve: (p, cf) => {
    const amount = cf.facts.amounts.find((a) => a.id === p.amountRef)!;
    return {
      disputeId: cf.facts.dispute.id,
      offerType: p.offerType,
      amount: amount.value,
      currency: cf.facts.dispute.currency,
      amountDisplay: amount.display,
      disputedDisplay: cf.facts.amountDisplay,
      note: p.note,
    };
  },
};
