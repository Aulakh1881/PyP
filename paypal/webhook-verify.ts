import { getPayPalAccessToken } from "./oauth";

type PayPalWebhookHeaders = {
  transmissionId: string;
  transmissionTime: string;
  transmissionSig: string;
  certUrl: string;
  authAlgo: string;
};

function apiBase(): string {
  return (process.env.PAYPAL_ENVIRONMENT ?? "SANDBOX") === "LIVE"
    ? "https://api-m.paypal.com"
    : "https://api-m.sandbox.paypal.com";
}

export async function verifyPayPalWebhook(
  headers: PayPalWebhookHeaders,
  event: unknown,
  webhookId: string,
): Promise<boolean> {
  const token = await getPayPalAccessToken();
  const response = await fetch(`${apiBase()}/v1/notifications/verify-webhook-signature`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
      Authorization: `${token.token_type} ${token.access_token}`,
    },
    body: JSON.stringify({
      auth_algo: headers.authAlgo,
      cert_url: headers.certUrl,
      transmission_id: headers.transmissionId,
      transmission_sig: headers.transmissionSig,
      transmission_time: headers.transmissionTime,
      webhook_id: webhookId,
      webhook_event: event,
    }),
    cache: "no-store",
  });
  if (!response.ok) return false;
  const body: unknown = await response.json();
  return Boolean(body && typeof body === "object" && "verification_status" in body
    && body.verification_status === "SUCCESS");
}
