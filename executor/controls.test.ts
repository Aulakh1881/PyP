// The merchant's controls end to end on a real Postgres (skipped without
// TEST_DATABASE_URL; CI runs them): editing a card before Approve, the dials and
// kill switch from the controls panel, and answering a question card.

import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { Pool } from "pg";
import { getSkill } from "@/engine/registry";
import { runSkill } from "@/engine/run-skill";
import type { PayPalReads } from "@/engine/types";
import { ScriptedAgentClient } from "@/gateway/scripted";
import { answerCard } from "@/jobs/answer-run";
import { getControls, updateControls } from "@/jobs/controls";
import { listCards, saveRun } from "@/jobs/store";
import { DEMO_MERCHANT, TEST_DB_URL, freshDatabase } from "@/jobs/test-db";
import type { PayPalWriteClient } from "@/paypal/write-client";
import { acmeInvoice, context, friendlyReminder, NOW } from "@/skills/collections/evals/fixtures";
import { approveAndExecute } from "./execute";

const subject = { kind: "invoice", id: acmeInvoice.id };
const NOTE = "Hi Sam, a friendly nudge on invoice 0042 for $1,200.00, due Oct 21. Thanks so much. Maya Ortiz Design";

function askAnswer() {
  return {
    title: "Acme has had three reminders",
    summary: "Every reminder has gone out. What next?",
    actions: [
      { command: "merchant.ask", params: { question: "Sam hasn't paid invoice 0042. What should Pyp do?", options: ["Send one more reminder", "Wait a week"] }, why: "Merchant's call." },
    ],
    confidence: "high",
    questionForMerchant: null,
  };
}

describe.skipIf(!TEST_DB_URL)("controls (Postgres)", () => {
  let pool: Pool;
  let drop: () => Promise<void>;
  let sent: { note: string; subject: string }[];

  beforeAll(async () => {
    ({ pool, drop } = await freshDatabase());
  });
  afterAll(async () => drop?.());
  beforeEach(async () => {
    sent = [];
    await pool.query("update proposals set status = 'obsolete' where status in ('awaiting_approval', 'scheduled', 'executing', 'executed')");
    await pool.query("delete from rules where merchant_id = $1", [DEMO_MERCHANT]);
    await pool.query("update merchants set kill_switch = false, undo_window_s = 60 where id = $1", [DEMO_MERCHANT]);
  });

  const read: PayPalReads = { getInvoice: async (id) => (id === acmeInvoice.id ? acmeInvoice : null), recentClients: async () => [] };
  const write = {
    async remindInvoice(_id: string, msg: { note: string; subject: string }) {
      sent.push(msg);
      return { status: 204, debugId: "dbg", body: null };
    },
  } as unknown as PayPalWriteClient;
  const approve = (cardId: string, edits?: Record<string, string>) =>
    approveAndExecute({ db: pool, read, write, now: () => NOW }, DEMO_MERCHANT, cardId, edits);

  async function stored(answer: object): Promise<string> {
    const result = await runSkill({
      skill: getSkill("collections"),
      subject,
      ctx: context({ invoices: { [acmeInvoice.id]: acmeInvoice } }),
      agent: new ScriptedAgentClient([answer]),
      trigger: "sweep:overdue-invoices",
    });
    const { cardIds } = await saveRun(pool, { merchantId: DEMO_MERCHANT, skill: "collections", subject, trigger: "sweep", result, now: NOW });
    return cardIds[0];
  }
  const card = async (id: string) => (await listCards(pool, DEMO_MERCHANT)).find((c) => c.id === id)!;

  describe("editing before Approve", () => {
    it("the card offers the reminder's subject and note for editing", async () => {
      const id = await stored(friendlyReminder());
      expect((await card(id)).front.edit).toEqual([
        { field: "subject", label: "Subject", value: "Quick reminder: invoice 0042" },
        { field: "note", label: "Note", value: NOTE },
      ]);
    });

    it("an edited note is what PayPal gets, and the card and trace say so", async () => {
      const id = await stored(friendlyReminder());
      const mine = "Hi Sam, just checking in on invoice 0042 for $1,200.00. No rush if it's on its way!";
      expect((await approve(id, { note: mine })).status).toBe("executed");
      expect(sent).toEqual([{ subject: "Quick reminder: invoice 0042", note: mine }]);
      const c = await card(id);
      expect(c.front.body).toBe(mine);
      const diff = await pool.query("select edit_diff from proposals where id = (select proposal_id from cards where id = $1)", [id]);
      expect(diff.rows[0].edit_diff).toEqual({ note: { from: NOTE, to: mine } });
    });

    it("an edit that breaks a rule (a new amount, a link) isn't sent; the card waits to be fixed", async () => {
      const id = await stored(friendlyReminder());
      const out = await approve(id, { note: "Invoice 0042 for $1,200.00 plus a $50.00 late fee. Pay at https://example.com" });
      expect(out.status).toBe("edit_rejected");
      expect(out.message).toMatch(/^Not sent\. Your edit: /);
      expect(sent).toEqual([]);
      expect((await card(id)).state).toBe("awaiting_approval");
      expect((await approve(id)).status).toBe("executed"); // the original still goes through
    });

    it("only the command's editable text can change, never ids or amounts", async () => {
      const id = await stored(friendlyReminder());
      expect(await approve(id, { invoiceId: "INV2-OTHER" })).toEqual({ status: "edit_rejected", message: "Not sent. Your edit: invoiceId can't be edited" });
      expect(sent).toEqual([]);
    });

    it("an edit over the length limit is refused by the command's own schema", async () => {
      const id = await stored(friendlyReminder());
      const out = await approve(id, { note: `${NOTE} ${"x".repeat(600)}` });
      expect(out.status).toBe("edit_rejected");
      expect(sent).toEqual([]);
    });
  });

  describe("dials and kill switch", () => {
    it("lists each action with its dial, and which can be Auto", async () => {
      const c = await getControls(pool, DEMO_MERCHANT);
      expect(c).toMatchObject({ killSwitch: false, undoSeconds: 60 });
      expect(c.commands.find((x) => x.id === "invoice.sendReminder")).toMatchObject({ dial: "ask", canAuto: true, label: "Send payment reminders" });
      expect(c.commands.find((x) => x.id === "dispute.makeOffer")).toMatchObject({ dial: "ask", canAuto: false });
      expect(c.commands.some((x) => x.id === "merchant.ask")).toBe(false);
    });

    it("sets a dial and the undo window, and logs each change", async () => {
      const out = await updateControls(pool, DEMO_MERCHANT, { dials: { "invoice.sendReminder": "auto" }, undoSeconds: 30 });
      expect(out.ok && out.controls.commands.find((x) => x.id === "invoice.sendReminder")?.dial).toBe("auto");
      expect(out.ok && out.controls.undoSeconds).toBe(30);
      const log = await pool.query("select summary from activity_log where actor = 'merchant' order by at desc limit 2");
      expect(log.rows.map((r) => r.summary).sort()).toEqual(['"Send payment reminders" set to Auto', "Undo window set to 30 s"]);
    });

    it("refuses Auto for a never-Auto action, an unknown action and a bad undo window, changing nothing", async () => {
      expect(await updateControls(pool, DEMO_MERCHANT, { dials: { "dispute.makeOffer": "auto" } })).toEqual({
        ok: false,
        error: '"Offer refunds in disputes" always needs your approval; it can\'t be Auto',
      });
      expect(await updateControls(pool, DEMO_MERCHANT, { dials: { "merchant.ask": "off" } })).toEqual({ ok: false, error: "merchant.ask has no dial" });
      expect(await updateControls(pool, DEMO_MERCHANT, { undoSeconds: 601 })).toMatchObject({ ok: false });
      // All or nothing: a good dial next to a bad one isn't saved either.
      await updateControls(pool, DEMO_MERCHANT, { dials: { "invoice.sendReminder": "off", "invoice.cancel": "auto" } });
      expect((await getControls(pool, DEMO_MERCHANT)).commands.find((x) => x.id === "invoice.sendReminder")?.dial).toBe("ask");
    });

    it("the kill switch from the panel stops Approve", async () => {
      const id = await stored(friendlyReminder());
      await updateControls(pool, DEMO_MERCHANT, { killSwitch: true });
      expect((await approve(id)).status).toBe("paused");
      expect(sent).toEqual([]);
      await updateControls(pool, DEMO_MERCHANT, { killSwitch: false });
      expect((await approve(id)).status).toBe("executed");
    });
  });

  describe("answering a question card", () => {
    it("the answer closes the question and runs the skill again with it", async () => {
      const id = await stored(askAnswer());
      expect((await card(id)).front.options).toEqual(["Send one more reminder", "Wait a week"]);
      const agent = new ScriptedAgentClient([friendlyReminder()]);
      const out = await answerCard({ pool, read, agent, now: () => NOW }, DEMO_MERCHANT, id, 0);
      expect(out).toMatchObject({ status: "answered", message: "Thanks. Pyp made 1 new card." });
      // Inside <merchant-instruction>, XML-escaped like any merchant text.
      expect(agent.requests[0].turn).toContain(
        "<merchant-instruction>My answer to your question &quot;Sam hasn't paid invoice 0042. What should Pyp do?&quot;: Send one more reminder</merchant-instruction>",
      );
      expect((await card(id)).state).toBe("executed");
      expect((await card(id)).front.reason).toBe("You answered: Send one more reminder");
    });

    it("a question can be answered once, and only with one of its options", async () => {
      const id = await stored(askAnswer());
      const deps = { pool, read, agent: new ScriptedAgentClient([friendlyReminder()]), now: () => NOW };
      expect((await answerCard(deps, DEMO_MERCHANT, id, 5)).status).toBe("bad_option");
      expect((await answerCard(deps, DEMO_MERCHANT, id, 1)).status).toBe("answered");
      expect((await answerCard(deps, DEMO_MERCHANT, id, 0)).status).toBe("not_waiting");
    });

    it("Approve can't be used on a question", async () => {
      const id = await stored(askAnswer());
      expect((await approve(id)).status).toBe("not_waiting");
    });
  });
});
