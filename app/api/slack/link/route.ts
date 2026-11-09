// POST /api/slack/link: a one-time code (15 minutes) to type in Slack as
// /pyp connect CODE. DELETE: unlink the Slack workspace from this account.

import { newSlackCode, unlinkSlack } from "@/jobs/connections";
import { getPool } from "@/jobs/db";
import { requireMerchant } from "@/lib/session";

export async function POST() {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  return Response.json(await newSlackCode(getPool(), session.merchantId, new Date()));
}

export async function DELETE() {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  await unlinkSlack(getPool(), session.merchantId);
  return Response.json({ ok: true });
}
