// Connections (db/migrations/015_connections.sql): Pyp in the merchant's other apps.
//
// Outbound: when a card needs the merchant, the worker posts it to their Slack
// or Discord channel, or sends signed JSON to any app (n8n, Zapier, Make…).
// Each message links to the card in Pyp. Nothing here can approve anything:
// approving, editing and undoing always happen in Pyp.
//
// Inbound (Slack): /pyp talks to Pyp like the chat does, so it can only make
// cards, or runs a custom skill. Only the Slack person who linked the
// workspace can use it, and every request is checked against Slack's
// signing secret (lib/slack.ts).

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import type { Pool } from "pg";

type Db = Pick<Pool, "query">;

export const KINDS = ["slack", "discord", "webhook"] as const;
export type ConnectionKind = (typeof KINDS)[number];

export interface Connection {
  id: string;
  kind: ConnectionKind;
  url: string;
  secret: string | null;
  enabled: boolean;
  lastStatus: string | null;
  lastSentAt: string | null;
  createdAt: string;
}

/** What the page sees: never the whole URL or secret. */
export function masked(c: Connection) {
  const u = new URL(c.url);
  const tail = c.url.slice(-4);
  return { id: c.id, kind: c.kind, enabled: c.enabled, where: `${u.hostname}/…${tail}`, lastStatus: c.lastStatus, lastSentAt: c.lastSentAt, createdAt: c.createdAt };
}

export function missingConnectionsTable(err: unknown): boolean {
  return (err as { code?: string }).code === "42P01";
}

const COLUMNS = "id, kind, url, secret, enabled, last_status, last_sent_at, created_at";
const iso = (v: unknown) => (v ? new Date(v as string).toISOString() : null);
function toConnection(r: Record<string, unknown>): Connection {
  return {
    id: String(r.id),
    kind: r.kind as ConnectionKind,
    url: String(r.url),
    secret: (r.secret as string | null) ?? null,
    enabled: r.enabled === true,
    lastStatus: (r.last_status as string | null) ?? null,
    lastSentAt: iso(r.last_sent_at),
    createdAt: iso(r.created_at)!,
  };
}

/**
 * Is this the right kind of URL for this connection? Slack and Discord only take
 * their own webhook addresses. "Any app" takes any https address that isn't on
 * this machine or a private network (so Pyp can't be pointed at itself).
 */
export function urlProblem(kind: ConnectionKind, raw: string): string | null {
  let u: URL;
  try {
    u = new URL(raw.trim());
  } catch {
    return "That isn't a web address.";
  }
  if (u.protocol !== "https:") return "Use an https:// address.";
  if (kind === "slack") return u.hostname === "hooks.slack.com" && u.pathname.startsWith("/services/") ? null : "Use the Incoming Webhook URL from your Slack app (https://hooks.slack.com/services/…).";
  if (kind === "discord") {
    return (u.hostname === "discord.com" || u.hostname === "discordapp.com") && u.pathname.startsWith("/api/webhooks/")
      ? null
      : "Use a channel webhook URL from Discord (Channel settings → Integrations → Webhooks).";
  }
  const host = u.hostname.toLowerCase();
  const privateHost =
    host === "localhost" ||
    host.endsWith(".localhost") ||
    host.endsWith(".internal") ||
    host === "metadata.google.internal" ||
    /^\[?(::1|fc|fd|fe80)/i.test(host) ||
    /^(127\.|10\.|192\.168\.|169\.254\.|0\.)/.test(host) ||
    /^172\.(1[6-9]|2\d|3[01])\./.test(host);
  return privateHost ? "Use a public https address (your n8n, Zapier or Make webhook)." : null;
}

export async function listConnections(db: Db, merchantId: string): Promise<Connection[]> {
  const res = await db.query(`select ${COLUMNS} from connections where merchant_id = $1 order by created_at`, [merchantId]);
  return res.rows.map(toConnection);
}

/**
 * Adds or replaces a connection. "Any app" gets a fresh signing secret, which
 * is returned this once so the merchant can paste it into n8n / Zapier.
 */
export async function saveConnection(db: Db, merchantId: string, kind: ConnectionKind, url: string): Promise<{ connection: Connection; secret: string | null } | { error: string }> {
  const problem = urlProblem(kind, url);
  if (problem) return { error: problem };
  const secret = kind === "webhook" ? randomBytes(24).toString("hex") : null;
  const res = await db.query(
    `insert into connections (merchant_id, kind, url, secret) values ($1, $2, $3, $4)
     on conflict (merchant_id, kind) do update set url = $3, secret = $4, enabled = true, last_status = null, last_sent_at = null, updated_at = now(), created_at = now()
     returning ${COLUMNS}`,
    [merchantId, kind, url.trim(), secret],
  );
  return { connection: toConnection(res.rows[0]), secret };
}

export async function setConnectionEnabled(db: Db, merchantId: string, kind: ConnectionKind, enabled: boolean): Promise<Connection | null> {
  const res = await db.query(`update connections set enabled = $3, updated_at = now() where merchant_id = $1 and kind = $2 returning ${COLUMNS}`, [merchantId, kind, enabled]);
  return res.rows[0] ? toConnection(res.rows[0]) : null;
}

export async function deleteConnection(db: Db, merchantId: string, kind: ConnectionKind): Promise<boolean> {
  const res = await db.query("delete from connections where merchant_id = $1 and kind = $2", [merchantId, kind]);
  return res.rowCount === 1;
}

// ---------- Messages ----------

/** The parts of a card a message needs (cards.front_json plus a few columns). */
export interface CardForPost {
  id: string;
  skill: string;
  state: string;
  createdAt: string;
  front: { eyebrow?: string; title?: string; subtitle?: string; body?: string; amount?: { value: string; currency: string }; reason?: string; options?: string[]; runsAt?: string };
}

const money = (a?: { value: string; currency: string }) => (a ? `${a.currency} ${a.value}` : "");
const clip = (s: string | undefined, n: number) => (!s ? "" : s.length > n ? `${s.slice(0, n - 1)}…` : s);

/** Slack mrkdwn: escape &, < and >, so no text can become a link or an @channel. */
const slackText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

function headline(card: CardForPost): string {
  const auto = card.state === "scheduled";
  return auto ? "Pyp will do this unless you tap Undo" : card.front.options?.length ? "Pyp has a question for you" : "Pyp needs your OK";
}

export function slackMessage(card: CardForPost, link: string) {
  const f = card.front;
  const line2 = [f.subtitle, money(f.amount)].filter(Boolean).join(" · ");
  const fallback = `${headline(card)}: ${f.title ?? "a new card"}`;
  return {
    text: slackText(fallback),
    blocks: [
      { type: "context", elements: [{ type: "mrkdwn", text: slackText(`*${headline(card)}* · ${f.eyebrow ?? card.skill}`) }] },
      { type: "section", text: { type: "mrkdwn", text: slackText(`*${clip(f.title, 150)}*${line2 ? `\n${clip(line2, 200)}` : ""}${f.body ? `\n${clip(f.body, 500)}` : ""}`) } },
      ...(f.reason ? [{ type: "context", elements: [{ type: "mrkdwn", text: slackText(clip(f.reason, 200)) }] }] : []),
      { type: "actions", elements: [{ type: "button", text: { type: "plain_text", text: "Open in Pyp" }, url: link, style: "primary" }] },
    ],
  };
}

export function discordMessage(card: CardForPost, link: string) {
  const f = card.front;
  return {
    username: "Pyp",
    // Nothing in a card can ping anyone (@everyone, roles, users).
    allowed_mentions: { parse: [] as string[] },
    embeds: [
      {
        title: clip(f.title ?? "A new card", 250),
        url: link,
        description: clip([f.subtitle, money(f.amount), f.body].filter(Boolean).join("\n"), 1500),
        color: card.state === "scheduled" ? 0x0e7a50 : 0x1747b8,
        author: { name: `${headline(card)} · ${f.eyebrow ?? card.skill}` },
        footer: f.reason ? { text: clip(f.reason, 200) } : undefined,
        timestamp: card.createdAt,
      },
    ],
  };
}

/** "Any app": plain JSON, the same every time, for n8n / Zapier / Make to map. */
export function webhookEvent(card: CardForPost, link: string) {
  const f = card.front;
  return {
    event: "card.created",
    card: {
      id: card.id,
      skill: card.skill,
      state: card.state,
      needs: card.state === "scheduled" ? "nothing (runs on Auto unless you tap Undo)" : f.options?.length ? "an answer" : "your approval",
      title: f.title ?? null,
      subtitle: f.subtitle ?? null,
      body: f.body ?? null,
      amount: f.amount ?? null,
      reason: f.reason ?? null,
      options: f.options ?? [],
      createdAt: card.createdAt,
    },
    url: link,
  };
}

/** The signature an app checks: hex HMAC-SHA256 of "<timestamp>.<body>" with the secret. */
export function signWebhook(secret: string, timestamp: string, body: string): string {
  return createHmac("sha256", secret).update(`${timestamp}.${body}`).digest("hex");
}

export type Fetcher = (url: string, init: { method: string; headers: Record<string, string>; body: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number; text(): Promise<string> }>;

/** Sends one card to one connection. Never throws: says what happened. */
export async function postCard(fetcher: Fetcher, c: Connection, card: CardForPost, link: string, now: Date): Promise<{ ok: boolean; status: string }> {
  const payload = c.kind === "slack" ? slackMessage(card, link) : c.kind === "discord" ? discordMessage(card, link) : webhookEvent(card, link);
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "Pyp-Connections/1" };
  if (c.kind === "webhook" && c.secret) {
    const ts = String(Math.floor(now.getTime() / 1000));
    headers["X-Pyp-Timestamp"] = ts;
    headers["X-Pyp-Signature"] = `sha256=${signWebhook(c.secret, ts, body)}`;
  }
  try {
    const res = await fetcher(c.url, { method: "POST", headers, body, signal: AbortSignal.timeout(10_000) });
    if (res.ok) return { ok: true, status: "Sent" };
    const why = (await res.text().catch(() => "")).slice(0, 120);
    return { ok: false, status: `Failed (${res.status}${why ? `: ${why}` : ""})` };
  } catch (err) {
    return { ok: false, status: `Failed: ${(err as Error).message}`.slice(0, 160) };
  }
}

async function markSent(db: Db, id: string, status: string, now: Date) {
  await db.query("update connections set last_status = $2, last_sent_at = $3 where id = $1", [id, status, now]);
}

/** A sample card, for "Send a test". */
export const TEST_CARD = (now: Date): CardForPost => ({
  id: "00000000-0000-0000-0000-000000000000",
  skill: "collections",
  state: "awaiting_approval",
  createdAt: now.toISOString(),
  front: {
    eyebrow: "Invoices · test",
    title: "Remind Acme Studio about invoice 0042",
    subtitle: "Acme Studio · 7 days late",
    amount: { value: "1,200.00", currency: "USD" },
    body: "This is a test from Pyp's Connections. Real cards look like this.",
    reason: "A test message: nothing was proposed and nothing will be sent.",
  },
});

export async function sendTest(db: Db, fetcher: Fetcher, merchantId: string, kind: ConnectionKind, link: string, now: Date) {
  const c = (await listConnections(db, merchantId)).find((x) => x.kind === kind);
  if (!c) return null;
  const out = await postCard(fetcher, c, TEST_CARD(now), link, now);
  await markSent(db, c.id, out.ok ? "Test sent" : out.status, now);
  return out;
}

/** Cards posted per connection per tick, so a backlog never floods a channel. */
export const POST_LIMIT = 10;

/**
 * The worker's check: posts each new card that needs the merchant to each of
 * their connections that's on, once. Only cards made after the connection was
 * added, waiting for the merchant (or in their undo window). A failed post is
 * not retried (it says why on the Connections list); the card is in the Inbox anyway.
 */
export async function postNewCards(deps: { pool: Pool; fetcher: Fetcher; link: (cardId: string) => string; now?: () => Date; merchantIds?: string[] }) {
  const now = (deps.now ?? (() => new Date()))();
  let conns;
  try {
    conns = await deps.pool.query(
      `select ${COLUMNS}, merchant_id from connections where enabled ${deps.merchantIds ? "and merchant_id = any($1::uuid[])" : ""}`,
      deps.merchantIds ? [deps.merchantIds] : [],
    );
  } catch (err) {
    if (missingConnectionsTable(err)) return [];
    throw err;
  }
  const done: { kind: ConnectionKind; cardId: string; ok: boolean; status: string }[] = [];
  for (const row of conns.rows as Record<string, unknown>[]) {
    const c = toConnection(row);
    const cards = await deps.pool.query(
      `select k.id, k.skill, k.state, k.front_json, k.created_at from cards k
        where k.merchant_id = $1 and k.state in ('awaiting_approval', 'scheduled') and k.created_at >= $2
          and not exists (select 1 from connection_posts p where p.connection_id = $3 and p.card_id = k.id)
        order by k.created_at limit $4`,
      [row.merchant_id, c.createdAt, c.id, POST_LIMIT],
    );
    for (const k of cards.rows as Record<string, unknown>[]) {
      const claimed = await deps.pool.query("insert into connection_posts (connection_id, card_id) values ($1, $2) on conflict do nothing returning card_id", [c.id, k.id]);
      if (!claimed.rows[0]) continue; // another worker has it
      const card: CardForPost = { id: String(k.id), skill: String(k.skill), state: String(k.state), createdAt: iso(k.created_at)!, front: (k.front_json ?? {}) as CardForPost["front"] };
      const out = await postCard(deps.fetcher, c, card, deps.link(card.id), now);
      await markSent(deps.pool, c.id, out.status, now);
      done.push({ kind: c.kind, cardId: card.id, ...out });
    }
  }
  return done;
}

// ---------- Slack: /pyp ----------

/** Slack signs every request: v0=hex(HMAC-SHA256(signing secret, "v0:<timestamp>:<raw body>")). */
export function verifySlackRequest(signingSecret: string, timestamp: string | null, rawBody: string, signature: string | null, now: Date): boolean {
  if (!timestamp || !signature || !/^\d+$/.test(timestamp)) return false;
  // Older than five minutes: a replay.
  if (Math.abs(now.getTime() / 1000 - Number(timestamp)) > 300) return false;
  const want = `v0=${createHmac("sha256", signingSecret).update(`v0:${timestamp}:${rawBody}`).digest("hex")}`;
  const a = Buffer.from(want);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

const CODE_CHARS = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // no 0/O or 1/I
export const CODE_MINUTES = 15;

export async function newSlackCode(db: Db, merchantId: string, now: Date): Promise<{ code: string; expiresAt: string }> {
  const bytes = randomBytes(8);
  const code = Array.from(bytes, (b) => CODE_CHARS[b % CODE_CHARS.length]).join("");
  const expires = new Date(now.getTime() + CODE_MINUTES * 60_000);
  await db.query(
    `insert into slack_links (merchant_id, connect_code, connect_code_expires_at) values ($1, $2, $3)
     on conflict (merchant_id) do update set connect_code = $2, connect_code_expires_at = $3, updated_at = now()`,
    [merchantId, code, expires],
  );
  return { code, expiresAt: expires.toISOString() };
}

export async function slackLink(db: Db, merchantId: string) {
  const res = await db.query("select team_id, team_name, slack_user_name, linked_at from slack_links where merchant_id = $1", [merchantId]);
  const r = res.rows[0];
  return r?.team_id ? { teamName: String(r.team_name ?? r.team_id), userName: String(r.slack_user_name ?? ""), linkedAt: iso(r.linked_at) } : null;
}

export async function unlinkSlack(db: Db, merchantId: string): Promise<void> {
  await db.query("delete from slack_links where merchant_id = $1", [merchantId]);
}

export interface SlashCommand {
  teamId: string;
  teamDomain: string;
  userId: string;
  userName: string;
  text: string;
}

export interface SlashDeps {
  pool: Pool;
  now: Date;
  /** The chat receptionist for this merchant: its reply. */
  chat: (merchantId: string, text: string) => Promise<string>;
  /** Run a custom skill now by its name: what happened, or null when there's no such skill. */
  runSkill: (merchantId: string, name: string) => Promise<string | null>;
}

export const SLASH_HELP = [
  "*Talk to Pyp from Slack.* Anything Pyp proposes waits in your Pyp Inbox for your OK.",
  "• `/pyp invoice Acme $450 for product photos`",
  "• `/pyp remind Acme about invoice 0042`",
  "• `/pyp run Friday cleanup`: run one of your custom skills now",
  "• `/pyp disconnect`: unlink this workspace",
].join("\n");

/**
 * One /pyp command. `reply` goes straight back to Slack (within its 3 s);
 * `later`, when set, is the slow part (a model call), posted when it's done.
 */
export async function handleSlash(deps: SlashDeps, cmd: SlashCommand): Promise<{ reply: string; later?: () => Promise<string> }> {
  const text = cmd.text.trim();
  const connect = /^connect\s+([A-Za-z0-9]{6,12})$/.exec(text);
  if (connect) {
    const code = connect[1].toUpperCase();
    try {
      const res = await deps.pool.query(
        `update slack_links set team_id = $2, team_name = $3, slack_user_id = $4, slack_user_name = $5, linked_at = $6,
                connect_code = null, connect_code_expires_at = null, updated_at = now()
          where connect_code = $1 and connect_code_expires_at > $6
          returning (select name from merchants m where m.id = slack_links.merchant_id) as merchant_name`,
        [code, cmd.teamId, cmd.teamDomain, cmd.userId, cmd.userName, deps.now],
      );
      if (!res.rows[0]) return { reply: "That code didn't work. In Pyp, open Setup → Connections → Slack and get a new one (codes last 15 minutes)." };
      return { reply: `Linked to *${slackText(String(res.rows[0].merchant_name))}* in Pyp. Only you can use /pyp here.\n${SLASH_HELP}` };
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return { reply: "This Slack workspace is already linked to a Pyp account. Unlink it there first (/pyp disconnect)." };
      throw err;
    }
  }

  const link = await deps.pool.query("select merchant_id, slack_user_id, slack_user_name from slack_links where team_id = $1", [cmd.teamId]);
  const row = link.rows[0];
  if (!row) return { reply: "This Slack workspace isn't linked to Pyp yet. In Pyp, open Setup → Connections → Slack, tap *Link Slack*, then type `/pyp connect CODE` here." };
  if (row.slack_user_id !== cmd.userId) return { reply: `Only ${slackText(String(row.slack_user_name || "the person who linked Pyp"))} can use /pyp in this workspace.` };
  const merchantId = String(row.merchant_id);

  if (!text || /^help$/i.test(text)) return { reply: SLASH_HELP };
  if (/^disconnect$/i.test(text)) {
    await unlinkSlack(deps.pool, merchantId);
    return { reply: "Unlinked. /pyp won't reach your Pyp account any more." };
  }
  const run = /^run\s+(.{1,60})$/i.exec(text);
  if (run) {
    const name = run[1].trim();
    return {
      reply: `Running your skill “${slackText(name)}”…`,
      later: async () => (await deps.runSkill(merchantId, name)) ?? `You don't have a skill called “${slackText(name)}”. Your skills are on the My skills page in Pyp.`,
    };
  }
  return { reply: `On it: “${slackText(clip(text, 200))}”`, later: async () => slackText(await deps.chat(merchantId, text.slice(0, 1000))) };
}
