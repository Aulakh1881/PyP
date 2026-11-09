import { createHmac } from "node:crypto";
import type { Pool } from "pg";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  discordMessage,
  handleSlash,
  listConnections,
  newSlackCode,
  postNewCards,
  saveConnection,
  setConnectionEnabled,
  signWebhook,
  slackLink,
  slackMessage,
  urlProblem,
  verifySlackRequest,
  webhookEvent,
  type CardForPost,
  type Fetcher,
} from "./connections";
import { saveNotice } from "./store";
import { DEMO_MERCHANT, TEST_DB_URL, freshDatabase } from "./test-db";

const NOW = new Date("2026-11-09T18:00:00Z");
const publicDns = async () => [{ address: "93.184.216.34" }];
const privateDns = async () => [{ address: "127.0.0.1" }];
const card: CardForPost = {
  id: "c1",
  skill: "collections",
  state: "awaiting_approval",
  createdAt: NOW.toISOString(),
  front: { eyebrow: "Invoices · NEEDS YOU", title: "Remind <!channel> Acme & co", subtitle: "Acme", amount: { value: "1,200.00", currency: "USD" }, reason: "You asked to approve these" },
};

describe("connections: URLs, messages and signatures", () => {
  it("takes only the right kind of URL", () => {
    expect(urlProblem("slack", "https://hooks.slack.com/services/T1/B2/x")).toBeNull();
    expect(urlProblem("slack", "https://example.com/x")).toMatch(/Incoming Webhook/);
    expect(urlProblem("discord", "https://discord.com/api/webhooks/1/abc")).toBeNull();
    expect(urlProblem("discord", "http://discord.com/api/webhooks/1/abc")).toMatch(/https/);
    expect(urlProblem("webhook", "https://n8n.example.com/webhook/pyp")).toBeNull();
    for (const bad of [
      "https://localhost/x",
      "https://localhost./x",
      "https://redis/x",
      "https://127.0.0.1/x",
      "https://2130706433/x",
      "https://10.0.0.5/x",
      "https://192.168.1.2/x",
      "https://169.254.169.254/latest",
      "https://100.100.100.200/x",
      "https://[::1]/x",
      "https://[::]/x",
      "https://[::ffff:127.0.0.1]/x",
      "https://[::ffff:a9fe:a9fe]/x",
      "https://[fd00::1]/x",
      "https://[fec0::1]/x",
    ]) {
      expect(urlProblem("webhook", bad), bad).toMatch(/public/);
    }
    expect(urlProblem("webhook", "https://fdic.gov/hook")).toBeNull(); // a real name that starts with "fd"
    expect(urlProblem("discord", "https://canary.discord.com/api/webhooks/1/abc")).toBeNull();
  });

  it("Slack: model text can't become a link or an @channel; the button opens Pyp", () => {
    const m = slackMessage(card, "https://pyp.example/app/#/inbox");
    const all = JSON.stringify(m);
    expect(all).not.toContain("<!channel>");
    expect(all).toContain("&lt;!channel&gt; Acme &amp; co");
    expect(m.blocks.at(-1)).toMatchObject({ type: "actions", elements: [{ text: { text: "Open in Pyp" }, url: "https://pyp.example/app/#/inbox" }] });
  });

  it("Discord: nothing can ping anyone; any app: plain JSON with what it needs", () => {
    expect(discordMessage(card, "https://x").allowed_mentions).toEqual({ parse: [] });
    expect(webhookEvent(card, "https://x")).toMatchObject({ event: "card.created", card: { id: "c1", needs: "your approval", amount: { value: "1,200.00" } }, url: "https://x" });
  });

  it("verifies Slack's signature, and refuses old or forged requests", () => {
    const secret = "shh";
    const body = "team_id=T1&text=hi";
    const ts = String(Math.floor(NOW.getTime() / 1000));
    const sig = `v0=${createHmac("sha256", secret).update(`v0:${ts}:${body}`).digest("hex")}`;
    expect(verifySlackRequest(secret, ts, body, sig, NOW)).toBe(true);
    expect(verifySlackRequest(secret, ts, body + "x", sig, NOW)).toBe(false);
    expect(verifySlackRequest("other", ts, body, sig, NOW)).toBe(false);
    expect(verifySlackRequest(secret, ts, body, sig, new Date(NOW.getTime() + 6 * 60_000))).toBe(false); // a replay
    expect(verifySlackRequest(secret, null, body, sig, NOW)).toBe(false);
  });

  it("signs what goes to any app", () => {
    expect(signWebhook("k", "1", "{}")).toBe(createHmac("sha256", "k").update("1.{}").digest("hex"));
  });
});

describe.skipIf(!TEST_DB_URL)("connections (Postgres)", () => {
  let pool: Pool;
  let drop: (() => Promise<void>) | undefined;
  beforeAll(async () => {
    ({ pool, drop } = await freshDatabase());
  });
  afterAll(async () => drop?.());
  beforeEach(async () => {
    await pool.query("delete from connections");
    await pool.query("delete from slack_links");
  });

  async function newCard(title: string, state = "awaiting_approval") {
    const id = await saveNotice(pool, { merchantId: DEMO_MERCHANT, subject: { kind: "invoice", id: "INV-1" }, trigger: "test", title, subtitle: "", body: "", reason: "" });
    await pool.query("update cards set state = $2, created_at = now() where id = $1", [id, state]);
    return id;
  }

  function recorder(status = 200) {
    const sent: { url: string; headers: Record<string, string>; body: string }[] = [];
    const fetcher: Fetcher = async (url, init) => {
      sent.push({ url, headers: init.headers, body: init.body });
      return { ok: status < 300, status, text: async () => (status < 300 ? "ok" : "no_service") };
    };
    return { sent, fetcher };
  }

  it("posts each new card that needs you to each connection, once; signed for any app", async () => {
    await saveConnection(pool, DEMO_MERCHANT, "slack", "https://hooks.slack.com/services/T/B/x");
    const { secret } = (await saveConnection(pool, DEMO_MERCHANT, "webhook", "https://n8n.example.com/webhook/pyp", publicDns)) as { secret: string };
    const id = await newCard("Remind Acme");
    await newCard("Already done", "executed"); // a heads-up, not something that needs you
    const { sent, fetcher } = recorder();
    const deps = { pool, fetcher, link: () => "https://pyp/app/#/inbox", resolve: publicDns };
    const done = await postNewCards(deps);
    expect(done.map((d) => [d.kind, d.cardId, d.ok])).toEqual([
      ["slack", id, true],
      ["webhook", id, true],
    ]);
    const hook = sent.find((s) => s.url.includes("n8n"))!;
    expect(hook.headers["X-Pyp-Signature"]).toBe(`sha256=${signWebhook(secret, hook.headers["X-Pyp-Timestamp"], hook.body)}`);
    expect(await postNewCards(deps)).toEqual([]); // claimed: never twice
    expect((await listConnections(pool, DEMO_MERCHANT)).every((c) => c.lastStatus === "Sent")).toBe(true);
  });

  it("any app: a name that points at a private address is refused when saved, and again when sending", async () => {
    expect(await saveConnection(pool, DEMO_MERCHANT, "webhook", "https://127-0-0-1.nip.io/x", privateDns)).toEqual({ error: expect.stringMatching(/public/) });
    await saveConnection(pool, DEMO_MERCHANT, "webhook", "https://n8n.example.com/webhook/pyp", publicDns);
    await newCard("Remind Acme");
    const { sent, fetcher } = recorder();
    const done = await postNewCards({ pool, fetcher, link: () => "https://pyp", resolve: privateDns }); // re-pointed since
    expect(done[0]).toMatchObject({ ok: false, status: "Failed: the address isn't public" });
    expect(sent).toHaveLength(0);
  });

  it("switching a connection back on never posts the backlog; one that keeps failing switches itself off", async () => {
    await saveConnection(pool, DEMO_MERCHANT, "discord", "https://discord.com/api/webhooks/1/abc");
    await setConnectionEnabled(pool, DEMO_MERCHANT, "discord", false);
    await newCard("Made while off");
    await setConnectionEnabled(pool, DEMO_MERCHANT, "discord", true);
    const ok = recorder();
    expect(await postNewCards({ pool, fetcher: ok.fetcher, link: () => "https://pyp" })).toEqual([]);

    const bad = recorder(500);
    for (let i = 0; i < 5; i++) {
      await newCard(`Card ${i}`);
      await postNewCards({ pool, fetcher: bad.fetcher, link: () => "https://pyp" });
    }
    const c = (await listConnections(pool, DEMO_MERCHANT))[0];
    expect(c.enabled).toBe(false);
    expect(c.lastStatus).toMatch(/switched off after 5 failures in a row/);
  });

  it("a failed post says why on the list, and isn't retried into a flood", async () => {
    await saveConnection(pool, DEMO_MERCHANT, "discord", "https://discord.com/api/webhooks/1/abc");
    await newCard("Remind Acme");
    const { fetcher } = recorder(404);
    const done = await postNewCards({ pool, fetcher, link: () => "https://pyp" });
    expect(done[0]).toMatchObject({ ok: false, status: "Failed (404: no_service)" });
    expect((await listConnections(pool, DEMO_MERCHANT))[0].lastStatus).toBe("Failed (404: no_service)");
    expect(await postNewCards({ pool, fetcher, link: () => "https://pyp" })).toEqual([]);
  });

  it("/pyp: link with a one-time code; only that person can use it; it routes to chat or a skill", async () => {
    const calls: string[] = [];
    const deps = {
      pool,
      now: NOW,
      chat: async (_m: string, t: string) => (calls.push(`chat:${t}`), "Drafted an invoice for Acme."),
      runSkill: async (_m: string, n: string) => (calls.push(`skill:${n}`), n === "Friday cleanup" ? "Ran it." : null),
    };
    const me = { teamId: "T1", teamDomain: "acme-studio", userId: "U1", userName: "maya", text: "" };

    expect((await handleSlash(deps, { ...me, text: "invoice Acme $450" })).reply).toMatch(/isn't linked to Pyp yet/);
    const { code } = await newSlackCode(pool, DEMO_MERCHANT, NOW);
    expect((await handleSlash({ ...deps, now: new Date(NOW.getTime() + 16 * 60_000) }, { ...me, text: `connect ${code}` })).reply).toMatch(/didn't work/); // expired
    expect((await handleSlash(deps, { ...me, text: `connect ${code.toLowerCase()}` })).reply).toMatch(/^Linked to \*/);
    expect(await slackLink(pool, DEMO_MERCHANT)).toMatchObject({ teamName: "acme-studio", userName: "maya" });
    expect((await handleSlash(deps, { ...me, text: `connect ${code}` })).reply).toMatch(/didn't work/); // used up

    expect((await handleSlash(deps, { ...me, userId: "U2", text: "refund everything" })).reply).toMatch(/Only maya can use/);
    expect(calls).toEqual([]);

    const chat = await handleSlash(deps, { ...me, text: "invoice Acme $450 for product photos" });
    expect(chat.reply).toMatch(/^On it/);
    expect(await chat.later!()).toBe("Drafted an invoice for Acme.");
    expect(await (await handleSlash(deps, { ...me, text: "run Friday cleanup" })).later!()).toBe("Ran it.");
    expect(await (await handleSlash(deps, { ...me, text: "run Nope" })).later!()).toMatch(/don't have a skill called/);
    expect(calls).toEqual(["chat:invoice Acme $450 for product photos", "skill:Friday cleanup", "skill:Nope"]);

    expect((await handleSlash(deps, { ...me, text: "disconnect" })).reply).toMatch(/Unlinked/);
    expect(await slackLink(pool, DEMO_MERCHANT)).toBeNull();
  });
});
