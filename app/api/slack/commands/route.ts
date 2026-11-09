// POST /api/slack/commands: the /pyp slash command (Slack app → Slash Commands →
// Request URL). Slack signs every request; anything unsigned, old or forged is
// refused. Pyp answers within Slack's 3 seconds, and posts the slow part (a model
// call) to Slack's response_url after the response. /pyp can only make cards:
// approving stays in Pyp.

import { after } from "next/server";
import { handleSlash, verifySlackRequest } from "@/jobs/connections";
import { getPool } from "@/jobs/db";
import { chatFromSlack, fetcher, runSkillFromSlack } from "@/lib/connections";

// The model run after the response happens inside this budget.
export const maxDuration = 300;

const ephemeral = (text: string) => Response.json({ response_type: "ephemeral", text });

export async function POST(request: Request) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return Response.json({ error: "SLACK_SIGNING_SECRET isn't set on this server" }, { status: 503 });
  const raw = await request.text();
  const now = new Date();
  if (!verifySlackRequest(secret, request.headers.get("x-slack-request-timestamp"), raw, request.headers.get("x-slack-signature"), now)) {
    return Response.json({ error: "Bad signature" }, { status: 401 });
  }
  const form = new URLSearchParams(raw);
  const responseUrl = form.get("response_url") ?? "";
  const out = await handleSlash(
    { pool: getPool(), now, chat: chatFromSlack, runSkill: runSkillFromSlack },
    {
      teamId: form.get("team_id") ?? "",
      teamDomain: form.get("team_domain") ?? "",
      userId: form.get("user_id") ?? "",
      userName: form.get("user_name") ?? "",
      text: form.get("text") ?? "",
    },
  );
  // Only ever post back to Slack itself.
  if (out.later && /^https:\/\/hooks\.slack\.com\//.test(responseUrl)) {
    const later = out.later;
    after(async () => {
      const text = await later().catch((err: Error) => `Pyp couldn't finish that: ${err.message}`);
      await fetcher(responseUrl, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ response_type: "ephemeral", text }) }).catch(() => undefined);
    });
  }
  return ephemeral(out.reply);
}
