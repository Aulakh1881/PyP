import { afterEach, describe, expect, it, vi } from "vitest";
import {
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
});
