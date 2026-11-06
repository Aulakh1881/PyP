import { createAdminClient } from "@/lib/supabase/admin";
import { syncPayPalReporting } from "@/lib/paypal/reporting-sync";
import { verifyPayPalWebhook } from "@/paypal/webhook-verify";

const MAX_BODY = 256 * 1024;
const MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

export async function POST(request: Request) {
  const webhookId = process.env.PAYPAL_WEBHOOK_ID;
  if (!webhookId) return Response.json({ error: "PayPal webhook is not configured" }, { status: 503 });

  const raw = await request.text();
  if (raw.length > MAX_BODY) return Response.json({ error: "Request body too large" }, { status: 413 });

  let event: unknown;
  try {
    event = JSON.parse(raw);
  } catch {
    return Response.json({ error: "Invalid JSON" }, { status: 400 });
  }
  if (!event || typeof event !== "object" || !("id" in event) || !("event_type" in event)
    || typeof event.id !== "string" || typeof event.event_type !== "string") {
    return Response.json({ error: "Invalid PayPal event" }, { status: 400 });
  }

  const header = (name: string) => request.headers.get(name) ?? "";
  const verified = await verifyPayPalWebhook({
    transmissionId: header("paypal-transmission-id"),
    transmissionTime: header("paypal-transmission-time"),
    transmissionSig: header("paypal-transmission-sig"),
    certUrl: header("paypal-cert-url"),
    authAlgo: header("paypal-auth-algo"),
  }, event, webhookId);
  if (!verified) return Response.json({ error: "Webhook signature verification failed" }, { status: 401 });

  const supabase = createAdminClient();
  const { error } = await supabase.from("events").insert({
    id: event.id,
    merchant_id: MERCHANT_ID,
    type: event.event_type,
    resource_id: null,
    raw_json: event,
  });
  if (error?.code === "23505") return Response.json({ ok: true, duplicate: true });
  if (error) {
    console.error("PayPal webhook event storage failed", { message: error.message });
    return Response.json({ error: "Webhook event could not be stored" }, { status: 500 });
  }

  try {
    const synced = await syncPayPalReporting(supabase);
    return Response.json({ ok: true, synced });
  } catch (syncError) {
    console.error("PayPal webhook cache sync failed", syncError);
    return Response.json({ error: "Webhook accepted but cache synchronization failed" }, { status: 503 });
  }
}
