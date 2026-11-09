import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { newSlackCode, handleSlash } from "./connections";
import { APPROVE_IN_SLACK, botBlocks, chatInDm, handleAction, handleMessageEvent, syncSlackDms, type BotCard, type SlackApi } from "./slack-bot";
import { saveNotice } from "./store";
import { DEMO_MERCHANT, TEST_DB_URL, freshDatabase } from "./test-db";

const NOW = new Date("2026-11-09T18:00:00Z");
const base: BotCard = {
  id: "11111111-1111-1111-1111-111111111111",
  skill: "collections",
  state: "awaiting_approval",
  createdAt: NOW.toISOString(),
  commandId: "invoice.sendReminder",
  front: { eyebrow: "Invoices", title: "Remind <@U999> Acme", amount: { value: "1,200.00", currency: "USD" }, reason: "You asked to approve these" },
};
const ids = (blocks: Record<string, unknown>[]) =>
  ((blocks.find((b) => b.type === "actions")?.elements ?? []) as { action_id: string }[]).map((e) => e.action_id);

describe("Slack bot: what each card's DM offers", () => {
  it("a reminder can be approved or dismissed in Slack; model text can't mention anyone", () => {
    const b = botBlocks(base, "https://pyp/#/inbox");
    expect(ids(b)).toEqual(["pyp_approve", "pyp_dismiss", "pyp_open"]);
    expect(JSON.stringify(b)).not.toContain("<@U999>");
  });

  it("anything that moves money or answers a dispute: Review in Pyp only (and Dismiss)", () => {
    for (const commandId of ["invoice.createAndSend", "invoice.cancel", "dispute.makeOffer", "dispute.acceptClaim", "dispute.provideEvidence", "invoice.suggestAutoReminders"]) {
      expect(APPROVE_IN_SLACK.has(commandId)).toBe(false);
      const b = botBlocks({ ...base, commandId }, "https://pyp");
      expect(ids(b)).toEqual(["pyp_dismiss", "pyp_open"]);
      expect(JSON.stringify(b)).toContain("you approve it in Pyp");
    }
  });

  it("a question with no answer buttons asks for a reply, never 'moves money'", () => {
    const b = botBlocks({ ...base, commandId: "merchant.ask", front: { title: "What's Acme's email?" } }, "x");
    expect(ids(b)).toEqual(["pyp_dismiss", "pyp_open"]);
    expect(JSON.stringify(b)).toContain("Pyp has a question");
    expect(JSON.stringify(b)).toContain("reply here with the answer");
    expect(JSON.stringify(b)).not.toContain("moves money");
  });

  it("a question gets its answers as buttons; an Auto action gets Undo; a decided card gets no buttons", () => {
    expect(ids(botBlocks({ ...base, commandId: "merchant.ask", front: { ...base.front, options: ["Send it", "Wait"] } }, "x"))).toEqual(["pyp_answer_0", "pyp_answer_1", "pyp_dismiss", "pyp_open"]);
    expect(ids(botBlocks({ ...base, state: "scheduled" }, "x"))).toEqual(["pyp_undo", "pyp_open"]);
    const done = botBlocks({ ...base, state: "executed" }, "x", "✅ Done");
    expect(ids(done)).toEqual(["pyp_open"]);
    expect(JSON.stringify(done)).toContain("✅ Done");
  });
});

describe.skipIf(!TEST_DB_URL)("Slack bot (Postgres)", () => {
  let pool: Pool;
  let drop: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, drop } = await freshDatabase());
  });
  afterAll(async () => drop?.());
  beforeEach(async () => {
    await pool.query("delete from slack_links");
    await pool.query("delete from slack_messages");
    await pool.query("delete from slack_threads");
  });

  const me = { teamId: "T1", teamDomain: "acme-studio", userId: "U1", userName: "maya" };
  async function link() {
    const { code } = await newSlackCode(pool, DEMO_MERCHANT, NOW);
    await handleSlash({ pool, now: NOW, chat: async () => "", runSkill: async () => null }, { ...me, text: `connect ${code}` });
  }
  async function newCard(title: string, state = "awaiting_approval", command = "invoice.sendReminder") {
    const id = await saveNotice(pool, { merchantId: DEMO_MERCHANT, subject: { kind: "invoice", id: "INV-1" }, trigger: "test", title, subtitle: "", body: "", reason: "" });
    const run = (await pool.query("select run_id from cards where id = $1", [id])).rows[0].run_id;
    const p = await pool.query(
      "insert into proposals (run_id, merchant_id, command_id, params_json, why, status) values ($1, $2, $3, '{}', 'test', $4) returning id",
      [run, DEMO_MERCHANT, command, state],
    );
    await pool.query("update cards set state = $2, proposal_id = $3, created_at = now() where id = $1", [id, state, p.rows[0].id]);
    return id as string;
  }
  function fakeSlack() {
    const calls: { method: string; body: Record<string, unknown> }[] = [];
    let n = 0;
    const slack: SlackApi = async (method, body) => {
      calls.push({ method, body });
      if (method === "conversations.open") return { ok: true, channel: { id: "D1" } };
      return { ok: true, ts: `1700000000.00${++n}` };
    };
    return { calls, slack };
  }

  it("DMs each new card once, and updates the DM when the card is decided in Pyp", async () => {
    await link();
    const id = await newCard("Remind Acme");
    const { calls, slack } = fakeSlack();
    const deps = { pool, slack, link: () => "https://pyp/#/inbox" };
    expect(await syncSlackDms(deps)).toMatchObject({ posted: 1, updated: 0, failed: [] });
    expect(calls.map((c) => c.method)).toEqual(["conversations.open", "chat.postMessage"]);
    expect(await syncSlackDms(deps)).toMatchObject({ posted: 0, updated: 0 });

    await pool.query("update cards set state = 'rejected' where id = $1", [id]);
    expect(await syncSlackDms(deps)).toMatchObject({ posted: 0, updated: 1 });
    const update = calls.at(-1)!;
    expect(update).toMatchObject({ method: "chat.update", body: { channel: "D1", ts: "1700000000.001" } });
    expect(JSON.stringify(update.body.blocks)).toContain("Dismissed. Nothing was sent.");
    expect(await syncSlackDms(deps)).toMatchObject({ updated: 0 });
  });

  it("a DM that Slack refuses goes back in the queue; a deleted DM stops being updated", async () => {
    await link();
    const id = await newCard("Remind Acme");
    let fail = true;
    const { calls, slack: ok } = fakeSlack();
    const flaky: SlackApi = async (method, body) => {
      if (fail && method === "chat.postMessage") throw new Error("Slack chat.postMessage: ratelimited");
      return ok(method, body);
    };
    const deps = { pool, slack: flaky, link: () => "https://pyp" };
    expect((await syncSlackDms(deps)).posted).toBe(0);
    fail = false;
    expect((await syncSlackDms(deps)).posted).toBe(1); // retried on the next tick

    await pool.query("update cards set state = 'rejected' where id = $1", [id]);
    const gone: SlackApi = async (method, body) => {
      if (method === "chat.update") throw new Error("Slack chat.update: message_not_found");
      return ok(method, body);
    };
    expect((await syncSlackDms({ ...deps, slack: gone })).failed).toHaveLength(1);
    expect((await syncSlackDms({ ...deps, slack: gone })).failed).toHaveLength(0); // not tried again
    expect(calls.filter((c) => c.method === "chat.postMessage")).toHaveLength(1);
  });

  it("buttons: only the linked person; Approve only for low-risk actions, checked on the server", async () => {
    await link();
    const reminder = await newCard("Remind Acme");
    const offer = await newCard("Offer a refund", "awaiting_approval", "dispute.makeOffer");
    const done: string[] = [];
    const deps = {
      pool,
      approve: async (_m: string, c: string) => (done.push(`approve:${c}`), { status: "executed", message: "Reminder sent." }),
      dismiss: async (_m: string, c: string) => (done.push(`dismiss:${c}`), true),
      undo: async () => false,
      answer: async () => ({ status: "answered", message: "" }),
    };
    const click = (actionId: string, card: string, userId = "U1") => handleAction(deps, { teamId: "T1", userId, actionId, value: JSON.stringify({ card }) });

    expect(await click("pyp_approve", reminder, "U2")).toMatch(/Only maya can do this/);
    expect(await click("pyp_approve", offer)).toBe("This one needs your approval in Pyp."); // a forged button for a money action
    expect(await click("pyp_approve", reminder)).toBe("✅ Reminder sent.");
    expect(await click("pyp_dismiss", offer)).toBe("Dismissed. Nothing was sent.");
    expect(await click("pyp_undo", reminder)).toBe("Too late to undo: this already ran.");
    expect(done).toEqual([`approve:${reminder}`, `dismiss:${offer}`]);
  });

  it("talking to Pyp: a DM is one conversation, follow-ups carry it, /pyp joins it, resends are ignored", async () => {
    await link();
    const { calls, slack } = fakeSlack();
    const seen: { text: string; history: unknown[] }[] = [];
    const deps = {
      pool,
      slack,
      botUserId: "UBOT",
      chat: async (_m: string, text: string, history: unknown[]) => (seen.push({ text, history }), { reply: `Drafted: ${text}`, cardIds: ["c1"], waiting: false }),
    };
    const dm = { teamId: "T1", type: "message", channelType: "im", channel: "D1", user: "U1", text: "invoice Acme $450", ts: "1.1", eventId: "Ev1" };
    await (await handleMessageEvent(deps, dm))!();
    expect(calls[0]).toMatchObject({ method: "chat.postMessage", body: { channel: "D1" } });
    expect(calls[0].body.thread_ts).toBeUndefined(); // a DM answers like a chat, not in a thread
    expect(await handleMessageEvent(deps, dm)).toBeNull(); // Slack resent it

    await (await handleMessageEvent(deps, { ...dm, eventId: "Ev2", ts: "1.2", text: "actually make it $500" }))!();
    expect(seen[1].history).toEqual([
      { from: "merchant", text: "invoice Acme $450" },
      { from: "pyp", text: "Drafted: invoice Acme $450", waiting: false, cardIds: ["c1"] },
    ]);

    // An @mention in a channel: the mention comes out of the text, and only the asker sees the answer.
    await (await handleMessageEvent(deps, { ...dm, eventId: "Ev3", type: "app_mention", channelType: "channel", channel: "C1", ts: "2.1", text: "<@UBOT> remind Acme" }))!();
    expect(seen[2].text).toBe("remind Acme");
    expect(calls.at(-1)).toMatchObject({ method: "chat.postEphemeral", body: { channel: "C1", user: "U1" } });
    expect(await handleMessageEvent(deps, { ...dm, eventId: "" })).toBeNull();

    // Someone else, Pyp's own messages, and channel chatter are ignored or refused.
    expect(await handleMessageEvent(deps, { ...dm, eventId: "Ev4", botId: "B1" })).toBeNull();
    expect(await handleMessageEvent(deps, { ...dm, eventId: "Ev5", type: "message", channelType: "channel" })).toBeNull();
    await (await handleMessageEvent(deps, { ...dm, eventId: "Ev6", user: "U2" }))!();
    expect(String(calls.at(-1)!.body.text)).toMatch(/Only maya can do this/);
    expect(seen).toHaveLength(3);

    // /pyp joins the DM conversation (its dm_channel is D1 after the first card DM; set it here).
    await pool.query("update slack_links set dm_channel = 'D1' where merchant_id = $1", [DEMO_MERCHANT]);
    await chatInDm(pool, DEMO_MERCHANT, "acme@example.com", deps.chat);
    expect(seen[3].history).toHaveLength(4); // the two DM turns before it
  });
});
