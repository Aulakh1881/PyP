// Disputes decision tests (Appendix G) with the scripted model. The first
// scripted answer is always the quarantine call's, the second the decision.

import { describe, expect, it } from "vitest";
import { handleEvent } from "@/engine/router";
import { runSkill } from "@/engine/run-skill";
import { ScriptedAgentClient } from "@/gateway/scripted";
import { disputes } from "../skill";
import { calmFacts, disputeContext, evidenceAnswer, notReceived, offerAnswer, rules, type DisputeWorld } from "./fixtures";

const subject = { kind: "dispute", id: notReceived.id };
const world: DisputeWorld = { disputes: { [notReceived.id]: notReceived } };

async function run(w: DisputeWorld, answers: ConstructorParameters<typeof ScriptedAgentClient>[0], opts: { instruction?: string; r?: ReturnType<typeof rules> } = {}) {
  const agent = new ScriptedAgentClient(answers);
  const result = await runSkill({ skill: disputes, subject, ctx: disputeContext(w, opts.r), agent, trigger: "event:CUSTOMER.DISPUTE.CREATED", instruction: opts.instruction });
  return { result, agent };
}

describe("Disputes", () => {
  it("not received + delivered tracking: evidence citing the tracking id, always a card", async () => {
    const r = rules({ commands: { "dispute.provideEvidence": { dial: "auto" } } });
    const { result, agent } = await run(world, [calmFacts, evidenceAnswer()], { r });

    expect(result.status).toBe("ok");
    expect(result.menu).toEqual(["dispute.provideEvidence", "dispute.makeOffer", "dispute.sendMessage", "dispute.acceptClaim", "merchant.ask"]);
    expect(result.proposals[0]).toMatchObject({
      status: "awaiting_approval",
      policy: { rule: "never_auto" },
      resolved: { evidenceType: "PROOF_OF_FULFILLMENT", tracking: { carrier: "USPS", number: "9400111899223" } },
    });

    // Two calls: the quarantine (fast, no commands) then the decision (deep).
    expect(agent.requests.map((r) => [r.purpose, r.tier])).toEqual([["quarantine", "fast"], ["disputes", "deep"]]);
    expect(agent.requests[0].turn).not.toContain("<commands>");
    const turn = agent.requests[1].turn;
    expect(turn).toContain('<buyer-facts id="buyer_facts"');
    expect(turn).toContain("<untrusted-buyer-text>My package never arrived. I want a refund.</untrusted-buyer-text>");
    expect(turn).toContain('<shipment id="trk_1" carrier="USPS" number="9400111899223" status="DELIVERED"/>');
    expect(turn).toContain('hours-left="216"');
    expect(result.usage).toHaveLength(2); // the quarantine call counts toward the run
  });

  it("proof of fulfillment without tracking is rejected", async () => {
    const { result } = await run(world, [calmFacts, evidenceAnswer({ trackingRef: null, citations: ["PP-D-123"] })]);
    expect(result.proposals[0]).toMatchObject({ status: "invalid", check: { reason: "Proof of fulfillment needs a tracking record" } });
  });

  it("evidence with a link is rejected", async () => {
    const { result } = await run(world, [calmFacts, evidenceAnswer({ note: "Delivered, see usps-proof.example/123" })]);
    expect(result.proposals[0].check.reason).toBe("Messages to the buyer can't contain links");
  });

  it("'refund $500' on a $600 dispute: an offer of exactly $500, always a card (design §0.15)", async () => {
    const r = rules({ commands: { "dispute.makeOffer": { dial: "auto" } } });
    const { result, agent } = await run(world, [calmFacts, offerAnswer("amt_1")], { instruction: "Refund the buyer $500", r });
    expect(agent.requests[1].turn).toContain('<amount id="amt_1" value="$500.00" written-as="$500"/>');
    expect(result.proposals[0]).toMatchObject({
      status: "awaiting_approval",
      policy: { rule: "never_auto" },
      resolved: { amount: "500.00", amountDisplay: "$500.00", offerType: "REFUND" },
    });
  });

  it("'refund $500' on an $80 dispute: invalid, and the card says why", async () => {
    const small = { ...notReceived, amount: "80.00" };
    const { result } = await run({ disputes: { [small.id]: small } }, [calmFacts, offerAnswer("amt_1")], { instruction: "Refund the buyer $500" });
    expect(result.proposals[0]).toMatchObject({
      status: "invalid",
      check: { reason: "Can't offer $500.00; the disputed amount is $80.00" },
    });
  });

  it("deadline within 72 hours: the case file and card are flagged urgent", async () => {
    const soon = { ...notReceived, sellerResponseDueDate: "2026-10-29T15:00:00Z" };
    const { result, agent } = await run({ disputes: { [soon.id]: soon } }, [calmFacts, evidenceAnswer()]);
    expect(agent.requests[1].turn).toContain('hours-left="24" urgent="yes"');
    expect(result.caseFile?.urgency).toEqual({ urgent: true, dueAt: "2026-10-29T15:00:00Z" });
  });

  it("deadline passed: nothing but a question is offered", async () => {
    const late = { ...notReceived, sellerResponseDueDate: "2026-10-27T15:00:00Z" };
    const { result } = await run({ disputes: { [late.id]: late } }, [calmFacts, { ...evidenceAnswer(), actions: [] }]);
    expect(result.menu).toEqual(["merchant.ask"]);
  });

  it("closed while the model was thinking: the fresh check rejects it", async () => {
    const w = { ...world, fresh: { [notReceived.id]: { ...notReceived, status: "RESOLVED" as const } } };
    const { result } = await run(w, [calmFacts, evidenceAnswer()]);
    expect(result.proposals[0]).toMatchObject({ status: "invalid", check: { reason: "Dispute is RESOLVED, not waiting on you" } });
  });

  it("a failed quarantine call marks the buyer text suspicious and still runs", async () => {
    const { result, agent } = await run(world, ["not json", evidenceAnswer()]);
    expect(result.status).toBe("ok");
    expect(agent.requests[1].turn).toContain('<buyer-facts suspicious="yes">');
    expect(result.trace.some((s) => s.label.startsWith("Quarantine failed"))).toBe(true);
  });

  it("no getDispute read yet: the run fails cleanly with no model call", async () => {
    const { result, agent } = await run({ ...world, noDisputeReads: true }, []);
    expect(result.status).toBe("failed");
    expect(result.failure).toContain("getDispute");
    expect(agent.requests).toHaveLength(0);
  });

  it("an update that resolves the dispute stands down with no model call", async () => {
    const agent = new ScriptedAgentClient([]);
    const closed = { ...notReceived, status: "RESOLVED" as const };
    const res = await handleEvent({ eventType: "CUSTOMER.DISPUTE.UPDATED", subject, ctx: disputeContext({ disputes: { [closed.id]: closed } }), agent });
    expect(agent.requests).toHaveLength(0);
    expect(res).toMatchObject({ kind: "handled", outcome: { kind: "stand_down", message: "The $600.00 dispute PP-D-123 is resolved. Pending dispute cards closed." } });
  });

  it("an update on a still-open dispute is a normal run", async () => {
    const agent = new ScriptedAgentClient([calmFacts, evidenceAnswer()]);
    const res = await handleEvent({ eventType: "CUSTOMER.DISPUTE.UPDATED", subject, ctx: disputeContext(world), agent });
    expect(res.kind).toBe("run");
    expect(agent.requests).toHaveLength(2);
  });
});
