// The first demo path end to end on a real Postgres: a chat sentence becomes
// a card, Approve sends it through the executor, and the trace shows it all.
// The model is scripted and PayPal is a fake that records every call.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { ScriptedAgentClient } from "@/gateway/scripted";
import { BudgetExceeded } from "@/gateway/budget";
import type { PayPalReads } from "@/engine/types";
import { runChatMessage } from "@/jobs/chat-run";
import { PgLedger } from "@/jobs/spend-ledger";
import { getTrace, listCards } from "@/jobs/store";
import { DEMO_MERCHANT, TEST_DB_URL, freshDatabase } from "@/jobs/test-db";
import { demoClients } from "@/skills/collections/evals/fixtures";
import { PayPalError } from "@/paypal/http";
import type { PayPalWriteClient } from "@/paypal/write-client";
import { approveAndExecute } from "./execute";
import { clearCard, dismiss } from "@/jobs/store";

const NOW = new Date("2026-10-31T16:00:00Z");
const SENTENCE = "Invoice Jordan Kim $300 for the logo, net 30";

/** The receptionist's answer (engine/chat.ts): chat goes to a new invoice. */
const ROUTE_NEW_INVOICE = { route: "new_invoice", subjectRef: null, reply: "Drafting that invoice now.", continues: false, newClient: null, remember: null };

function invoiceAnswer() {
  return {
    title: "Invoice Jordan Kim $300",
    summary: "New invoice for Jordan Kim: $300.00 for the logo, net 30.",
    actions: [
      {
        command: "invoice.createAndSend",
        params: { clientId: "cl_3", items: [{ description: "Logo", amountRef: "amt_1" }], terms: "net_30", note: "Thanks, Jordan!" },
        why: "The request names Jordan Kim (cl_3), $300 (amt_1) and net 30.",
      },
    ],
    confidence: "high",
    questionForMerchant: null,
  };
}

/** A PayPal stand-in: records calls; each method can be told to fail first. */
function fakePayPal() {
  const calls: { op: string; requestId: string }[] = [];
  const failures: Record<string, PayPalError[]> = { create: [], send: [] };
  const write = {
    async createDraftInvoice(_inv: unknown, requestId: string) {
      calls.push({ op: "create", requestId });
      const f = failures.create.shift();
      if (f) throw f;
      return { invoiceId: "INV2-TEST-0001", invoiceNumber: "0001", response: { status: 201, debugId: "dbg1", body: {} } };
    },
    async sendInvoice(_id: string, requestId: string) {
      calls.push({ op: "send", requestId });
      const f = failures.send.shift();
      if (f) throw f;
      return { status: 200, debugId: "dbg2", body: {} };
    },
    async remindInvoice() {
      throw new Error("not in this test");
    },
  } as unknown as PayPalWriteClient;
  let clients = demoClients;
  const read: PayPalReads = {
    async getInvoice() {
      return null;
    },
    async recentClients() {
      return clients;
    },
  };
  return { write, read, calls, failures, dropClients: () => (clients = []) };
}

describe.skipIf(!TEST_DB_URL)("demo path: chat, card, approve, PayPal", () => {
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

  const chat = (sentence = SENTENCE) =>
    runChatMessage({ pool, read: pp.read, agent: new ScriptedAgentClient([ROUTE_NEW_INVOICE, invoiceAnswer()]), now: () => NOW }, DEMO_MERCHANT, sentence);
  const approve = (cardId: string, merchantId = DEMO_MERCHANT) =>
    approveAndExecute({ db: pool, read: pp.read, write: pp.write, now: () => NOW }, merchantId, cardId);

  it("a sentence becomes one card that shows code's values, not the model's", async () => {
    const out = await chat();
    expect(out.status).toBe("ok");
    expect(out.cardIds).toHaveLength(1);
    const card = (await listCards(pool, DEMO_MERCHANT)).find((c) => c.id === out.cardIds[0])!;
    expect(card.state).toBe("awaiting_approval");
    expect(card.front).toMatchObject({
      eyebrow: "COLLECTIONS · NEEDS YOU",
      subtitle: "Jordan Kim · $300.00 · due 2026-11-30",
      lines: [{ description: "Logo", amount: "$300.00" }],
      amount: { value: "300.00", currency: "USD" },
      approveLabel: "Create and send to Jordan Kim ($300.00)",
      demoData: true,
    });
    expect(card.front.reason).toContain("always needs your approval");
  });

  it("Approve creates then sends, with per-step request ids, and the trace says so", async () => {
    const { cardIds } = await chat();
    const out = await approve(cardIds[0]);
    expect(out).toMatchObject({ status: "executed", message: "Invoice 0001 for $300.00 created and sent to jordan.kim@example.com" });

    const proposalId = (await pool.query("select proposal_id from cards where id = $1", [cardIds[0]])).rows[0].proposal_id;
    expect(pp.calls).toEqual([
      { op: "create", requestId: `${proposalId}:create` },
      { op: "send", requestId: `${proposalId}:send` },
    ]);
    const card = (await listCards(pool, DEMO_MERCHANT)).find((c) => c.id === cardIds[0])!;
    expect(card.state).toBe("executed");

    const trace = (await getTrace(pool, DEMO_MERCHANT, cardIds[0]))!;
    // The receptionist's routing (trigger, decide), then the Collections run, then the approval.
    expect(trace.map((s) => s.kind)).toEqual(["trigger", "decide", "trigger", "gather", "menu", "decide", "validate", "policy", "merchant", "paypal"]);
    expect(trace[1].label).toBe("Routed to new_invoice");
    expect(trace.at(-1)).toMatchObject({ ok: true, label: out.message });
    const log = await pool.query("select actor, summary from activity_log where refs_json->>'cardId' = $1", [cardIds[0]]);
    expect(log.rows).toEqual([{ actor: "pyp", summary: out.message }]);
  });

  it("a second Approve (double tap, second tab) does nothing", async () => {
    const { cardIds } = await chat();
    const [a, b] = await Promise.all([approve(cardIds[0]), approve(cardIds[0])]);
    expect([a.status, b.status].sort()).toEqual(["executed", "not_waiting"]);
    expect(pp.calls.filter((c) => c.op === "create")).toHaveLength(1);
  });

  it("PayPal timing out on send: Approve again resumes at send, never a second draft", async () => {
    const { cardIds } = await chat();
    pp.failures.send.push(new PayPalError("Service unavailable", 503, "dbg", null));
    const first = await approve(cardIds[0]);
    expect(first.status).toBe("retry");
    const card = (await listCards(pool, DEMO_MERCHANT)).find((c) => c.id === cardIds[0])!;
    expect(card.state).toBe("awaiting_approval");
    expect(card.front.reason).toContain("won't send twice");

    const second = await approve(cardIds[0]);
    expect(second.status).toBe("executed");
    expect(pp.calls.map((c) => c.op)).toEqual(["create", "send", "send"]);
    expect(pp.calls[1].requestId).toBe(pp.calls[2].requestId);
  });

  it("an unexpected error after the claim hands the card back instead of leaving it on Sending", async () => {
    const { cardIds } = await chat();
    let failed = false;
    const flaky = {
      query: ((text: string, params?: unknown[]) => {
        if (!failed && text.startsWith("insert into executions")) {
          failed = true;
          return Promise.reject(new Error("connection reset"));
        }
        return pool.query(text, params);
      }) as Pool["query"],
    };
    const first = await approveAndExecute({ db: flaky, read: pp.read, write: pp.write, now: () => NOW }, DEMO_MERCHANT, cardIds[0]);
    expect(first).toMatchObject({ status: "retry" });
    expect((await listCards(pool, DEMO_MERCHANT)).find((c) => c.id === cardIds[0])!.state).toBe("awaiting_approval");

    // The draft was made but its record was lost: PayPal answers the same request id with the same draft.
    expect((await approve(cardIds[0])).status).toBe("executed");
    expect(pp.calls.map((c) => c.requestId)).toEqual([pp.calls[0].requestId, pp.calls[0].requestId, pp.calls[2].requestId]);
  });

  it("a re-check that can't reach PayPal is a retry, not a lost card", async () => {
    const { cardIds } = await chat();
    const down: PayPalReads = { ...pp.read, recentClients: () => Promise.reject(new PayPalError("timeout", null, null, null)) };
    const out = await approveAndExecute({ db: pool, read: down, write: pp.write, now: () => NOW }, DEMO_MERCHANT, cardIds[0]);
    expect(out.status).toBe("retry");
    expect(pp.calls).toEqual([]);
    expect((await approve(cardIds[0])).status).toBe("executed");
  });

  it("PayPal refusing (422) fails the card with PayPal's reason", async () => {
    const { cardIds } = await chat();
    pp.failures.create.push(new PayPalError("Recipient email is invalid", 422, "dbg", null));
    const out = await approve(cardIds[0]);
    expect(out).toEqual({ status: "failed", message: "PayPal refused: Recipient email is invalid" });
    const exec = await pool.query("select step, http_status from executions e join cards c on c.proposal_id = e.proposal_id where c.id = $1", [cardIds[0]]);
    expect(exec.rows).toEqual([{ step: "create", http_status: 422 }]);
  });

  it("the re-check runs before writing: a client gone from PayPal means nothing is sent", async () => {
    const { cardIds } = await chat();
    pp.dropClients();
    const out = await approve(cardIds[0]);
    expect(out).toEqual({ status: "obsolete", message: "Not sent: Client no longer found" });
    expect(pp.calls).toEqual([]);
  });

  it("a dismissed card can't be approved", async () => {
    const { cardIds } = await chat();
    expect(await dismiss(pool, DEMO_MERCHANT, cardIds[0])).toBe(true);
    expect((await approve(cardIds[0])).status).toBe("not_waiting");
    expect(pp.calls).toEqual([]);
  });

  it("Remove from Inbox only works on finished cards, and keeps the card for Activity", async () => {
    const { cardIds } = await chat();
    expect(await clearCard(pool, DEMO_MERCHANT, cardIds[0])).toBe(false); // still waiting on you
    expect(await dismiss(pool, DEMO_MERCHANT, cardIds[0])).toBe(true);
    expect(await clearCard(pool, "00000000-0000-0000-0000-000000000002", cardIds[0])).toBe(false);
    expect(await clearCard(pool, DEMO_MERCHANT, cardIds[0])).toBe(true);
    expect(await clearCard(pool, DEMO_MERCHANT, cardIds[0])).toBe(false); // already removed
    const card = (await listCards(pool, DEMO_MERCHANT)).find((c) => c.id === cardIds[0])!;
    expect(card.state).toBe("rejected");
    expect(card.clearedAt).not.toBeNull();
  });

  it("another merchant can't see, approve or dismiss the card", async () => {
    const other = "00000000-0000-0000-0000-000000000002";
    await pool.query("insert into merchants (id, name) values ($1, 'Other') on conflict do nothing", [other]);
    const { cardIds } = await chat();
    expect((await approve(cardIds[0], other)).status).toBe("not_waiting");
    expect(await dismiss(pool, other, cardIds[0])).toBe(false);
    expect(await getTrace(pool, other, cardIds[0])).toBeNull();
    expect((await listCards(pool, other)).map((c) => c.id)).not.toContain(cardIds[0]);
  });

  it("a first name that fits one client names them; the card still waits for approval", async () => {
    const agent = new ScriptedAgentClient([ROUTE_NEW_INVOICE, invoiceAnswer()]);
    const out = await runChatMessage({ pool, read: pp.read, agent, now: () => NOW }, DEMO_MERCHANT, "Invoice Jordan $300");
    expect(out.cardIds).toHaveLength(1);
    expect(pp.calls).toEqual([]);
  });

  it("a first name two clients share makes no invoice card", async () => {
    const twoJordans: PayPalReads = {
      ...pp.read,
      recentClients: async () => [...(await pp.read.recentClients()), { id: "x", name: "Jordan Lee", businessName: null, email: "jlee@example.com" }],
    };
    const agent = new ScriptedAgentClient([ROUTE_NEW_INVOICE, invoiceAnswer()]);
    const out = await runChatMessage({ pool, read: twoJordans, agent, now: () => NOW }, DEMO_MERCHANT, "Invoice Jordan $300");
    expect(out.cardIds).toHaveLength(0);
  });

  it("every table has Row Level Security on, so the browser's key can't read Pyp's records", async () => {
    const res = await pool.query(
      "select relname from pg_class where relnamespace = 'public'::regnamespace and relkind = 'r' and not relrowsecurity order by relname",
    );
    expect(res.rows).toEqual([]);
  });

  it("the spend ledger fails closed at the cap and settles to the real cost", async () => {
    const ledger = new PgLedger(pool);
    const id = await ledger.reserve(0.4, 1, "test");
    await expect(ledger.reserve(0.7, 1, "test")).rejects.toBeInstanceOf(BudgetExceeded);
    await ledger.settle(id, 0.1);
    await ledger.settle(id, 0.1); // settling twice changes nothing
    await ledger.reserve(0.85, 1, "test");
    const spent = await pool.query("select spent_usd::float as s from spend_ledger where day = current_date");
    expect(spent.rows[0].s).toBeCloseTo(0.95);
  });
});
