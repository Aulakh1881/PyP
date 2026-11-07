// Disputes: answers buyer disputes before the deadline (Appendix B.2).
// Buyer text goes through the quarantine call (fast tier) before the decision
// (deep tier); evidence, offers and accepting a claim are never Auto.

import { merchantAsk } from "@/engine/commands/merchant-ask";
import type { SkillDef } from "@/engine/types";
import { buildDisputeCaseFile, type DisputeFacts } from "./case-file";
import { acceptClaim } from "./commands/accept-claim";
import { makeOffer } from "./commands/make-offer";
import { provideEvidence } from "./commands/provide-evidence";
import { sendMessage } from "./commands/send-message";
import { disputesPolicy } from "./policy";
import { disputesSystemPrompt } from "./prompt";
import { disputeUpdated } from "./stand-down";

export const disputes: SkillDef<DisputeFacts> = {
  id: "disputes",
  triggers: {
    events: ["CUSTOMER.DISPUTE.CREATED", "CUSTOMER.DISPUTE.UPDATED"],
    sweeps: ["dispute-deadlines"],
    chat: true,
  },
  model: { tier: "deep", effort: "high", maxOutputTokens: 8000 },
  buildCaseFile: buildDisputeCaseFile,
  eventHandlers: { "CUSTOMER.DISPUTE.UPDATED": disputeUpdated },
  task: (subject) => `Decide how to answer dispute ${subject.id} now.`,
  commands: [provideEvidence, makeOffer, sendMessage, acceptClaim, merchantAsk],
  prompt: { system: disputesSystemPrompt },
  policy: disputesPolicy,
};
