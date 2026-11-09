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
import { lookup as lookupCb, type LookupAddress, type LookupOptions } from "node:dns";
import { lookup } from "node:dns/promises";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
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
    return /^(?:(?:canary|ptb)\.)?discord(?:app)?\.com$/.test(u.hostname) && u.pathname.startsWith("/api/webhooks/")
      ? null
      : "Use a channel webhook URL from Discord (Channel settings → Integrations → Webhooks).";
  }
  if (u.port && u.port !== "443") return "Use the standard https port (no :port in the address).";
  const host = u.hostname.toLowerCase().replace(/\.$/, "").replace(/^\[|\]$/g, "");
  const internalName = host === "localhost" || host.endsWith(".localhost") || host.endsWith(".internal") || host.endsWith(".local") || !host.includes(".") && !isIP(host);
  return internalName || (isIP(host) && privateAddress(host)) ? PUBLIC_ONLY : null;
}

const PUBLIC_ONLY = "Use a public https address (your n8n, Zapier or Make webhook).";

/** Loopback, private, link-local, CGNAT, unique-local, unspecified, IPv4-mapped private: not on the internet. */
export function privateAddress(ip: string): boolean {
  const v = ip.toLowerCase();
  if (isIP(v) === 4) {
    const [a, b, c] = v.split(".").map(Number);
    return (
      a === 0 || a === 10 || a === 127 || a >= 224 || // this network, private, loopback, multicast/reserved/broadcast
      (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) ||
      (a === 100 && b >= 64 && b <= 127) || // carrier-grade NAT (and some clouds' metadata)
      (a === 198 && (b === 18 || b === 19)) || // benchmarking
      (a === 192 && b === 0 && (c === 0 || c === 2)) || (a === 198 && b === 51 && c === 100) || (a === 203 && b === 0 && c === 113) // special, documentation
    );
  }
  if (isIP(v) === 6) {
    const g = expand6(v);
    if (!g) return true;
    if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g[7] === 1)) return true; // :: and ::1
    const v4 = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255].join(".");
    // Forms that carry an IPv4 address: mapped ::ffff:a.b.c.d, compatible ::a.b.c.d, SIIT ::ffff:0:a.b.c.d, NAT64 64:ff9b::a.b.c.d.
    if (g.slice(0, 5).every((x) => x === 0) && (g[5] === 0xffff || g[5] === 0)) return privateAddress(v4(g[6], g[7]));
    if (g.slice(0, 4).every((x) => x === 0) && g[4] === 0xffff && g[5] === 0) return privateAddress(v4(g[6], g[7]));
    if (g[0] === 0x64 && g[1] === 0xff9b) return privateAddress(v4(g[6], g[7]));
    if (g[0] === 0x2002) return privateAddress(v4(g[1], g[2])); // 6to4
    const top = g[0] >> 8;
    return top === 0xff || (g[0] & 0xfe00) === 0xfc00 || (g[0] & 0xffc0) === 0xfe80 || (g[0] & 0xffc0) === 0xfec0; // multicast, unique-local, link-local, site-local
  }
  return true;
}

/** An IPv6 address as its eight 16-bit groups (an IPv4 tail is folded in), or null. */
function expand6(v: string): number[] | null {
  let s = v.replace(/%.*$/, "");
  const tail = /(\d+\.\d+\.\d+\.\d+)$/.exec(s);
  if (tail) {
    const p = tail[1].split(".").map(Number);
    s = s.slice(0, -tail[1].length) + `${((p[0] << 8) | p[1]).toString(16)}:${((p[2] << 8) | p[3]).toString(16)}`;
  }
  const [head, rest] = s.split("::");
  const a = head ? head.split(":") : [];
  const b = rest !== undefined ? (rest ? rest.split(":") : []) : null;
  const groups = b === null ? a : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  if (groups.length !== 8) return null;
  return groups.map((x) => parseInt(x || "0", 16));
}

/**
 * The DNS lookup every outbound post uses: it refuses a name that resolves to any
 * private address, and the connection uses the very addresses it checked, so a
 * name can't pass the check and then point somewhere else (DNS rebinding).
 */
export function safeLookup(hostname: string, options: LookupOptions, callback: (err: NodeJS.ErrnoException | null, address: string | LookupAddress[], family?: number) => void): void {
  lookupCb(hostname, { ...options, all: true }, (err, addresses) => {
    if (err) return callback(err, []);
    const list = addresses as LookupAddress[];
    if (!list.length || list.some((a) => privateAddress(a.address))) return callback(Object.assign(new Error("not a public address"), { code: "EPRIVATE" }), []);
    if (options.all) return callback(null, list);
    callback(null, list[0].address, list[0].family);
  });
}

/**
 * The real sender: https only, no redirects, at most 2 KB of reply read, and every
 * address checked by safeLookup at connect time.
 */
export const pinnedFetch: Fetcher = (url, init) =>
  new Promise((resolve, reject) => {
    const u = new URL(url);
    if (u.protocol !== "https:") return reject(new Error("https only"));
    const req = httpsRequest(
      u,
      { method: init.method, headers: { ...init.headers, "Content-Length": String(Buffer.byteLength(init.body)) }, lookup: safeLookup, signal: init.signal },
      (res) => {
        const chunks: Buffer[] = [];
        let size = 0;
        res.on("data", (c: Buffer) => {
          if (size < 2048) chunks.push(c);
          size += c.length;
        });
        res.on("end", () => {
          const status = res.statusCode ?? 0;
          resolve({ ok: status >= 200 && status < 300, status, text: async () => Buffer.concat(chunks).toString("utf8").slice(0, 2048) });
        });
        res.on("error", reject);
      },
    );
    req.on("error", reject);
    req.end(init.body);
  });

/**
 * "Any app": the name must resolve only to public addresses, checked when it's
 * saved and again before each send (a name can be pointed somewhere new).
 */
export async function resolvesPublic(raw: string, resolve: (host: string) => Promise<{ address: string }[]> = (h) => lookup(h, { all: true })): Promise<boolean> {
  const host = new URL(raw).hostname.replace(/^\[|\]$/g, "");
  if (isIP(host)) return !privateAddress(host);
  try {
    const addrs = await Promise.race([resolve(host), new Promise<never>((_, no) => setTimeout(() => no(new Error("DNS timeout")), 3_000))]);
    return addrs.length > 0 && addrs.every((a) => !privateAddress(a.address));
  } catch {
    return false;
  }
}

export async function listConnections(db: Db, merchantId: string): Promise<Connection[]> {
  const res = await db.query(`select ${COLUMNS} from connections where merchant_id = $1 order by created_at`, [merchantId]);
  return res.rows.map(toConnection);
}

/**
 * Adds or replaces a connection. "Any app" gets a fresh signing secret, which
 * is returned this once so the merchant can paste it into n8n / Zapier.
 */
export async function saveConnection(
  db: Db,
  merchantId: string,
  kind: ConnectionKind,
  url: string,
  resolve?: (host: string) => Promise<{ address: string }[]>,
): Promise<{ connection: Connection; secret: string | null } | { error: string }> {
  const problem = urlProblem(kind, url);
  if (problem) return { error: problem };
  if (kind === "webhook" && !(await resolvesPublic(url.trim(), resolve))) return { error: PUBLIC_ONLY };
  const fresh = kind === "webhook" ? randomBytes(24).toString("hex") : null;
  // Changing only the URL keeps the secret, so the app's check keeps working. Posting
  // starts from now: changing it never replays (or drops) older cards.
  const res = await db.query(
    `insert into connections (merchant_id, kind, url, secret) values ($1, $2, $3, $4)
     on conflict (merchant_id, kind) do update set url = $3, secret = coalesce(connections.secret, $4), enabled = true,
        last_status = null, last_sent_at = null, failures = 0, post_from = now(), updated_at = now()
     returning ${COLUMNS}, (xmax = 0) as inserted`,
    [merchantId, kind, url.trim(), fresh],
  );
  const row = res.rows[0];
  return { connection: toConnection(row), secret: row.inserted ? fresh : null };
}

export async function setConnectionEnabled(db: Db, merchantId: string, kind: ConnectionKind, enabled: boolean): Promise<Connection | null> {
  // Switching back on posts what comes next, never the backlog from while it was off.
  const res = await db.query(
    `update connections set enabled = $3, failures = 0, post_from = case when $3 and not enabled then now() else post_from end, updated_at = now()
      where merchant_id = $1 and kind = $2 returning ${COLUMNS}`,
    [merchantId, kind, enabled],
  );
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
      { type: "section", text: { type: "mrkdwn", text: `*${clip(slackText(f.title ?? ""), 150)}*${line2 ? `\n${clip(slackText(line2), 200)}` : ""}${f.body ? `\n${clip(slackText(f.body), 500)}` : ""}` } },
      ...(f.reason ? [{ type: "context", elements: [{ type: "mrkdwn", text: clip(slackText(f.reason), 200) }] }] : []),
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
const ANY_APP_FAILED = "Failed: the app didn't accept it (check the URL, and that it answers 2xx within 5 s)";

/** Seconds a post may take: a slow app never holds up the worker. */
export const POST_TIMEOUT_MS = 5_000;

export async function postCard(
  fetcher: Fetcher,
  c: Connection,
  card: CardForPost,
  link: string,
  now: Date,
  resolve?: (host: string) => Promise<{ address: string }[]>,
): Promise<{ ok: boolean; status: string }> {
  if (c.kind === "webhook" && !(await resolvesPublic(c.url, resolve))) return { ok: false, status: ANY_APP_FAILED };
  const payload = c.kind === "slack" ? slackMessage(card, link) : c.kind === "discord" ? discordMessage(card, link) : webhookEvent(card, link);
  const body = JSON.stringify(payload);
  const headers: Record<string, string> = { "Content-Type": "application/json", "User-Agent": "Pyp-Connections/1" };
  if (c.kind === "webhook" && c.secret) {
    const ts = String(Math.floor(now.getTime() / 1000));
    headers["X-Pyp-Timestamp"] = ts;
    headers["X-Pyp-Signature"] = `sha256=${signWebhook(c.secret, ts, body)}`;
  }
  try {
    const res = await fetcher(c.url, { method: "POST", headers, body, signal: AbortSignal.timeout(POST_TIMEOUT_MS) });
    if (res.ok) return { ok: true, status: "Sent" };
    // Any app: one message whatever went wrong, so the list can't be used to probe a network.
    if (c.kind === "webhook") return { ok: false, status: ANY_APP_FAILED };
    // Slack and Discord explain errors in a word ("no_service").
    const why = (await res.text().catch(() => "")).slice(0, 80);
    return { ok: false, status: `Failed (${res.status}${why ? `: ${slackText(why)}` : ""})` };
  } catch (err) {
    if (c.kind === "webhook") return { ok: false, status: ANY_APP_FAILED };
    const timedOut = (err as Error).name === "TimeoutError" || (err as Error).name === "AbortError";
    return { ok: false, status: timedOut ? "Failed: no answer in 5 s" : "Failed: couldn't reach it" };
  }
}

/** A connection that fails this many posts in a row switches itself off (it says why). */
export const PAUSE_AFTER_FAILURES = 5;

async function markSent(db: Db, id: string, status: string, now: Date, ok = true) {
  await db.query(
    `update connections set last_sent_at = $3,
        failures = case when $4 then 0 else failures + 1 end,
        enabled = case when not $4 and failures + 1 >= $5 then false else enabled end,
        last_status = case when not $4 and failures + 1 >= $5 then $2 || ' · switched off after ' || $5 || ' failures in a row' else $2 end
      where id = $1`,
    [id, status, now, ok, PAUSE_AFTER_FAILURES],
  );
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
  await markSent(db, c.id, out.ok ? "Test sent" : out.status, now, out.ok);
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
export async function postNewCards(deps: {
  pool: Pool;
  fetcher: Fetcher;
  link: (cardId: string) => string;
  now?: () => Date;
  merchantIds?: string[];
  resolve?: (host: string) => Promise<{ address: string }[]>;
}) {
  const now = (deps.now ?? (() => new Date()))();
  let conns;
  try {
    conns = await deps.pool.query(
      `select ${COLUMNS}, merchant_id, post_from from connections where enabled ${deps.merchantIds ? "and merchant_id = any($1::uuid[])" : ""}`,
      deps.merchantIds ? [deps.merchantIds] : [],
    );
  } catch (err) {
    if (missingConnectionsTable(err)) return [];
    throw err;
  }
  type Done = { kind: ConnectionKind; cardId: string; ok: boolean; status: string };
  // Connections run side by side, so one slow app never holds up the others.
  const perConnection = (conns.rows as Record<string, unknown>[]).map(async (row): Promise<Done[]> => {
    const done: Done[] = [];
    const c = toConnection(row);
    const cards = await deps.pool.query(
      `select k.id, k.skill, k.state, k.front_json, k.created_at from cards k
        where k.merchant_id = $1 and k.state in ('awaiting_approval', 'scheduled') and k.created_at >= $2
          and not exists (select 1 from connection_posts p where p.connection_id = $3 and p.card_id = k.id)
        order by k.created_at limit $4`,
      [row.merchant_id, row.post_from, c.id, POST_LIMIT],
    );
    for (const k of cards.rows as Record<string, unknown>[]) {
      const claimed = await deps.pool.query("insert into connection_posts (connection_id, card_id) values ($1, $2) on conflict do nothing returning card_id", [c.id, k.id]);
      if (!claimed.rows[0]) continue; // another worker has it
      const card: CardForPost = { id: String(k.id), skill: String(k.skill), state: String(k.state), createdAt: iso(k.created_at)!, front: (k.front_json ?? {}) as CardForPost["front"] };
      const out = await postCard(deps.fetcher, c, card, deps.link(card.id), now, deps.resolve);
      await markSent(deps.pool, c.id, out.status, now, out.ok);
      done.push({ kind: c.kind, cardId: card.id, ...out });
      // Switched itself off after too many failures: stop here.
      if (!out.ok && (await deps.pool.query("select enabled from connections where id = $1", [c.id])).rows[0]?.enabled === false) break;
    }
    return done;
  });
  const settled = await Promise.all(
    perConnection.map((p) =>
      p.catch((err: Error) => {
        console.error(`[pyp connections] a connection failed: ${err.message}`);
        return [] as Done[];
      }),
    ),
  );
  return settled.flat();
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
                connect_code = null, connect_code_expires_at = null, dm_channel = null, updated_at = now()
          where connect_code = $1 and connect_code_expires_at > $6
          returning (select name from merchants m where m.id = slack_links.merchant_id) as merchant_name`,
        [code, cmd.teamId, cmd.teamDomain, cmd.userId, cmd.userName, deps.now],
      );
      if (!res.rows[0]) return { reply: "That code didn't work. In Pyp, open Settings → Connections and get a new one (codes last 15 minutes)." };
      return { reply: `Linked to *${slackText(String(res.rows[0].merchant_name))}* in Pyp. Only you can use /pyp here.\n${SLASH_HELP}` };
    } catch (err) {
      if ((err as { code?: string }).code === "23505") return { reply: "This Slack workspace is already linked to a Pyp account. Unlink it there first (/pyp disconnect)." };
      throw err;
    }
  }

  const link = await deps.pool.query("select merchant_id, slack_user_id, slack_user_name from slack_links where team_id = $1", [cmd.teamId]);
  const row = link.rows[0];
  if (!row) return { reply: "This Slack workspace isn't linked to Pyp yet. In Pyp, open Settings → Connections, tap *Link Slack*, then type `/pyp connect CODE` here." };
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
