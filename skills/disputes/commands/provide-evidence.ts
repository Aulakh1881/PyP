// dispute.provideEvidence (Appendix C). Never Auto. The executor (owner C)
// calls POST /v1/customer/disputes/{id}/provide-evidence (multipart) with the
// values in `resolved`.
//
// Verify while coding (Appendix C note): PayPal's exact evidence_type values
// and the multipart format. We use PROOF_OF_FULFILLMENT and OTHER only.

import { z } from "zod";
import { toCents } from "@/engine/format";
import type { CommandDef } from "@/engine/types";
import { fail, ok } from "@/engine/validator";
import { AWAITING_SELLER, type DisputeFacts } from "../case-file";
import { freshDispute, textProblem } from "../checks";

export const EVIDENCE_TYPES = ["PROOF_OF_FULFILLMENT", "OTHER"] as const;

export interface ProvideEvidenceParams {
  disputeId: string;
  evidenceType: (typeof EVIDENCE_TYPES)[number];
  trackingRef: string | null;
  note: string;
  citations: string[];
}

export const provideEvidence: CommandDef<ProvideEvidenceParams, DisputeFacts> = {
  id: "dispute.provideEvidence",
  description: "Submit evidence to PayPal for this dispute: a tracking record and a short factual note.",
  aiRule:
    "Use when the case file holds facts that answer the buyer's claim, such as delivered tracking for a not-received claim. PROOF_OF_FULFILLMENT needs a trackingRef. Every fact in the note must come from the case file; list the ids you relied on in citations.",
  params: (cf) => {
    const trackingIds = cf.ids.trackingIds;
    return z.object({
      disputeId: z.enum(cf.ids.disputeIds as [string, ...string[]]),
      evidenceType: z.enum(EVIDENCE_TYPES),
      trackingRef: trackingIds.length ? z.enum(trackingIds as [string, ...string[]]).nullable() : z.null(),
      note: z.string().max(2000).describe("Factual note for PayPal's reviewer, under 2000 characters. Only facts from the case file."),
      citations: z
        .array(z.enum(cf.ids.citeIds as [string, ...string[]]))
        .min(1)
        .max(10)
        .describe("The case-file ids this evidence relies on."),
    });
  },
  available: (cf) => AWAITING_SELLER.includes(cf.facts.dispute.status) && !cf.facts.deadlinePassed,
  risk: "message",
  editable: ["note"],

  check: async (p, ctx) => {
    const fresh = await freshDispute(ctx, p.disputeId);
    if ("failed" in fresh) return fresh.failed;
    if (p.evidenceType === "PROOF_OF_FULFILLMENT") {
      if (!p.trackingRef) return fail("Proof of fulfillment needs a tracking record");
      const t = ctx.caseFile.facts.tracking.find((x) => x.id === p.trackingRef);
      if (!t || (t.status !== "DELIVERED" && t.status !== "SHIPPED")) return fail("That tracking record doesn't show the item shipped");
    }
    if (p.trackingRef && !p.citations.includes(p.trackingRef)) return fail("Cite the tracking record you rely on");
    if (new Set(p.citations).size !== p.citations.length) return fail("A citation is listed twice");
    const problem = textProblem(p.note, [toCents(fresh.dispute.amount)]);
    if (problem) return fail(problem);
    return ok();
  },

  resolve: (p, cf) => {
    const t = p.trackingRef ? cf.facts.tracking.find((x) => x.id === p.trackingRef) : undefined;
    return {
      disputeId: cf.facts.dispute.id,
      evidenceType: p.evidenceType,
      tracking: t ? { carrier: t.carrier, number: t.number, status: t.status } : null,
      note: p.note,
      citations: p.citations,
      responseDue: cf.facts.dispute.sellerResponseDueDate,
    };
  },
};
