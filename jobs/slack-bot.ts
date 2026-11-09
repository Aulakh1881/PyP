// Pyp as a Slack bot (db/migrations/016_slack_bot.sql), for the person who
// linked their workspace (015's /pyp connect CODE).
//
//   Cards → DMs     A card that needs them arrives as a DM with buttons. Low-risk
//                   ones (a reminder, a follow-up, a question) can be approved,
//                   answered, dismissed or undone right there. Anything that moves
//                   money or answers a dispute only offers "Review in Pyp".
//   Buttons         Each one goes through the same path as the dashboard: Approve
//                   is approveCard (fresh checks, policy, kill switch, then the
//                   executor). Slack can't do anything the dashboard couldn't.
//   Updates         When a card is decided, here or in Pyp, its DM changes to say so.
//   Conversation    DM Pyp or @mention it: the chat receptionist answers in a thread,
//                   and a follow-up in that thread is read with what came before.
//
// Every request from Slack is checked against the signing secret first
// (verifySlackRequest in jobs/connections.ts), and only the linked person counts.

import type { Pool } from "pg";
import type { ChatTurn } from "@/engine/chat";
import type { CardForPost } from "./connections";

type Db = Pick<Pool, "query">;

/** Calls one Slack Web API method with the bot token. Throws when Slack says !ok. */
export type SlackApi = (method: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>;

/**
 * The actions a Slack button may approve. Everything else (sending an invoice,
 * cancelling, dispute offers, evidence, accepting a claim, turning on automatic
 * reminders) is "Review in Pyp" only, and the server re-checks this on every click.
 */
export const APPROVE_IN_SLACK = new Set(["invoice.sendReminder", "invoice.scheduleFollowUp"]);

export interface BotCard extends CardForPost {
  commandId: string | null;
}

const WAITING = ["awaiting_approval", "scheduled"];
const slackText = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
const money = (a?: { value: string; currency: string }) => (a ? `${a.currency} ${a.value}` : "");

/** What a decided card's DM says instead of its buttons. */
export const RESOLVED: Record<string, string> = {
  executed: "✅ Done",
  rejected: "Dismissed. Nothing was sent.",
  undone: "↩️ Undone. Nothing was sent.",
  obsolete: "No longer needed (things changed in PayPal).",
  failed: "⚠️ It didn't go through. Open Pyp to see why.",
  blocked: "Blocked by your settings.",
  executing: "Sending…",
  answered: "Answered.",
};

/** Slack errors that mean a DM can never be updated (deleted, or the channel's gone). */
const GONE = /message_not_found|channel_not_found|cant_update_message|is_archived|not_in_channel/;

function button(text: string, actionId: string, value: string, style?: "primary" | "danger") {
  return { type: "button", text: { type: "plain_text", text: clip(text, 75) }, action_id: actionId, value, ...(style ? { style } : {}) };
}

/** The DM for a card: its words, then buttons for what Slack may do, or how it ended. */
export function botBlocks(card: BotCard, link: string, resolvedNote?: string) {
  const f = card.front;
  const question = !!f.options?.length && card.state === "awaiting_approval";
  const head = card.state === "scheduled" ? "Pyp will do this unless you tap Undo" : question ? "Pyp has a question" : "Pyp needs your OK";
  const line2 = [f.subtitle, money(f.amount)].filter(Boolean).join(" · ");
  const blocks: Record<string, unknown>[] = [
    { type: "context", elements: [{ type: "mrkdwn", text: `*${slackText(resolvedNote ? "Pyp" : head)}* · ${slackText(f.eyebrow ?? card.skill)}` }] },
    {
      type: "section",
      text: {
        type: "mrkdwn",
        text: `*${clip(slackText(f.title ?? "A new card"), 150)}*${line2 ? `\n${clip(slackText(line2), 200)}` : ""}${f.body ? `\n${clip(slackText(f.body), 900)}` : ""}`,
      },
    },
  ];
  if (f.reason && !resolvedNote) blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: clip(slackText(f.reason), 200) }] });

  const open = { type: "button", text: { type: "plain_text", text: "Review in Pyp" }, url: link, action_id: "pyp_open" };
  if (resolvedNote) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: slackText(resolvedNote) }] });
    blocks.push({ type: "actions", elements: [{ ...open, text: { type: "plain_text", text: "Open in Pyp" } }] });
    return blocks;
  }
  const v = (extra: Record<string, unknown> = {}) => JSON.stringify({ card: card.id, ...extra });
  const elements: Record<string, unknown>[] = [];
  if (card.state === "scheduled") elements.push(button("Undo", "pyp_undo", v(), "danger"));
  else if (question) f.options!.slice(0, 4).forEach((o, i) => elements.push(button(o, `pyp_answer_${i}`, v({ option: i }), i === 0 ? "primary" : undefined)));
  else if (card.commandId && APPROVE_IN_SLACK.has(card.commandId)) elements.push(button(approveLabel(card), "pyp_approve", v(), "primary"));
  if (card.state === "awaiting_approval") elements.push(button("Dismiss", "pyp_dismiss", v()));
  elements.push(open);
  blocks.push({ type: "actions", elements });
  if (card.state === "awaiting_approval" && !question && !(card.commandId && APPROVE_IN_SLACK.has(card.commandId))) {
    blocks.push({ type: "context", elements: [{ type: "mrkdwn", text: "This one moves money or answers a dispute, so you approve it in Pyp." }] });
  }
  return blocks;
}

function approveLabel(card: BotCard): string {
  const f = card.front as CardForPost["front"] & { approveLabel?: string };
  return f.approveLabel || "Approve";
}

export const fallbackText = (card: BotCard) => clip(`Pyp: ${card.front.title ?? "a new card"}`, 150);

// ---------- Posting and updating DMs ----------

export interface BotDeps {
  pool: Pool;
  slack: SlackApi;
  link: () => string;
  now?: () => Date;
  merchantIds?: string[];
}

const CARD_SQL = `select c.id, c.skill, c.state, c.front_json, c.created_at, p.command_id
                    from cards c left join proposals p on p.id = c.proposal_id`;

function toBotCard(r: Record<string, unknown>): BotCard {
  return {
    id: String(r.id),
    skill: String(r.skill),
    state: String(r.state),
    createdAt: new Date(r.created_at as string).toISOString(),
    front: (r.front_json ?? {}) as CardForPost["front"],
    commandId: (r.command_id as string | null) ?? null,
  };
}

async function dmChannel(deps: BotDeps, merchantId: string, link: Record<string, unknown>): Promise<string> {
  if (link.dm_channel) return String(link.dm_channel);
  const res = await deps.slack("conversations.open", { users: link.slack_user_id });
  const channel = String((res.channel as { id: string }).id);
  await deps.pool.query("update slack_links set dm_channel = $2 where merchant_id = $1", [merchantId, channel]);
  return channel;
}

/** Cards posted per merchant per tick. */
export const DM_LIMIT = 10;

/**
 * The worker, every tick: new cards that need the linked person go to them as a
 * DM (each once, claimed by its slack_messages row), and a DM whose card has
 * been decided since is updated to say how it ended.
 */
export async function syncSlackDms(deps: BotDeps): Promise<{ posted: number; updated: number; failed: string[] }> {
  const out = { posted: 0, updated: 0, failed: [] as string[] };
  let links;
  try {
    links = await deps.pool.query(
      `select merchant_id, slack_user_id, dm_channel, linked_at from slack_links where team_id is not null ${deps.merchantIds ? "and merchant_id = any($1::uuid[])" : ""}`,
      deps.merchantIds ? [deps.merchantIds] : [],
    );
  } catch (err) {
    if ((err as { code?: string }).code === "42P01" || (err as { code?: string }).code === "42703") return out; // migration 016 not run yet
    throw err;
  }
  for (const link of links.rows as Record<string, unknown>[]) {
    const merchantId = String(link.merchant_id);
    try {
      // A claim whose post never finished (a crash mid-post) goes back in the queue.
      await deps.pool.query("delete from slack_messages where merchant_id = $1 and ts is null and updated_at < now() - interval '2 minutes'", [merchantId]);
      const fresh = await deps.pool.query(
        `${CARD_SQL}
          where c.merchant_id = $1 and c.state = any($2) and c.created_at >= $3
            and not exists (select 1 from slack_messages m where m.card_id = c.id)
          order by c.created_at limit $4`,
        [merchantId, WAITING, link.linked_at, DM_LIMIT],
      );
      for (const row of fresh.rows as Record<string, unknown>[]) {
        const card = toBotCard(row);
        const claimed = await deps.pool.query("insert into slack_messages (card_id, merchant_id) values ($1, $2) on conflict do nothing returning card_id", [card.id, merchantId]);
        if (!claimed.rows[0]) continue; // another worker has it
        try {
          const channel = await dmChannel(deps, merchantId, link);
          const res = await deps.slack("chat.postMessage", { channel, text: fallbackText(card), blocks: botBlocks(card, deps.link()), unfurl_links: false });
          await deps.pool.query("update slack_messages set channel = $2, ts = $3, posted_state = $4, updated_at = now() where card_id = $1", [card.id, channel, res.ts, card.state]);
          out.posted++;
        } catch (err) {
          // Not sent (Slack busy, rate-limited): let it go back in the queue for the next tick.
          await deps.pool.query("delete from slack_messages where card_id = $1 and ts is null", [card.id]);
          throw err;
        }
      }

      // A card decided since its DM went out (here or in Pyp): say how it ended.
      const moved = await deps.pool.query(
        `${CARD_SQL} join slack_messages m on m.card_id = c.id
          where m.merchant_id = $1 and m.ts is not null and c.state is distinct from m.posted_state
            and m.updated_at > now() - interval '7 days'
          order by m.updated_at limit $2`,
        [merchantId, DM_LIMIT],
      );
      for (const row of moved.rows as Record<string, unknown>[]) {
        const card = toBotCard(row);
        const m = (await deps.pool.query("select channel, ts from slack_messages where card_id = $1", [card.id])).rows[0];
        const note = WAITING.includes(card.state) ? undefined : (RESOLVED[card.state] ?? `Now: ${card.state}`);
        try {
          await deps.slack("chat.update", { channel: m.channel, ts: m.ts, text: fallbackText(card), blocks: botBlocks(card, deps.link(), note) });
          out.updated++;
        } catch (err) {
          out.failed.push(`${card.id}: ${(err as Error).message}`);
          // A DM that's gone can never be updated: stop trying. Anything else is tried next tick.
          if (!GONE.test((err as Error).message)) continue;
        }
        await deps.pool.query("update slack_messages set posted_state = $2, updated_at = now() where card_id = $1", [card.id, card.state]);
      }
    } catch (err) {
      out.failed.push(`${merchantId}: ${(err as Error).message}`);
    }
  }
  return out;
}

// ---------- Buttons ----------

export interface ActionDeps {
  pool: Pool;
  approve: (merchantId: string, cardId: string) => Promise<{ status: string; message: string }>;
  dismiss: (merchantId: string, cardId: string) => Promise<boolean>;
  undo: (merchantId: string, cardId: string) => Promise<boolean>;
  answer: (merchantId: string, cardId: string, optionIndex: number) => Promise<{ status: string; message: string }>;
}

export interface SlackAction {
  teamId: string;
  userId: string;
  actionId: string;
  value: string;
}

/** The merchant this Slack person is linked to, or why not. */
export async function linkedMerchant(db: Db, teamId: string, userId: string): Promise<{ merchantId: string } | { refusal: string }> {
  const r = (await db.query("select merchant_id, slack_user_id, slack_user_name from slack_links where team_id = $1", [teamId])).rows[0];
  if (!r) return { refusal: "This Slack workspace isn't linked to Pyp." };
  if (r.slack_user_id !== userId) return { refusal: `Only ${slackText(String(r.slack_user_name || "the person who linked Pyp"))} can do this.` };
  return { merchantId: String(r.merchant_id) };
}

/**
 * One button click: what happened, in a sentence for an ephemeral reply. The DM
 * itself is updated by the next sync (or straight away by the caller).
 */
export async function handleAction(deps: ActionDeps, a: SlackAction): Promise<string> {
  if (a.actionId === "pyp_open") return "";
  const who = await linkedMerchant(deps.pool, a.teamId, a.userId);
  if ("refusal" in who) return who.refusal;
  let v: { card?: unknown; option?: unknown };
  try {
    v = JSON.parse(a.value);
  } catch {
    return "That button didn't make sense. Open Pyp instead.";
  }
  const cardId = typeof v.card === "string" && /^[0-9a-f-]{36}$/i.test(v.card) ? v.card : null;
  if (!cardId) return "That button didn't make sense. Open Pyp instead.";

  if (a.actionId === "pyp_approve") {
    // Never trust the button: check here that this card is one Slack may approve.
    const row = (await deps.pool.query(`${CARD_SQL} where c.id = $1 and c.merchant_id = $2`, [cardId, who.merchantId])).rows[0];
    if (!row || !APPROVE_IN_SLACK.has(String(row.command_id))) return "This one needs your approval in Pyp.";
    const out = await deps.approve(who.merchantId, cardId);
    return out.status === "executed" ? `✅ ${slackText(out.message)}` : `Not sent: ${slackText(out.message)}`;
  }
  if (a.actionId === "pyp_dismiss") return (await deps.dismiss(who.merchantId, cardId)) ? "Dismissed. Nothing was sent." : "This card isn't waiting for you any more.";
  if (a.actionId === "pyp_undo") return (await deps.undo(who.merchantId, cardId)) ? "↩️ Undone. Nothing was sent." : "Too late to undo: this already ran.";
  const ans = /^pyp_answer_(\d)$/.exec(a.actionId);
  if (ans && Number.isInteger(v.option)) {
    const out = await deps.answer(who.merchantId, cardId, v.option as number);
    return slackText(out.status === "answered" ? `Got it. ${out.message}` : out.message);
  }
  return "That button didn't make sense. Open Pyp instead.";
}

// ---------- Talking to Pyp ----------

export interface ChatDeps {
  pool: Pool;
  slack: SlackApi;
  chat: (merchantId: string, text: string, history: ChatTurn[]) => Promise<{ reply: string; cardIds: string[]; waiting: boolean }>;
  /** The bot's own Slack user id, so its mention is taken out of the text. */
  botUserId?: string;
}

export interface SlackMessageEvent {
  teamId: string;
  eventId: string;
  type: string; // "message" (a DM) or "app_mention"
  channelType?: string;
  channel: string;
  user?: string;
  botId?: string;
  subtype?: string;
  text: string;
  ts: string;
  threadTs?: string;
}

/** Lines of a thread kept for follow-ups (the chat page sends up to 20). */
export const THREAD_TURNS = 12;

/**
 * Is this a message for Pyp from the linked person? Returns the work to do after
 * Slack has its 200 (Slack wants an answer within 3 s), or null to ignore it.
 */
export async function handleMessageEvent(deps: ChatDeps, e: SlackMessageEvent): Promise<null | (() => Promise<void>)> {
  // Pyp's own messages, edits and joins never start a conversation.
  if (e.botId || e.subtype || !e.user) return null;
  if (e.type === "message" && e.channelType !== "im") return null;
  if (e.type !== "message" && e.type !== "app_mention") return null;
  if (!e.eventId) return null;
  const first = await deps.pool.query("insert into slack_events (event_id) values ($1) on conflict do nothing returning event_id", [e.eventId]);
  if (!first.rows[0]) return null; // Slack resent one we already have

  const threadTs = e.threadTs ?? e.ts;
  // In a DM, a threaded reply. In a channel (an @mention), only the person who asked
  // sees the answer: it can name clients and amounts.
  const user = e.user;
  const say = (text: string) =>
    e.type === "app_mention"
      ? deps.slack("chat.postEphemeral", { channel: e.channel, user, thread_ts: e.threadTs, text })
      : deps.slack("chat.postMessage", { channel: e.channel, thread_ts: threadTs, text, unfurl_links: false });
  const who = await linkedMerchant(deps.pool, e.teamId, e.user);
  if ("refusal" in who) {
    return async () => {
      await say(`${who.refusal} In Pyp: Settings → Connections → Link Slack, then type \`/pyp connect CODE\`.`);
    };
  }
  const text = e.text.replace(deps.botUserId ? new RegExp(`<@${deps.botUserId}>`, "g") : /^<@[A-Z0-9]+>\s*/, "").trim().slice(0, 1000);
  return async () => {
    if (!text) {
      await say("Hi! Tell me what you need, like “invoice Acme $450 for product photos”. Anything I propose waits for your OK.");
      return;
    }
    const prior = await deps.pool.query("select history from slack_threads where merchant_id = $1 and team_id = $2 and channel = $3 and thread_ts = $4", [
      who.merchantId,
      e.teamId,
      e.channel,
      threadTs,
    ]);
    const history = ((prior.rows[0]?.history ?? []) as ChatTurn[]).slice(-THREAD_TURNS);
    const out = await deps.chat(who.merchantId, text, history).catch((err: Error) => ({ reply: `I couldn't finish that: ${err.message}`, cardIds: [] as string[], waiting: true }));
    await say(slackText(out.reply) + (out.cardIds.length ? "\nIt's in your DMs from me and in your Pyp Inbox." : ""));
    const next: ChatTurn[] = [...history, { from: "merchant" as const, text }, { from: "pyp" as const, text: out.reply.slice(0, 1000), waiting: out.waiting, cardIds: out.cardIds.slice(0, 5) }].slice(-THREAD_TURNS);
    await deps.pool.query(
      `insert into slack_threads (merchant_id, team_id, channel, thread_ts, history) values ($1, $2, $3, $4, $5)
       on conflict (merchant_id, team_id, channel, thread_ts) do update set history = $5, updated_at = now()`,
      [who.merchantId, e.teamId, e.channel, threadTs, JSON.stringify(next)],
    );
  };
}
