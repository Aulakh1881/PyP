// Checks a PayPal webhook really came from PayPal (design §9.2 step 2).
// Uses PayPal's postback check: we send the headers and the event back and
// PayPal says SUCCESS or FAILURE. The design's offline self-check (CRC32 +
// PayPal's certificate) is faster; this is the simpler, safe first version.
//
// Note: the dashboard's webhook simulator sends events that the postback
// check can't verify (they carry a placeholder webhook id). Test with real
// sandbox events: create, pay or cancel an invoice in the sandbox.

import type { PayPalHttp } from "./http";

/** Headers PayPal signs a delivery with. All are required. */
const SIGNATURE_HEADERS = {
  auth_algo: "paypal-auth-algo",
  cert_url: "paypal-cert-url",
  transmission_id: "paypal-transmission-id",
  transmission_sig: "paypal-transmission-sig",
  transmission_time: "paypal-transmission-time",
} as const;

export type VerifyResult = { ok: true } | { ok: false; reason: string };

export async function verifyWebhook(
  http: PayPalHttp,
  headers: Headers,
  event: unknown,
  webhookId: string,
): Promise<VerifyResult> {
  const signed: Record<string, string> = {};
  for (const [field, header] of Object.entries(SIGNATURE_HEADERS)) {
    const value = headers.get(header);
    if (!value) return { ok: false, reason: `Missing ${header} header` };
    signed[field] = value;
  }
  // PayPal's certificates live on PayPal's own domains; refuse anything else before asking.
  let certHost: string;
  try {
    certHost = new URL(signed.cert_url).hostname;
  } catch {
    return { ok: false, reason: "Bad paypal-cert-url" };
  }
  if (!/(^|\.)paypal\.com$/.test(certHost)) return { ok: false, reason: "paypal-cert-url isn't a PayPal domain" };

  const res = await http.request<{ verification_status?: string }>("POST", "/v1/notifications/verify-webhook-signature", {
    body: { ...signed, webhook_id: webhookId, webhook_event: event },
  });
  return res.body.verification_status === "SUCCESS" ? { ok: true } : { ok: false, reason: "PayPal says the signature doesn't match" };
}
