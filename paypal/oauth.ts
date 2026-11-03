const PAYPAL_SANDBOX_API = "https://api-m.sandbox.paypal.com";
const PAYPAL_LIVE_API = "https://api-m.paypal.com";

type PayPalEnvironment = "SANDBOX" | "LIVE";

type PayPalTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

export type PartnerReferral = {
  tracking_id: string;
  action_url: string;
};

export class PayPalConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayPalConfigurationError";
  }
}

export class PayPalAuthenticationError extends Error {
  readonly paypalStatus?: number;
  readonly paypalName?: string;
  readonly paypalDebugId?: string;

  constructor(
    message: string,
    details?: { status?: number; name?: string; debugId?: string },
  ) {
    super(message);
    this.name = "PayPalAuthenticationError";
    this.paypalStatus = details?.status;
    this.paypalName = details?.name;
    this.paypalDebugId = details?.debugId;
  }
}

function getEnvironment(): PayPalEnvironment {
  const environment = process.env.PAYPAL_ENVIRONMENT ?? "SANDBOX";
  if (environment !== "SANDBOX" && environment !== "LIVE") {
    throw new PayPalConfigurationError(
      "PAYPAL_ENVIRONMENT must be SANDBOX or LIVE",
    );
  }
  return environment;
}

function getCredentials() {
  const clientId = process.env.PAYPAL_CLIENT_ID;
  const clientSecret = process.env.PAYPAL_CLIENT_SECRET;
  if (!clientId || !clientSecret) {
    throw new PayPalConfigurationError(
      "PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET are required",
    );
  }
  return { clientId, clientSecret };
}

function getApiBase(environment: PayPalEnvironment): string {
  return environment === "SANDBOX" ? PAYPAL_SANDBOX_API : PAYPAL_LIVE_API;
}

export function getPayPalEnvironment(): Lowercase<PayPalEnvironment> {
  return getEnvironment().toLowerCase() as Lowercase<PayPalEnvironment>;
}

export async function getPayPalAccessToken(
  fetcher: typeof fetch = fetch,
): Promise<PayPalTokenResponse> {
  const environment = getEnvironment();
  const { clientId, clientSecret } = getCredentials();
  const apiBase = getApiBase(environment);
  const authorization = Buffer.from(`${clientId}:${clientSecret}`).toString("base64");

  let response: Response;
  try {
    response = await fetcher(`${apiBase}/v1/oauth2/token`, {
      method: "POST",
      headers: {
        Accept: "application/json",
        "Accept-Language": "en_US",
        Authorization: `Basic ${authorization}`,
        "Content-Type": "application/x-www-form-urlencoded",
      },
      body: "grant_type=client_credentials",
      cache: "no-store",
    });
  } catch {
    throw new PayPalAuthenticationError("Could not reach PayPal");
  }

  if (!response.ok) {
    throw new PayPalAuthenticationError(
      `PayPal authentication failed with status ${response.status}`,
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PayPalAuthenticationError("PayPal returned an invalid token response");
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("access_token" in body) ||
    typeof body.access_token !== "string" ||
    !body.access_token ||
    !("token_type" in body) ||
    typeof body.token_type !== "string" ||
    !("expires_in" in body) ||
    typeof body.expires_in !== "number" ||
    !Number.isFinite(body.expires_in) ||
    body.expires_in <= 0
  ) {
    throw new PayPalAuthenticationError("PayPal returned an invalid token response");
  }

  return {
    access_token: body.access_token,
    token_type: body.token_type,
    expires_in: body.expires_in,
  };
}

export async function createPayPalPartnerReferral(
  trackingId: string,
  fetcher: typeof fetch = fetch,
): Promise<PartnerReferral> {
  if (!trackingId) {
    throw new PayPalConfigurationError("A tracking ID is required");
  }

  const environment = getEnvironment();
  const token = await getPayPalAccessToken(fetcher);
  const response = await fetcher(`${getApiBase(environment)}/v2/customer/partner-referrals`, {
    method: "POST",
    headers: {
      Accept: "application/json",
      Authorization: `${token.token_type} ${token.access_token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      operations: [
        {
          operation: "API_INTEGRATION",
          api_integration_preference: {
            rest_api_integration: {
              integration_method: "SDK",
              integration_type: "THIRD_PARTY",
              third_party_details: {
                signup_mode: "VERIFY_WITH_PAYPAL",
                organization: process.env.PAYPAL_PARTNER_ORGANIZATION ?? "Pyp",
              },
            },
          },
        },
      ],
      products: ["PPCP"],
      legal_consents: [{ type: "SHARE_DATA_CONSENT", granted: true }],
      legal_country_code: process.env.PAYPAL_LEGAL_COUNTRY_CODE ?? "US",
      tracking_id: trackingId,
    }),
    cache: "no-store",
  });

  if (!response.ok) {
    let details: unknown;
    try {
      details = await response.json();
    } catch {
      details = undefined;
    }

    const safeDetails =
      details && typeof details === "object"
        ? {
            name:
              "name" in details && typeof details.name === "string"
                ? details.name
                : undefined,
            debugId:
              "debug_id" in details && typeof details.debug_id === "string"
                ? details.debug_id
                : undefined,
          }
        : undefined;
    throw new PayPalAuthenticationError(
      `PayPal partner referral failed with status ${response.status}`,
      { status: response.status, ...safeDetails },
    );
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PayPalAuthenticationError("PayPal returned an invalid referral response");
  }

  if (
    !body ||
    typeof body !== "object" ||
    !("links" in body) ||
    !Array.isArray(body.links)
  ) {
    throw new PayPalAuthenticationError("PayPal returned an invalid referral response");
  }

  const actionLink = body.links.find(
    (link): link is { href: string; rel: string } =>
      !!link &&
      typeof link === "object" &&
      "href" in link &&
      typeof link.href === "string" &&
      "rel" in link &&
      link.rel === "action_url",
  );
  if (!actionLink) {
    throw new PayPalAuthenticationError("PayPal referral response has no onboarding URL");
  }

  return { tracking_id: trackingId, action_url: actionLink.href };
}
