// POST /api/slack/events: Slack's Event Subscriptions (Request URL). Pyp answers
// a DM or an @mention from the linked person in a thread, through the same chat
// receptionist as the dashboard: it can make cards, never approve them.
// Slack signs every request and wants a 200 within 3 seconds, so the model run
// happens after the response. Each event is handled once, even if Slack resends it.

import { after } from "next/server";
import { verifySlackRequest } from "@/jobs/connections";
import { getPool } from "@/jobs/db";
import { handleMessageEvent } from "@/jobs/slack-bot";
import { chatOutcomeFromSlack, slackApi } from "@/lib/connections";

export const maxDuration = 300;

export async function POST(request: Request) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return Response.json({ error: "SLACK_SIGNING_SECRET isn't set on this server" }, { status: 503 });
  const raw = await request.text();
  if (!verifySlackRequest(secret, request.headers.get("x-slack-request-timestamp"), raw, request.headers.get("x-slack-signature"), new Date())) {
    return Response.json({ error: "Bad signature" }, { status: 401 });
  }
  let body: Record<string, unknown>;
  try {
    body = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Expected JSON" }, { status: 400 });
  }
  // Slack checks the URL once when it's saved in the app.
  if (body.type === "url_verification") return Response.json({ challenge: body.challenge });
  if (body.type !== "event_callback") return new Response(null, { status: 200 });

  const slack = slackApi();
  if (!slack) return new Response(null, { status: 200 }); // no bot token: nothing to answer with
  const e = (body.event ?? {}) as Record<string, unknown>;
  const authorizations = (body.authorizations as { user_id?: string }[] | undefined) ?? [];
  const work = await handleMessageEvent(
    {
      pool: getPool(),
      slack,
      chat: (merchantId, text, history) => chatOutcomeFromSlack(merchantId, text, history),
      botUserId: authorizations[0]?.user_id,
    },
    {
      teamId: String(body.team_id ?? ""),
      eventId: String(body.event_id ?? ""),
      type: String(e.type ?? ""),
      channelType: e.channel_type as string | undefined,
      channel: String(e.channel ?? ""),
      user: e.user as string | undefined,
      botId: e.bot_id as string | undefined,
      subtype: e.subtype as string | undefined,
      text: String(e.text ?? ""),
      ts: String(e.ts ?? ""),
      threadTs: e.thread_ts as string | undefined,
    },
  ).catch((err: Error) => {
    console.error(`[pyp slack] event not handled: ${err.message}`);
    return null;
  });
  if (work) {
    after(() =>
      work().catch((err: Error) => {
        console.error(`[pyp slack] event failed: ${err.message}`);
      }),
    );
  }
  return new Response(null, { status: 200 });
}
