// merchant.ask: a question card with up to 4 buttons. On every skill's menu,
// can't be switched Off, and never runs on Auto (design §8.1).

import { z } from "zod";
import type { CommandDef } from "../types";
import { fail, ok } from "../validator";

export interface MerchantAskParams {
  question: string;
  options: string[];
}

export const merchantAsk: CommandDef<MerchantAskParams> = {
  id: "merchant.ask",
  description: "Ask the merchant a short question, with up to 4 answer buttons.",
  aiRule:
    "Use when a decision needs a fact or a preference only the merchant has, or when the playbook says to check with them. Keep it to one question.",
  params: () =>
    z.object({
      question: z.string().max(300).describe("One question, under 300 characters."),
      options: z.array(z.string().max(60)).max(4).describe("Up to 4 short answer buttons."),
    }),
  available: () => true,
  risk: "read",
  check: async (p) => {
    if (!p.question.trim()) return fail("The question is empty");
    if (/https?:\/\//i.test(p.question)) return fail("Questions can't contain links");
    return ok();
  },
};
