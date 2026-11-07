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
): Promise<{ verified: boolean; status: number; verificationStatus?: string; name?: string }> {
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
  let body: unknown = null;
  try {
    body = await response.json();
  } catch {
    return { verified: false, status: response.status };
  }
  if (!response.ok) {
    const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
    return {
      verified: false,
      status: response.status,
      name: typeof record.name === "string" ? record.name : undefined,
    };
  }
  const record = body && typeof body === "object" ? body as Record<string, unknown> : {};
  const verificationStatus = typeof record.verification_status === "string"
    ? record.verification_status
    : undefined;
  return {
    verified: verificationStatus === "SUCCESS",
    status: response.status,
    verificationStatus,
  };
}
