// PayPal REST over fetch: an OAuth token cached until shortly before it
// expires, JSON in and out, and errors that say whether a retry is safe.
// Sandbox only (master plan §2). Credentials never leave this file's callers.

const SANDBOX = "https://api-m.sandbox.paypal.com";

export class PayPalError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
    readonly debugId: string | null,
    readonly body: unknown,
  ) {
    super(message);
  }

  /** 429, 5xx and network failures: retry with the same request id. */
  get retryable(): boolean {
    return this.status === null || this.status === 429 || this.status >= 500;
  }
}

export interface PayPalResponse<T> {
  status: number;
  debugId: string | null;
  body: T;
}

export interface RequestOptions {
  body?: unknown;
  /** PayPal-Request-Id: PayPal returns the first result if the same id comes again. */
  requestId?: string;
}

export class PayPalHttp {
  private token: { value: string; expiresAt: number } | null = null;

  constructor(
    private readonly creds: { clientId: string; secret: string },
    private readonly fetchFn: typeof fetch = fetch,
    private readonly now: () => number = Date.now,
  ) {}

  static fromEnv(env: Record<string, string | undefined> = process.env): PayPalHttp {
    if (env.PAYPAL_ENVIRONMENT !== "SANDBOX") throw new Error("Pyp runs against the PayPal sandbox only: set PAYPAL_ENVIRONMENT=SANDBOX");
    if (!env.PAYPAL_CLIENT_ID || !env.PAYPAL_CLIENT_SECRET) throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET (sandbox app)");
    return new PayPalHttp({ clientId: env.PAYPAL_CLIENT_ID, secret: env.PAYPAL_CLIENT_SECRET });
  }

  async request<T>(method: "GET" | "POST", path: string, opts: RequestOptions = {}): Promise<PayPalResponse<T>> {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${await this.accessToken()}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
    };
    if (opts.requestId) headers["PayPal-Request-Id"] = opts.requestId;
    const res = await this.send(`${SANDBOX}${path}`, {
      method,
      headers,
      body: opts.body === undefined ? undefined : JSON.stringify(opts.body),
    });
    const debugId = res.headers.get("paypal-debug-id");
    const text = await res.text();
    const body = text ? safeJson(text) : null;
    if (!res.ok) throw new PayPalError(describe(res.status, body), res.status, debugId, body);
    return { status: res.status, debugId, body: body as T };
  }

  private async accessToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    const basic = Buffer.from(`${this.creds.clientId}:${this.creds.secret}`).toString("base64");
    const res = await this.send(`${SANDBOX}/v1/oauth2/token`, {
      method: "POST",
      headers: { Authorization: `Basic ${basic}`, "Content-Type": "application/x-www-form-urlencoded" },
      body: "grant_type=client_credentials",
    });
    const body = safeJson(await res.text()) as { access_token?: string; expires_in?: number } | null;
    if (!res.ok || !body?.access_token) {
      throw new PayPalError(`PayPal sign-in failed (${res.status}); check the sandbox app's keys`, res.status, res.headers.get("paypal-debug-id"), null);
    }
    // Renew a minute early so a token never expires mid-request.
    this.token = { value: body.access_token, expiresAt: this.now() + ((body.expires_in ?? 300) - 60) * 1000 };
    return this.token.value;
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetchFn(url, { ...init, signal: AbortSignal.timeout(30_000) });
    } catch (err) {
      throw new PayPalError(`Couldn't reach PayPal: ${(err as Error).message}`, null, null, null);
    }
  }
}

let shared: PayPalHttp | null = null;

/** One client per server process, so the token is reused across requests. */
export function sharedPayPalHttp(): PayPalHttp {
  shared ??= PayPalHttp.fromEnv();
  return shared;
}

function safeJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/** PayPal's own words for the error, e.g. "Invoice is already paid". */
function describe(status: number, body: unknown): string {
  const b = body as { message?: string; details?: { issue?: string; description?: string }[] } | null;
  const detail = b?.details?.[0];
  return detail?.description ?? detail?.issue ?? b?.message ?? `PayPal returned ${status}`;
}
