import { afterEach, describe, expect, it, vi } from "vitest";
import { getPayPalBalances, getPayPalInvoices, getPayPalTransactions, PayPalReadError } from "./read-client";

afterEach(() => {
  vi.unstubAllEnvs();
});

function fetcherFor(...responses: Response[]) {
  const fetcher = vi.fn<typeof fetch>();
  responses.forEach((response) => fetcher.mockResolvedValueOnce(response));
  return fetcher;
}

describe("PayPal read client", () => {
  it("reads balances after obtaining an OAuth token", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "client-id");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "client-secret");
    const fetcher = fetcherFor(
      new Response(JSON.stringify({
        access_token: "access-token",
        token_type: "Bearer",
        expires_in: 900,
      })),
      new Response(JSON.stringify({
        balances: [{
          total_balance: { currency_code: "USD", value: "125.00" },
          withheld_balance: { currency_code: "USD", value: "5.00" },
        }],
      })),
    );

    await expect(getPayPalBalances(fetcher)).resolves.toEqual([{
      currency: "USD",
      available: "125.00",
      withheld: "5.00",
    }]);
  });

  it("normalizes transaction details", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "client-id");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "client-secret");
    const fetcher = fetcherFor(
      new Response(JSON.stringify({
        access_token: "access-token",
        token_type: "Bearer",
        expires_in: 900,
      })),
      new Response(JSON.stringify({
        total_items: 1,
        transaction_details: [{
          transaction_info: {
            transaction_id: "TX-1",
            transaction_initiation_date: "2026-11-03T10:00:00Z",
            transaction_event_code: "T0001",
            transaction_status: "S",
            transaction_amount: { currency_code: "USD", value: "25.00" },
            fee_amount: { currency_code: "USD", value: "-0.99" },
            net_amount: { currency_code: "USD", value: "24.01" },
          },
          payer_info: {
            payer_name: { alternate_full_name: "Sandbox Buyer" },
          },
        }],
      })),
    );

    await expect(
      getPayPalTransactions("2026-11-01T00:00:00Z", "2026-11-03T23:59:59Z", fetcher),
    ).resolves.toEqual({
      totalItems: 1,
      page: 1,
      pageSize: 100,
      transactions: [{
        id: "TX-1",
        date: "2026-11-03T10:00:00Z",
        type: "T0001",
        typeLabel: "Payment",
        status: "S",
        statusLabel: "Success",
        amount: "25.00",
        currency: "USD",
        fee: "-0.99",
        net: "24.01",
        subject: "Sandbox Buyer",
      }],
    });
  });

  it("requests a selected page and labels unknown transaction codes safely", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "client-id");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "client-secret");
    const fetcher = fetcherFor(
      new Response(JSON.stringify({
        access_token: "access-token",
        token_type: "Bearer",
        expires_in: 900,
      })),
      new Response(JSON.stringify({
        total_items: 26,
        transaction_details: [{
          transaction_info: {
            transaction_id: "TX-2",
            transaction_event_code: "T9999",
            transaction_status: "P",
          },
        }],
      })),
    );

    await expect(
      getPayPalTransactions(
        "2026-11-01T00:00:00Z",
        "2026-11-03T23:59:59Z",
        { page: 2, pageSize: 25 },
        fetcher,
      ),
    ).resolves.toMatchObject({
      totalItems: 26,
      page: 2,
      pageSize: 25,
      transactions: [{
        typeLabel: "PayPal transaction (T9999)",
        statusLabel: "Pending",
      }],
    });
    expect(fetcher).toHaveBeenLastCalledWith(
      expect.stringContaining("page=2&page_size=25"),
      expect.any(Object),
    );
  });

  it("reports PayPal read failures without returning raw response bodies", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "client-id");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "client-secret");
    const fetcher = fetcherFor(
      new Response(JSON.stringify({
        access_token: "access-token",
        token_type: "Bearer",
        expires_in: 900,
      })),
      new Response(JSON.stringify({ name: "PERMISSION_DENIED", debug_id: "debug-id" }), { status: 403 }),
    );

    await expect(getPayPalBalances(fetcher)).rejects.toMatchObject({
      name: "PayPalReadError",
      status: 403,
      debugId: "debug-id",
    } satisfies Partial<PayPalReadError>);
  });

  it("normalizes invoice details and recipient information", async () => {
    vi.stubEnv("PAYPAL_CLIENT_ID", "client-id");
    vi.stubEnv("PAYPAL_CLIENT_SECRET", "client-secret");
    const fetcher = fetcherFor(
      new Response(JSON.stringify({
        access_token: "access-token",
        token_type: "Bearer",
        expires_in: 900,
      })),
      new Response(JSON.stringify({
        total_items: 1,
        items: [{
          id: "INV-1",
          status: "PAID",
          detail: {
            invoice_number: "INV-1001",
            invoice_date: "2026-11-01",
            due_date: "2026-11-15",
          },
          primary_recipients: [{
            billing_info: {
              name: { given_name: "Sandbox", surname: "Buyer" },
              email_address: "buyer@example.com",
            },
          }],
          amount: { currency_code: "USD", value: "25.00" },
          due_amount: { currency_code: "USD", value: "0.00" },
        }],
      })),
    );

    await expect(getPayPalInvoices({ page: 2, pageSize: 10 }, fetcher)).resolves.toEqual({
      totalItems: 1,
      page: 2,
      pageSize: 10,
      invoices: [{
        id: "INV-1",
        number: "INV-1001",
        status: "PAID",
        statusLabel: "Paid",
        date: "2026-11-01",
        dueDate: "2026-11-15",
        recipient: "Sandbox Buyer",
        amount: "25.00",
        dueAmount: "0.00",
        currency: "USD",
      }],
    });
  });
});
