// Connections wired to the real database, model and PayPal sandbox (jobs/connections.ts).

import { runChatMessage } from "@/jobs/chat-run";
import { postNewCards, type Fetcher } from "@/jobs/connections";
import { listSkills } from "@/jobs/custom-skills";
import { getPool } from "@/jobs/db";
import { serverAgent } from "@/lib/agent";
import { DASHBOARD_URL } from "@/lib/dashboard-url";
import { runCustomSkillNow, runSweepNow } from "@/lib/sweeps";
import { PayPalReadClient } from "@/paypal/engine-reads";
import { sharedPayPalHttp } from "@/paypal/http";

export const fetcher: Fetcher = (url, init) => fetch(url, { ...init, redirect: "error" });

/** Where a message's "Open in Pyp" goes: the Inbox of the dashboard (PYP_PUBLIC_DASHBOARD_URL once deployed). */
export function inboxLink(): string {
  const base = (process.env.PYP_PUBLIC_DASHBOARD_URL || DASHBOARD_URL).replace(/#.*$/, "");
  return `${base}#/inbox`;
}

const sweptMerchant = process.env.PAYPAL_WEBHOOK_MERCHANT_ID;

/** The worker, every tick: new cards to Slack, Discord and any app. */
export const postNewCardsFromEnv = () =>
  postNewCards({ pool: getPool(), fetcher, link: () => inboxLink(), merchantIds: sweptMerchant ? [sweptMerchant] : undefined });

/** /pyp <sentence>: the same receptionist as the chat page. */
export async function chatFromSlack(merchantId: string, text: string): Promise<string> {
  const read = new PayPalReadClient(sharedPayPalHttp());
  const out = await runChatMessage(
    { pool: getPool(), read, agent: serverAgent(), subjects: () => read.openSubjects(), weeklyBrief: () => runSweepNow(merchantId, "weekly-brief") },
    merchantId,
    text,
  );
  return out.cardIds.length ? `${out.reply}\nOpen your Inbox: ${inboxLink()}` : out.reply;
}

/** /pyp run <name>: one of the merchant's custom skills, now. Null when there's no such skill. */
export async function runSkillFromSlack(merchantId: string, name: string): Promise<string | null> {
  const skills = await listSkills(getPool(), merchantId);
  const s = skills.find((x) => x.name.toLowerCase() === name.toLowerCase());
  if (!s) return null;
  const out = await runCustomSkillNow(merchantId, s.id, false);
  if (!out) return null;
  if (out.status === "busy") return "Pyp is already running a check. Try again in a minute.";
  if (out.status === "paused") return "Pyp is paused (kill switch on), so the skill didn't run.";
  if (out.status === "waiting") return `“${s.name}” isn't finished yet. Open it on My skills in Pyp.`;
  const cards = out.cardIds.length;
  return `“${s.name}” looked at ${out.found}; ${out.matched} passed its checks. ${cards ? `${cards} card${cards === 1 ? "" : "s"} in your Inbox: ${inboxLink()}` : "Nothing needs you right now."}`;
}
