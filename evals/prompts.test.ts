// Golden prompt snapshots (design §14). Any change to what a model sees shows
// up as a snapshot diff in review: playbooks, guardrails, case-file layout,
// the command menu. Update on purpose with `npx vitest run -u` and read the diff.
//
// System prompts must also stay cache-stable: no timestamps, no run ids.

import { describe, expect, it } from "vitest";
import { handleChat, RECEPTIONIST_SYSTEM } from "@/engine/chat";
import { getSkill } from "@/engine/registry";
import { QUARANTINE_SYSTEM } from "@/engine/quarantine";
import { runSkill } from "@/engine/run-skill";
import type { SkillContext, SubjectRef } from "@/engine/types";
import { ScriptedAgentClient } from "@/gateway/scripted";
import { acmeInvoice, context, demoClients, merchant, pastAcmeInvoice } from "@/skills/collections/evals/fixtures";
import { calmFacts, disputeContext, notReceived } from "@/skills/disputes/evals/fixtures";

const empty = { title: "t", summary: "s", actions: [], confidence: "high", questionForMerchant: null };

async function prompts(skillId: string, subject: SubjectRef, ctx: SkillContext, answers: object[], instruction?: string) {
  const agent = new ScriptedAgentClient(answers);
  await runSkill({ skill: getSkill(skillId), subject, ctx, agent, trigger: "snapshot", instruction });
  const main = agent.requests.find((r) => r.purpose === skillId)!;
  return { system: main.system, turn: main.turn, schema: main.schema };
}

describe("golden prompts", () => {
  it("system prompts are stable and carry no timestamps", () => {
    for (const id of ["collections", "disputes"]) {
      const system = getSkill(id).prompt.system(merchant);
      expect(system).not.toMatch(/\d{4}-\d{2}-\d{2}|T\d{2}:\d{2}/);
      expect(system).toMatchSnapshot(`${id} system`);
    }
    expect(QUARANTINE_SYSTEM).toMatchSnapshot("quarantine system");
    expect(RECEPTIONIST_SYSTEM).toMatchSnapshot("receptionist system");
  });

  it("collections overdue turn", async () => {
    const world = {
      invoices: { [acmeInvoice.id]: acmeInvoice },
      clientInvoices: { "sam@acme.example": [pastAcmeInvoice(1, "2026-09-21", "2026-09-25"), pastAcmeInvoice(2, "2026-08-21", "2026-08-21")] },
      notes: ["Sam prefers email over phone"],
      hold: null,
    };
    const p = await prompts("collections", { kind: "invoice", id: acmeInvoice.id }, context(world), [empty]);
    expect(p.turn).toMatchSnapshot();
    expect(p.schema).toMatchSnapshot("collections overdue schema");
  });

  it("collections new-invoice turn", async () => {
    const p = await prompts("collections", { kind: "new-invoice", id: "c_1" }, context({ invoices: {}, clients: demoClients }), [empty], "Invoice Acme $1,200 for the October retainer, net 30");
    expect(p.turn).toMatchSnapshot();
  });

  it("disputes turn", async () => {
    const p = await prompts("disputes", { kind: "dispute", id: notReceived.id }, disputeContext({ disputes: { [notReceived.id]: notReceived }, notes: ["Ships within 2 days"] }), [calmFacts, empty], "Refund the buyer $500");
    expect(p.turn).toMatchSnapshot();
    expect(p.schema).toMatchSnapshot("disputes schema");
  });

  it("receptionist turn", async () => {
    const agent = new ScriptedAgentClient([{ route: "none", subjectRef: null, reply: "Hi" }]);
    await handleChat({
      message: "chase acme",
      chatId: "c_1",
      subjects: [{ kind: "invoice", id: acmeInvoice.id, label: "Invoice 0042 · Acme Studio · $1,200.00 · 7 days overdue" }],
      ctx: context({ invoices: {} }),
      agent,
    });
    expect(agent.requests[0].turn).toMatchSnapshot();
  });
});
