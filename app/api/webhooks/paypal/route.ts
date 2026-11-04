// POST /api/webhooks/paypal: PayPal's webhook deliveries (design §9.2).
// Verify the signature, store the event once (duplicates are a no-op),
// answer 200 straight away, and do the work after the response, so PayPal
// never waits on a model call. No sign-in: PayPal's signature is the auth.

import { after } from "next/server";
import { serverAgent } from "@/lib/agent";
import { getPool } from "@/jobs/db";
import { processEvent, subjectFor, type PayPalEvent } from "@/jobs/event-run";
import { insertEvent } from "@/jobs/store";
import { PayPalReadClient } from "@/paypal/engine-reads";
import { sharedPayPalHttp } from "@/paypal/http";
import { verifyWebhook } from "@/paypal/webhook-verify";

// A model run can take a while; it happens after the 200, inside this budget.
export const maxDuration = 300;

/** Largest body we accept. PayPal events are a few KB. */
const MAX_BODY = 256 * 1024;

export async function POST(request: Request) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  // One demo merchant (master plan §2): the merchant whose PayPal app the webhook belongs to.
  const merchantId = process.env.PAYPAL_WEBHOOK_MERCHANT_ID;
  if (!webhookId || !merchantId) return Response.json({ error: "Webhooks aren't set up on this server" }, { status: 503 });

  const raw = await request.text();
  if (raw.length > MAX_BODY) return Response.json({ error: "Too large" }, { status: 413 });
  let event: PayPalEvent;
  try {
    event = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Not JSON" }, { status: 400 });
  }
  if (typeof event?.id !== "string" || typeof event?.event_type !== "string") {
    return Response.json({ error: "Not a PayPal event" }, { status: 400 });
  }

  const http = sharedPayPalHttp();
  let verified;
  try {
    verified = await verifyWebhook(http, request.headers, event, webhookId);
  } catch {
    // PayPal couldn't be asked: a 5xx makes PayPal retry later (up to 25 times over 3 days).
    return Response.json({ error: "Couldn't verify right now" }, { status: 503 });
  }
  if (!verified.ok) return Response.json({ error: verified.reason }, { status: 401 });

  const pool = getPool();
  const subject = subjectFor(event);
  const isNew = await insertEvent(pool, { id: event.id, merchantId, type: event.event_type, resourceId: subject?.id ?? null, raw: event });
  if (!isNew) return Response.json({ ok: true, duplicate: true });

  after(async () => {
    await processEvent({ pool, read: new PayPalReadClient(http), agent: serverAgent() }, merchantId, event);
  });
  return Response.json({ ok: true });
}
