// GET /api/connections: the merchant's connections (never their whole URL or
// secret), whether Slack's /pyp is linked, and whether this server can take it.

import { listConnections, masked, missingConnectionsTable, slackLink } from "@/jobs/connections";
import { getPool } from "@/jobs/db";
import { requireMerchant } from "@/lib/session";

export async function GET() {
  const session = await requireMerchant();
  if (session instanceof Response) return session;
  try {
    const pool = getPool();
    const [connections, slack] = await Promise.all([listConnections(pool, session.merchantId), slackLink(pool, session.merchantId)]);
    return Response.json({ connections: connections.map(masked), slack, slashReady: !!process.env.SLACK_SIGNING_SECRET });
  } catch (err) {
    if (missingConnectionsTable(err)) return Response.json({ error: "The database needs migration 015_connections.sql first" }, { status: 503 });
    throw err;
  }
}
