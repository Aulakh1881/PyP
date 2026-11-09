// POST /api/slack/interactions: Slack's Interactivity (Request URL), the buttons
// on Pyp's DMs. Each click goes through exactly what the dashboard's buttons do:
// Approve is approveCard (fresh checks, policy, kill switch, then the executor),
// and only for the low-risk actions jobs/slack-bot.ts allows in Slack, checked
// again here on every click. Only the person who linked Pyp can click.
// Slack wants a 200 within 3 seconds; the work (a PayPal write, a model run)
// happens after, and the result comes back as a reply in the DM's thread.

import { after } from "next/server";
import { verifySlackRequest } from "@/jobs/connections";
import { handleAction, syncSlackDms } from "@/jobs/slack-bot";
import { inboxLink, slackActions, slackApi } from "@/lib/connections";

export const maxDuration = 300;

export async function POST(request: Request) {
  const secret = process.env.SLACK_SIGNING_SECRET;
  if (!secret) return Response.json({ error: "SLACK_SIGNING_SECRET isn't set on this server" }, { status: 503 });
  const raw = await request.text();
  if (!verifySlackRequest(secret, request.headers.get("x-slack-request-timestamp"), raw, request.headers.get("x-slack-signature"), new Date())) {
    return Response.json({ error: "Bad signature" }, { status: 401 });
  }
  let payload: Record<string, unknown>;
  try {
    payload = JSON.parse(new URLSearchParams(raw).get("payload") ?? "");
  } catch {
    return Response.json({ error: "Expected a payload" }, { status: 400 });
  }
  if (payload.type !== "block_actions") return new Response(null, { status: 200 });

  const action = ((payload.actions as Record<string, unknown>[] | undefined) ?? [])[0];
  const slack = slackApi();
  if (!action || !slack) return new Response(null, { status: 200 });
  const team = (payload.team as { id?: string } | undefined)?.id ?? "";
  const user = (payload.user as { id?: string } | undefined)?.id ?? "";
  const channel = (payload.channel as { id?: string } | undefined)?.id;
  const ts = (payload.message as { ts?: string } | undefined)?.ts;
  const deps = slackActions();

  after(async () => {
    const said = await handleAction(deps, { teamId: team, userId: user, actionId: String(action.action_id ?? ""), value: String(action.value ?? "") }).catch(
      (err: Error) => {
        console.error(`[pyp slack] button failed: ${err.message}`);
        return "That didn't work. Open Pyp to try again.";
      },
    );
    if (said && channel && ts) await slack("chat.postMessage", { channel, thread_ts: ts, text: said }).catch(() => undefined);
    // Update the DM now rather than on the next tick.
    await syncSlackDms({ pool: deps.pool, slack, link: inboxLink }).catch(() => undefined);
  });
  return new Response(null, { status: 200 });
}
