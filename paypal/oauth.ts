const PAYPAL_SANDBOX_API = "https://api-m.sandbox.paypal.com";
const PAYPAL_LIVE_API = "https://api-m.paypal.com";

type PayPalEnvironment = "SANDBOX" | "LIVE";

type PayPalTokenResponse = {
  access_token: string;
  token_type: string;
  expires_in: number;
};

export class PayPalConfigurationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayPalConfigurationError";
  }
}

export class PayPalAuthenticationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "PayPalAuthenticationError";
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
