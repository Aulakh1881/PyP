import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createPayPalPartnerReferral,
  getPayPalAccessToken,
  PayPalAuthenticationError,
  PayPalConfigurationError,
} from "./oauth";

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("getPayPalAccessToken", () => {
  it("requests a sandbox token without exposing credentials in the response", async () => {
    vi.stubEnv("PAYPAL_ENVIRONMENT", "SANDBOX");
    vi.stubEnv("PAYPAL_CLIENT_ID", "client-id");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "client-secret");
    const fetcher = vi.fn<typeof fetch>().mockResolvedValue(
      new Response(
        JSON.stringify({
          access_token: "access-token",
          token_type: "Bearer",
          expires_in: 900,
        }),
        { status: 200 },
      ),
    );

    await expect(getPayPalAccessToken(fetcher)).resolves.toEqual({
      access_token: "access-token",
      token_type: "Bearer",
      expires_in: 900,
    });
    expect(fetcher).toHaveBeenCalledWith(
      "https://api-m.sandbox.paypal.com/v1/oauth2/token",
      expect.objectContaining({
        method: "POST",
        body: "grant_type=client_credentials",
        headers: expect.objectContaining({
          Authorization: `Basic ${Buffer.from("client-id:client-secret").toString("base64")}`,
        }),
      }),
    );
  });

  it("fails clearly when credentials are missing", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "");

    await expect(getPayPalAccessToken(vi.fn<typeof fetch>())).rejects.toBeInstanceOf(
      PayPalConfigurationError,
    );
  });

  it("does not accept an unsuccessful or malformed token response", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "client-id");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "client-secret");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValue(new Response("{}", { status: 401 }));

    await expect(getPayPalAccessToken(fetcher)).rejects.toBeInstanceOf(
      PayPalAuthenticationError,
    );
  });

  it("creates a referral and returns only the onboarding action URL", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "client-id");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "client-secret");
    const fetcher = vi
      .fn<typeof fetch>()
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({ access_token: "access-token", token_type: "Bearer", expires_in: 900 }),
          { status: 200 },
        ),
      )
      .mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            links: [{ rel: "action_url", href: "https://www.sandbox.paypal.com/onboard" }],
          }),
          { status: 201 },
        ),
      );

    await expect(createPayPalPartnerReferral("pyp:user-1", fetcher)).resolves.toEqual({
      tracking_id: "pyp:user-1",
      action_url: "https://www.sandbox.paypal.com/onboard",
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      "https://api-m.sandbox.paypal.com/v2/customer/partner-referrals",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ Authorization: "Bearer access-token" }),
        body: expect.stringContaining('"tracking_id":"pyp:user-1"'),
      }),
    );
  });
});
