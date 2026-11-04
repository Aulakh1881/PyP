// The engine's PayPal reads with fetch faked: disputes, a client's past
// invoices, the open items chat chooses from, and webhook verification.
// Field names follow PayPal's v1/v2 references; none of this has run against
// the live sandbox yet.

import { describe, expect, it } from "vitest";
import { subjectFor } from "@/jobs/event-run";
import { PayPalHttp } from "./http";
import { PayPalReadClient, toDispute, toInvoice, type PayPalDisputeResource, type PayPalInvoiceResource } from "./engine-reads";
import { verifyWebhook } from "./webhook-verify";

function fakeFetch(responses: { status: number; body: unknown }[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fn = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const r = responses.shift();
    if (!r) throw new Error("fetch failed");
    return new Response(r.body === null ? null : JSON.stringify(r.body), { status: r.status });
  }) as unknown as typeof fetch;
  return { fn, calls, http: new PayPalHttp({ clientId: "id", secret: "s" }, fn) };
}

const TOKEN = { status: 200, body: { access_token: "tok", expires_in: 32400 } };

const dispute: PayPalDisputeResource = {
  dispute_id: "PP-D-123",
  status: "WAITING_FOR_SELLER_RESPONSE",
  reason: "MERCHANDISE_OR_SERVICE_NOT_RECEIVED",
  dispute_life_cycle_stage: "INQUIRY",
  dispute_amount: { currency_code: "USD", value: "600.00" },
  seller_response_due_date: "2026-11-06T15:00:00Z",
  create_time: "2026-10-27T10:00:00Z",
  disputed_transactions: [{ seller_transaction_id: "TX-55", buyer: { name: "Alex Rivera" }, items: [{ item_name: "Kit", item_quantity: "2" }] }],
  messages: [
    { posted_by: "SELLER", time_posted: "2026-10-28T09:00:00Z", content: "Looking into it." },
    { posted_by: "BUYER", time_posted: "2026-10-27T10:00:00Z", content: "Never arrived." },
  ],
};

const paidInvoice = (id: string, created: string, paid: string): PayPalInvoiceResource => ({
  id,
  status: "PAID",
  detail: { invoice_number: id, currency_code: "USD", metadata: { create_time: created }, payment_term: { due_date: "2026-09-21" } },
  amount: { currency_code: "USD", value: "100.00" },
  due_amount: { currency_code: "USD", value: "0.00" },
  payments: { transactions: [{ payment_date: "2026-09-20" }, { payment_date: paid }] },
});

describe("engine reads", () => {
  it("a paid invoice's paidDate is its last payment; an unpaid one has none", () => {
    expect(toInvoice(paidInvoice("A", "2026-09-01T00:00:00Z", "2026-09-25")).paidDate).toBe("2026-09-25");
    expect(toInvoice({ ...paidInvoice("B", "", "2026-09-25"), status: "PARTIALLY_PAID" }).paidDate).toBeNull();
  });

  it("a dispute maps to the engine's shape, messages oldest first", () => {
    const d = toDispute(dispute, [{ carrier: "USPS", number: "9400", status: "DELIVERED" }]);
    expect(d).toMatchObject({ id: "PP-D-123", status: "WAITING_FOR_SELLER_RESPONSE", amount: "600.00", transactionId: "TX-55", buyerName: "Alex Rivera" });
    expect(d.items).toEqual([{ name: "Kit", quantity: 2 }]);
    expect(d.messages.map((m) => m.postedBy)).toEqual(["BUYER", "SELLER"]);
    expect(toDispute({ ...dispute, status: "SOMETHING_NEW" }).status).toBe("OTHER");
  });

  it("getDispute adds tracking for the transaction; a 404 is null", async () => {
    const f = fakeFetch([
      TOKEN,
      { status: 200, body: dispute },
      { status: 200, body: { trackers: [{ tracking_number: "9400", carrier: "USPS", status: "DELIVERED" }] } },
      { status: 404, body: { name: "RESOURCE_NOT_FOUND" } },
    ]);
    const read = new PayPalReadClient(f.http);
    expect((await read.getDispute("PP-D-123"))?.tracking).toEqual([{ carrier: "USPS", number: "9400", status: "DELIVERED" }]);
    expect(f.calls[2].url).toContain("/v1/shipping/trackers?transaction_id=TX-55");
    expect(await read.getDispute("nope")).toBeNull();
  });

  it("no tracking found is no tracking, not an error", async () => {
    const f = fakeFetch([TOKEN, { status: 200, body: dispute }, { status: 404, body: {} }]);
    expect((await new PayPalReadClient(f.http).getDispute("PP-D-123"))?.tracking).toEqual([]);
  });

  it("clientInvoices searches by recipient email, newest first", async () => {
    const f = fakeFetch([TOKEN, { status: 200, body: { items: [paidInvoice("OLD", "2026-08-01T00:00:00Z", "2026-08-30"), paidInvoice("NEW", "2026-09-01T00:00:00Z", "2026-09-25")] } }]);
    const got = await new PayPalReadClient(f.http).clientInvoices("sam@acme.example", 11);
    expect(got.map((i) => i.id)).toEqual(["NEW", "OLD"]);
    expect(f.calls[1].url).toContain("/v2/invoicing/search-invoices?page=1&page_size=11");
    expect(f.calls[1].init.method).toBe("POST");
    expect(JSON.parse(String(f.calls[1].init.body))).toEqual({ recipient_email: "sam@acme.example" });
  });

  it("openSubjects lists open disputes and unpaid invoices, one line each", async () => {
    const unpaid: PayPalInvoiceResource = {
      id: "INV2-1",
      status: "UNPAID",
      detail: { invoice_number: "0042", currency_code: "USD", payment_term: { due_date: "2026-10-21" } },
      primary_recipients: [{ billing_info: { name: { full_name: "Sam Lee" }, email_address: "sam@acme.example" } }],
      amount: { currency_code: "USD", value: "1200.00" },
      due_amount: { currency_code: "USD", value: "1200.00" },
    };
    const f = fakeFetch([
      TOKEN,
      { status: 200, body: { items: [unpaid, paidInvoice("PAIDONE", "", "2026-09-01")] } },
      { status: 200, body: { items: [dispute, { ...dispute, dispute_id: "PP-D-OLD", status: "RESOLVED" }] } },
    ]);
    expect(await new PayPalReadClient(f.http).openSubjects()).toEqual([
      { kind: "dispute", id: "PP-D-123", label: "Dispute PP-D-123 · merchandise or service not received · $600.00 · respond by 2026-11-06" },
      { kind: "invoice", id: "INV2-1", label: "Invoice 0042 · Sam Lee · $1,200.00 due · due 2026-10-21" },
    ]);
  });
});

describe("webhooks", () => {
  const headers = (over: Record<string, string> = {}) =>
    new Headers({
      "paypal-auth-algo": "SHA256withRSA",
      "paypal-cert-url": "https://api.sandbox.paypal.com/v1/notifications/certs/CERT-1",
      "paypal-transmission-id": "t1",
      "paypal-transmission-sig": "sig",
      "paypal-transmission-time": "2026-11-04T00:00:00Z",
      ...over,
    });
  const event = { id: "WH-1", event_type: "INVOICING.INVOICE.PAID", resource: { invoice: { id: "INV2-1" } } };

  it("asks PayPal to verify, sending the headers, our webhook id and the event", async () => {
    const f = fakeFetch([TOKEN, { status: 200, body: { verification_status: "SUCCESS" } }]);
    expect(await verifyWebhook(f.http, headers(), event, "WHID")).toEqual({ ok: true });
    expect(JSON.parse(String(f.calls[1].init.body))).toMatchObject({ transmission_id: "t1", webhook_id: "WHID", webhook_event: event });
  });

  it("refuses a failed check, a missing header, or a certificate off PayPal's domains, without asking PayPal", async () => {
    const fail = fakeFetch([TOKEN, { status: 200, body: { verification_status: "FAILURE" } }]);
    expect((await verifyWebhook(fail.http, headers(), event, "W")).ok).toBe(false);
    const none = fakeFetch([]);
    expect(await verifyWebhook(none.http, headers({ "paypal-transmission-sig": "" }), event, "W")).toMatchObject({ ok: false });
    expect(await verifyWebhook(none.http, headers({ "paypal-cert-url": "https://paypal.com.evil.example/cert" }), event, "W")).toEqual({
      ok: false,
      reason: "paypal-cert-url isn't a PayPal domain",
    });
    expect(none.calls).toHaveLength(0);
  });

  it("an event names its invoice or dispute; anything else is ignored", () => {
    expect(subjectFor(event)).toEqual({ kind: "invoice", id: "INV2-1" });
    expect(subjectFor({ id: "x", event_type: "INVOICING.INVOICE.CANCELLED", resource: { id: "INV2-2" } })).toEqual({ kind: "invoice", id: "INV2-2" });
    expect(subjectFor({ id: "x", event_type: "CUSTOMER.DISPUTE.CREATED", resource: { dispute_id: "PP-D-1" } })).toEqual({ kind: "dispute", id: "PP-D-1" });
    expect(subjectFor({ id: "x", event_type: "PAYMENT.CAPTURE.COMPLETED", resource: { id: "C1" } })).toBeNull();
  });
});
