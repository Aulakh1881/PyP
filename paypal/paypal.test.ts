// The PayPal REST layer with fetch faked: sign-in, request ids, errors, and
// turning PayPal's invoices into the engine's shapes.

import { describe, expect, it } from "vitest";
import { PayPalError, PayPalHttp } from "./http";
import { clientsFrom, PayPalReadClient, toInvoice, type PayPalInvoiceResource } from "./engine-reads";
import { PayPalWriteClient } from "./write-client";

function fakeFetch(responses: { status: number; body: unknown; headers?: Record<string, string> }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error("fetch failed");
    return new Response(r.body === null ? null : JSON.stringify(r.body), { status: r.status, headers: r.headers });
  }) as unknown as typeof fetch;
  return { fn, calls };
}

const TOKEN = { status: 200, body: { access_token: "tok", expires_in: 32400 } };

describe("PayPal REST", () => {
  it("signs in once, then reuses the token; writes carry PayPal-Request-Id", async () => {
    const f = fakeFetch([TOKEN, { status: 201, body: { id: "INV2-1", detail: { invoice_number: "0001" } } }, { status: 200, body: {} }]);
    const write = new PayPalWriteClient(new PayPalHttp({ clientId: "id", secret: "s" }, f.fn));
    const made = await write.createDraftInvoice(
      {
        client: { name: "Jordan Kim", businessName: null, email: "jordan.kim@example.com" },
        items: [{ description: "Logo", amount: "300.00" }],
        currency: "USD",
        termType: "NET_30",
        issueDate: "2026-10-31",
        note: "",
      },
      "p1:create",
    );
    await write.sendInvoice(made.invoiceId, "p1:send");

    expect(made).toMatchObject({ invoiceId: "INV2-1", invoiceNumber: "0001" });
    expect(f.calls.map((c) => c.url)).toEqual([
      "https://api-m.sandbox.paypal.com/v1/oauth2/token",
      "https://api-m.sandbox.paypal.com/v2/invoicing/invoices",
      "https://api-m.sandbox.paypal.com/v2/invoicing/invoices/INV2-1/send",
    ]);
    const headers = f.calls.slice(1).map((c) => (c.init.headers as Record<string, string>)["PayPal-Request-Id"]);
    expect(headers).toEqual(["p1:create", "p1:send"]);
    const body = JSON.parse(f.calls[1].init.body as string);
    expect(body.primary_recipients[0].billing_info).toEqual({ email_address: "jordan.kim@example.com", name: { given_name: "Jordan", surname: "Kim" } });
    expect(body.items).toEqual([{ name: "Logo", quantity: "1", unit_amount: { currency_code: "USD", value: "300.00" } }]);
    expect(body.detail).toEqual({ currency_code: "USD", invoice_date: "2026-10-31", payment_term: { term_type: "NET_30" } });
  });

  it("dispute writes and cancel: PayPal's paths and bodies, each with its request id", async () => {
    const f = fakeFetch([TOKEN, ...Array.from({ length: 6 }, () => ({ status: 200, body: {} }))]);
    const write = new PayPalWriteClient(new PayPalHttp({ clientId: "id", secret: "s" }, f.fn));
    await write.provideEvidence("PP-D-1", { evidenceType: "PROOF_OF_FULFILLMENT", tracking: { carrier: "USPS", number: "9400" }, note: "Delivered." }, "p1");
    await write.provideEvidence("PP-D-1", { evidenceType: "OTHER", tracking: null, note: "See thread." }, "p2");
    await write.makeOffer("PP-D-1", { offerType: "REFUND", amount: "300.00", currency: "USD", note: "Sorry." }, "p3");
    await write.sendDisputeMessage("PP-D-1", "Hi Alex", "p4");
    await write.acceptClaim("PP-D-1", { note: "Refunding.", refundAmount: "600.00", currency: "USD" }, "p5");
    await write.cancelInvoice("INV2-1", { note: "Sent in error.", sendToRecipient: true }, "p6");

    const base = "https://api-m.sandbox.paypal.com";
    expect(f.calls.slice(1).map((c) => c.url)).toEqual([
      `${base}/v1/customer/disputes/PP-D-1/provide-evidence`,
      `${base}/v1/customer/disputes/PP-D-1/provide-evidence`,
      `${base}/v1/customer/disputes/PP-D-1/make-offer`,
      `${base}/v1/customer/disputes/PP-D-1/send-message`,
      `${base}/v1/customer/disputes/PP-D-1/accept-claim`,
      `${base}/v2/invoicing/invoices/INV2-1/cancel`,
    ]);
    const hdr = (i: number) => f.calls[i].init.headers as Record<string, string>;
    expect([1, 2, 3, 4, 5, 6].map((i) => hdr(i)["PayPal-Request-Id"])).toEqual(["p1", "p2", "p3", "p4", "p5", "p6"]);

    // Evidence is multipart: one JSON part named "input", with no filename.
    const ct = hdr(1)["Content-Type"];
    expect(ct).toMatch(/^multipart\/form-data; boundary=pyp-/);
    const boundary = ct.split("boundary=")[1];
    const raw = f.calls[1].init.body as string;
    expect(raw.startsWith(`--${boundary}\r\nContent-Disposition: form-data; name="input"\r\nContent-Type: application/json\r\n\r\n`)).toBe(true);
    expect(raw.endsWith(`\r\n--${boundary}--\r\n`)).toBe(true);
    expect(raw).not.toContain("filename");
    const input = (i: number) => JSON.parse((f.calls[i].init.body as string).split("\r\n\r\n")[1].split("\r\n--")[0]);
    expect(input(1)).toEqual({
      evidences: [
        { evidence_type: "PROOF_OF_FULFILLMENT", evidence_info: { tracking_info: [{ carrier_name: "USPS", tracking_number: "9400" }] }, notes: "Delivered." },
      ],
    });
    expect(input(2)).toEqual({ evidences: [{ evidence_type: "OTHER", notes: "See thread." }] });

    const json = (i: number) => JSON.parse(f.calls[i].init.body as string);
    expect(hdr(3)["Content-Type"]).toBe("application/json");
    expect(json(3)).toEqual({ note: "Sorry.", offer_amount: { currency_code: "USD", value: "300.00" }, offer_type: "REFUND" });
    expect(json(4)).toEqual({ message: "Hi Alex" });
    expect(json(5)).toEqual({ note: "Refunding.", refund_amount: { currency_code: "USD", value: "600.00" } });
    expect(json(6)).toEqual({ note: "Sent in error.", send_to_invoicer: false, send_to_recipient: true });
  });

  it("errors carry PayPal's own words and say whether a retry is safe", async () => {
    const f = fakeFetch([
      TOKEN,
      { status: 422, body: { message: "Unprocessable", details: [{ issue: "INVOICE_ALREADY_PAID", description: "Invoice is already paid" }] }, headers: { "paypal-debug-id": "abc" } },
      { status: 503, body: null },
    ]);
    const http = new PayPalHttp({ clientId: "id", secret: "s" }, f.fn);
    const a = await http.request("POST", "/x").catch((e) => e);
    expect(a).toBeInstanceOf(PayPalError);
    expect(a).toMatchObject({ message: "Invoice is already paid", status: 422, debugId: "abc", retryable: false });
    const b = await http.request("POST", "/x").catch((e) => e);
    expect(b).toMatchObject({ status: 503, retryable: true });
    const c = await http.request("POST", "/x").catch((e) => e); // network failure
    expect(c).toMatchObject({ status: null, retryable: true });
  });

  it("requests that start together sign in once", async () => {
    const f = fakeFetch([TOKEN, { status: 200, body: { a: 1 } }, { status: 200, body: { b: 2 } }]);
    const http = new PayPalHttp({ clientId: "id", secret: "s" }, f.fn);
    await Promise.all([http.request("GET", "/a"), http.request("GET", "/b")]);
    expect(f.calls.filter((c) => c.url.endsWith("/v1/oauth2/token"))).toHaveLength(1);
  });

  it("refuses anything but the sandbox, and says which keys are missing", () => {
    expect(() => PayPalHttp.fromEnv({ PAYPAL_ENVIRONMENT: "LIVE", PAYPAL_CLIENT_ID: "a", PAYPAL_CLIENT_SECRET: "b" })).toThrow(/sandbox only/);
    expect(() => PayPalHttp.fromEnv({ PAYPAL_ENVIRONMENT: "SANDBOX" })).toThrow(/PAYPAL_CLIENT_ID/);
  });

  it("a bad sign-in never leaks the keys into the error", async () => {
    const f = fakeFetch([{ status: 401, body: { error: "invalid_client" } }]);
    const err = await new PayPalHttp({ clientId: "my-id", secret: "my-secret" }, f.fn).request("GET", "/x").catch((e) => e);
    expect(err.message).toMatch(/sign-in failed \(401\)/);
    expect(JSON.stringify(err)).not.toMatch(/my-secret/);
  });
});

describe("reading invoices", () => {
  const inv = (id: string, email: string | undefined, created: string, name?: string): PayPalInvoiceResource => ({
    id,
    status: "SENT",
    detail: { invoice_number: id, currency_code: "USD", metadata: { create_time: created } },
    primary_recipients: [{ billing_info: { email_address: email, name: name ? { full_name: name } : undefined } }],
    amount: { currency_code: "USD", value: "100.00" },
  });

  it("clients come newest first, one per email (case-insensitive), skipping invoices with no email", () => {
    const clients = clientsFrom([
      inv("1", "sam@acme.example", "2026-10-01T00:00:00Z", "Sam Lee"),
      inv("2", "jordan@example.com", "2026-10-20T00:00:00Z", "Jordan Kim"),
      inv("3", "SAM@acme.example", "2026-10-25T00:00:00Z", "Sam Lee"),
      inv("4", undefined, "2026-10-30T00:00:00Z"),
    ]);
    expect(clients).toEqual([
      { id: "cl_1", name: "Sam Lee", businessName: null, email: "SAM@acme.example" },
      { id: "cl_2", name: "Jordan Kim", businessName: null, email: "jordan@example.com" },
    ]);
  });

  it("overdue sweep read: searches open invoices due before today, then filters and sorts in code", async () => {
    const due = (id: string, status: string, dueDate: string): PayPalInvoiceResource => ({
      ...inv(id, "a@b.example", "2026-10-01T00:00:00Z"),
      status,
      detail: { invoice_number: id, currency_code: "USD", payment_term: { due_date: dueDate } },
    } as PayPalInvoiceResource);
    const f = fakeFetch([
      TOKEN,
      { status: 200, body: { items: [due("late", "UNPAID", "2026-10-20"), due("today", "SENT", "2026-11-07"), due("paid", "PAID", "2026-10-01"), due("older", "SENT", "2026-10-10")] } },
    ]);
    const read = new PayPalReadClient(new PayPalHttp({ clientId: "id", secret: "s" }, f.fn));
    const out = await read.overdueInvoices("2026-11-07");
    expect(out.map((i) => i.id)).toEqual(["older", "late"]);
    expect(f.calls[1].url).toContain("/v2/invoicing/search-invoices");
    expect(JSON.parse(f.calls[1].init.body as string)).toEqual({
      status: ["SENT", "UNPAID", "PARTIALLY_PAID"],
      due_date_range: { start: "2000-01-01", end: "2026-11-06" },
    });
  });

  it("an invoice keeps PayPal's decimal strings; amount due falls back to the total", () => {
    expect(toInvoice(inv("9", "a@b.example", "2026-10-01T00:00:00Z"))).toMatchObject({ total: "100.00", amountDue: "100.00", number: "9", dueDate: null });
  });
});
