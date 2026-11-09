// Connections wired to the real database, model and PayPal sandbox (jobs/connections.ts).

import type { ChatTurn } from "@/engine/chat";
import { answerCard } from "@/jobs/answer-run";
import { runChatMessage } from "@/jobs/chat-run";
import { pinnedFetch, postNewCards, type Fetcher } from "@/jobs/connections";
import { syncSlackDms, type SlackApi } from "@/jobs/slack-bot";
import { dismiss, undo } from "@/jobs/store";
import { approveCard } from "@/executor/from-env";
import { listSkills } from "@/jobs/custom-skills";
import { getPool } from "@/jobs/db";
import { serverAgent } from "@/lib/agent";
import { DASHBOARD_URL } from "@/lib/dashboard-url";
import { runCustomSkillNow, runSweepNow } from "@/lib/sweeps";
import { PayPalReadClient } from "@/paypal/engine-reads";
import { sharedPayPalHttp } from "@/paypal/http";

/** Every post to another app: https, no redirects, and only to the public addresses it checked. */
export const fetcher: Fetcher = pinnedFetch;

/** Where a message's "Open in Pyp" goes: the Inbox of the dashboard (PYP_PUBLIC_DASHBOARD_URL once deployed). */
export function inboxLink(): string {
  const base = (process.env.PYP_PUBLIC_DASHBOARD_URL || DASHBOARD_URL).replace(/#.*$/, "");
  return `${base}#/inbox`;
}

const sweptMerchant = process.env.PAYPAL_WEBHOOK_MERCHANT_ID;
const slack = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

/** The worker, every tick: new cards to Slack, Discord and any app. */
export const postNewCardsFromEnv = () =>
  postNewCards({ pool: getPool(), fetcher, link: () => inboxLink(), merchantIds: sweptMerchant ? [sweptMerchant] : undefined });

/** A message to Pyp from Slack (/pyp, a DM, an @mention): the same receptionist as the chat page. */
export async function chatOutcomeFromSlack(merchantId: string, text: string, history: ChatTurn[] = []) {
  const read = new PayPalReadClient(sharedPayPalHttp());
  return runChatMessage(
    { pool: getPool(), read, agent: serverAgent(), subjects: () => read.openSubjects(), weeklyBrief: () => runSweepNow(merchantId, "weekly-brief") },
    merchantId,
    text,
    undefined,
    history,
  );
}

/** /pyp <sentence>: Pyp's reply. */
export async function chatFromSlack(merchantId: string, text: string): Promise<string> {
  const out = await chatOutcomeFromSlack(merchantId, text);
  return out.cardIds.length ? `${out.reply}\nOpen your Inbox: ${inboxLink()}` : out.reply;
}

// ---------- Pyp as a Slack bot (jobs/slack-bot.ts) ----------

/** The Slack Web API with the bot token (SLACK_BOT_TOKEN). Null when there's no bot. */
export function slackApi(): SlackApi | null {
  const token = process.env.SLACK_BOT_TOKEN;
  if (!token) return null;
  return async (method, body) => {
    const res = await fetch(`https://slack.com/api/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json; charset=utf-8", Authorization: `Bearer ${token}` },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8_000),
    });
    const json = (await res.json().catch(() => ({ ok: false, error: `HTTP ${res.status}` }))) as Record<string, unknown>;
    if (!json.ok) throw new Error(`Slack ${method}: ${String(json.error ?? "failed")}`);
    return json;
  };
}

/** The worker: cards that need the linked person go to them as DMs; decided ones update. */
export async function syncSlackDmsFromEnv() {
  const slack = slackApi();
  if (!slack) return { posted: 0, updated: 0, failed: [] as string[] };
  return syncSlackDms({ pool: getPool(), slack, link: inboxLink, merchantIds: sweptMerchant ? [sweptMerchant] : undefined });
}

/** What a Slack button may do: exactly what the dashboard's buttons do. */
export const slackActions = () => ({
  pool: getPool(),
  approve: (merchantId: string, cardId: string) => approveCard(merchantId, cardId),
  dismiss: (merchantId: string, cardId: string) => dismiss(getPool(), merchantId, cardId),
  undo: (merchantId: string, cardId: string) => undo(getPool(), merchantId, cardId),
  answer: (merchantId: string, cardId: string, optionIndex: number) =>
    answerCard({ pool: getPool(), read: new PayPalReadClient(sharedPayPalHttp()), agent: serverAgent() }, merchantId, cardId, optionIndex),
});

/** /pyp run <name>: one of the merchant's custom skills, now. Null when there's no such skill. */
export async function runSkillFromSlack(merchantId: string, name: string): Promise<string | null> {
  const skills = await listSkills(getPool(), merchantId);
  const s = skills.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!s) return null;
  const out = await runCustomSkillNow(merchantId, s.id, false);
  if (!out) return null;
  if (out.status === "busy") return "Pyp is already running a check. Try again in a minute.";
  if (out.status === "paused") return "Pyp is paused (kill switch on), so the skill didn't run.";
  const name_ = slack(s.name);
  if (out.status === "waiting") return `“${name_}” isn't finished yet. Open it on My skills in Pyp.`;
  const cards = out.cardIds.length;
  return `“${name_}” looked at ${out.found}; ${out.matched} passed its checks. ${cards ? `${cards} card${cards === 1 ? "" : "s"} in your Inbox: ${inboxLink()}` : "Nothing needs you right now."}`;
}
