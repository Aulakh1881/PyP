// Disputes' default dial settings (design §8.1). Evidence, offers and accepting
// a claim are never Auto; a message is Ask me by default and always asks after
// suspicious buyer text (see checks.ts).

import type { SkillDef } from "@/engine/types";

export const disputesPolicy: SkillDef["policy"] = {
  defaults: {
    "dispute.provideEvidence": { dial: "ask" },
    "dispute.sendMessage": { dial: "ask" },
    "dispute.makeOffer": { dial: "ask" },
    "dispute.acceptClaim": { dial: "ask" },
    "merchant.ask": { dial: "ask" },
  },
  neverAuto: ["dispute.provideEvidence", "dispute.makeOffer", "dispute.acceptClaim"],
};
