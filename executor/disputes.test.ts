// The Disputes cards through the executor on a real Postgres (skipped without
// TEST_DATABASE_URL; CI runs them). The model is scripted; PayPal is a fake
// that records each write. Every dispute write is never Auto, so each card
// here waits for Approve.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getSkill } from "@/engine/registry";
import { runSkill } from "@/engine/run-skill";
import type { Dispute, PayPalReads } from "@/engine/types";
import { ScriptedAgentClient } from "@/gateway/scripted";
import { listCards, saveRun } from "@/jobs/store";
import { DEMO_MERCHANT, TEST_DB_URL, freshDatabase } from "@/jobs/test-db";
import { PayPalError } from "@/paypal/http";
import type { PayPalWriteClient } from "@/paypal/write-client";
import { calmFacts, disputeContext, evidenceAnswer, notReceived, offerAnswer } from "@/skills/disputes/evals/fixtures";
import { approveAndExecute } from "./execute";

const NOW = new Date("2026-10-31T16:00:00Z");
const subject = { kind: "dispute", id: notReceived.id };

function fakePayPal() {
  const calls: { op: string; disputeId: string; body: unknown; requestId: string }[] = [];
  const fail: PayPalError[] = [];
  const rec = (op: string) => async (disputeId: string, body: unknown, requestId: string) => {
    calls.push({ op, disputeId, body, requestId });
    const f = fail.shift();
    if (f) throw f;
    return { status: 200, debugId: "dbg", body: {} };
  };
  const write = {
    provideEvidence: rec("evidence"),
    makeOffer: rec("offer"),
    sendDisputeMessage: rec("message"),
    acceptClaim: rec("accept"),
  } as unknown as PayPalWriteClient;
  let dispute: Dispute = notReceived;
  const read: PayPalReads = {
    getInvoice: async () => null,
    recentClients: async () => [],
    getDispute: async (id) => (id === dispute.id ? dispute : null),
  };
  return { write, read, calls, fail, setDispute: (d: Dispute) => (dispute = d) };
}

describe.skipIf(!TEST_DB_URL)("executor: dispute writes (Postgres)", () => {
  let pool: Pool;
  let drop: () => Promise<void>;
  let pp: ReturnType<typeof fakePayPal>;

  beforeAll(async () => {
    ({ pool, drop } = await freshDatabase());
  });
  afterAll(async () => drop?.());
  beforeEach(() => {
    pp = fakePayPal();
  });

  /** One Disputes run stored as a card, the way the webhook would store it. */
  async function card(answer: object, instruction?: string): Promise<string> {
    const result = await runSkill({
      skill: getSkill("disputes"),
      subject,
      ctx: disputeContext({ disputes: { [notReceived.id]: notReceived } }),
      agent: new ScriptedAgentClient([calmFacts, answer]),
      trigger: "event:CUSTOMER.DISPUTE.CREATED",
      instruction,
    });
    const { cardIds } = await saveRun(pool, { merchantId: DEMO_MERCHANT, skill: "disputes", subject, trigger: "event", result });
    expect(cardIds).toHaveLength(1);
    return cardIds[0];
  }
  const approve = (cardId: string) => approveAndExecute({ db: pool, read: pp.read, write: pp.write, now: () => NOW }, DEMO_MERCHANT, cardId);
  const state = async (cardId: string) => (await listCards(pool, DEMO_MERCHANT)).find((c) => c.id === cardId)!.state;

  it("evidence: Approve submits the tracking code picked, not text the model wrote", async () => {
    const id = await card(evidenceAnswer());
    expect(await state(id)).toBe("awaiting_approval");
    const out = await approve(id);
    expect(out).toEqual({ status: "executed", message: "Evidence submitted for dispute PP-D-123: USPS tracking 9400111899223" });

    const proposalId = (await pool.query("select proposal_id from cards where id = $1", [id])).rows[0].proposal_id;
    expect(pp.calls).toEqual([
      {
        op: "evidence",
        disputeId: "PP-D-123",
        body: {
          evidenceType: "PROOF_OF_FULFILLMENT",
          tracking: { carrier: "USPS", number: "9400111899223", status: "DELIVERED" },
          note: "USPS tracking 9400111899223 shows the order delivered.",
        },
        requestId: proposalId,
      },
    ]);
    expect(await state(id)).toBe("executed");
    const exec = await pool.query("select step, paypal_request_id, http_status from executions where proposal_id = $1", [proposalId]);
    expect(exec.rows).toEqual([{ step: "single", paypal_request_id: proposalId, http_status: 200 }]);
  });

  it("offer: Approve sends code's amount, capped at the disputed amount", async () => {
    const id = await card(offerAnswer("amt_1"), "Refund the buyer $500");
    const out = await approve(id);
    expect(out).toEqual({ status: "executed", message: "Offered $500.00 (refund) on dispute PP-D-123" });
    expect(pp.calls[0]).toMatchObject({ op: "offer", body: { offerType: "REFUND", amount: "500.00", currency: "USD" } });
  });

  it("a dispute closed while the card waited: nothing is sent", async () => {
    const id = await card(evidenceAnswer());
    pp.setDispute({ ...notReceived, status: "RESOLVED" });
    const out = await approve(id);
    expect(out).toEqual({ status: "obsolete", message: "Not sent: Dispute is RESOLVED, not waiting on you" });
    expect(pp.calls).toEqual([]);
    expect(await state(id)).toBe("obsolete");
  });

  it("PayPal timing out: Approve again retries with the same request id", async () => {
    const id = await card(evidenceAnswer());
    pp.fail.push(new PayPalError("Service unavailable", 503, "dbg", null));
    expect((await approve(id)).status).toBe("retry");
    expect(await state(id)).toBe("awaiting_approval");
    expect((await approve(id)).status).toBe("executed");
    expect(pp.calls).toHaveLength(2);
    expect(pp.calls[0].requestId).toBe(pp.calls[1].requestId);
  });

  it("PayPal refusing (422) fails the card with PayPal's reason", async () => {
    const id = await card(evidenceAnswer());
    pp.fail.push(new PayPalError("Evidence type isn't allowed for this dispute reason", 422, "dbg", null));
    expect(await approve(id)).toEqual({ status: "failed", message: "PayPal refused: Evidence type isn't allowed for this dispute reason" });
    expect(await state(id)).toBe("failed");
  });
});
