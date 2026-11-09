// REST writes. Imported only by executor/ (lint rule + evals/boundary.test.ts).
// Every write carries a PayPal-Request-Id, so repeating it can't act twice.

import { PayPalError, type PayPalHttp } from "./http";
import type { PayPalInvoiceResource } from "./engine-reads";

/** invoice.createAndSend's resolved values (skills/collections/commands/create-and-send.ts). */
export interface NewInvoice {
  client: { name: string | null; businessName: string | null; email: string };
  items: { description: string; amount: string }[];
  currency: string;
  termType: string;
  issueDate: string;
  note: string;
}

export class PayPalWriteClient {
  constructor(private readonly http: PayPalHttp) {}

  /** Creates a draft. Returns PayPal's invoice id and number. */
  async createDraftInvoice(inv: NewInvoice, requestId: string) {
    const [given, ...rest] = (inv.client.name ?? "").split(/\s+/).filter(Boolean);
    const res = await this.http.request<Partial<PayPalInvoiceResource> & { href?: string }>("POST", "/v2/invoicing/invoices", {
      requestId,
      body: {
        detail: {
          currency_code: inv.currency,
          invoice_date: inv.issueDate,
          payment_term: { term_type: inv.termType },
          ...(inv.note ? { note: inv.note } : {}),
        },
        primary_recipients: [
          {
            billing_info: {
              email_address: inv.client.email,
              ...(given ? { name: { given_name: given, ...(rest.length ? { surname: rest.join(" ") } : {}) } } : {}),
              ...(inv.client.businessName ? { business_name: inv.client.businessName } : {}),
            },
          },
        ],
        items: inv.items.map((i) => ({
          name: i.description,
          quantity: "1",
          unit_amount: { currency_code: inv.currency, value: i.amount },
        })),
      },
    });
    // With Prefer: return=representation PayPal sends the invoice; older paths send only a link.
    const id = res.body.id ?? res.body.href?.split("/").pop();
    if (!id) throw new PayPalError("PayPal created the invoice but returned no id", res.status, res.debugId, res.body);
    return { invoiceId: id, invoiceNumber: res.body.detail?.invoice_number ?? null, response: res };
  }

  async sendInvoice(invoiceId: string, requestId: string) {
    return this.http.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/send`, {
      requestId,
      body: { send_to_invoicer: false, send_to_recipient: true },
    });
  }

  async remindInvoice(invoiceId: string, msg: { subject: string; note: string }, requestId: string) {
    return this.http.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/remind`, {
      requestId,
      body: { subject: msg.subject, note: msg.note, send_to_invoicer: false, send_to_recipient: true },
    });
  }

  /** PayPal emails the client the note. Refused (422) if the invoice has a payment. */
  async cancelInvoice(invoiceId: string, msg: { note: string; sendToRecipient: boolean }, requestId: string) {
    return this.http.request("POST", `/v2/invoicing/invoices/${encodeURIComponent(invoiceId)}/cancel`, {
      requestId,
      body: { note: msg.note, send_to_invoicer: false, send_to_recipient: msg.sendToRecipient },
    });
  }

  // Disputes v1. The dispute endpoints don't document PayPal-Request-Id; we send it
  // anyway, and a repeat that PayPal doesn't recognise fails with its own 422.

  /** Multipart with a JSON "input" part (no files): tracking for proof of fulfillment, and notes. */
  async provideEvidence(disputeId: string, ev: DisputeEvidence, requestId: string) {
    const evidence = {
      evidence_type: ev.evidenceType,
      ...(ev.tracking ? { evidence_info: { tracking_info: [{ carrier_name: ev.tracking.carrier, tracking_number: ev.tracking.number }] } } : {}),
      notes: ev.note,
    };
    return this.http.request("POST", `${disputePath(disputeId)}/provide-evidence`, {
      requestId,
      multipart: [{ name: "input", contentType: "application/json", content: JSON.stringify({ evidences: [evidence] }) }],
    });
  }

  async makeOffer(disputeId: string, offer: DisputeOffer, requestId: string) {
    return this.http.request("POST", `${disputePath(disputeId)}/make-offer`, {
      requestId,
      body: { note: offer.note, offer_amount: { currency_code: offer.currency, value: offer.amount }, offer_type: offer.offerType },
    });
  }

  async sendDisputeMessage(disputeId: string, message: string, requestId: string) {
    return this.http.request("POST", `${disputePath(disputeId)}/send-message`, { requestId, body: { message } });
  }

  /** The buyer is refunded `refundAmount` (code's value: the disputed amount) and the dispute closes. */
  async acceptClaim(disputeId: string, claim: { note: string; refundAmount: string; currency: string }, requestId: string) {
    return this.http.request("POST", `${disputePath(disputeId)}/accept-claim`, {
      requestId,
      body: { note: claim.note, refund_amount: { currency_code: claim.currency, value: claim.refundAmount } },
    });
  }
}

/** dispute.provideEvidence's resolved values (skills/disputes/commands/provide-evidence.ts). */
export interface DisputeEvidence {
  evidenceType: string;
  tracking: { carrier: string; number: string } | null;
  note: string;
}

/** dispute.makeOffer's resolved values (skills/disputes/commands/make-offer.ts). */
export interface DisputeOffer {
  offerType: string;
  amount: string;
  currency: string;
  note: string;
}

const disputePath = (id: string) => `/v1/customer/disputes/${encodeURIComponent(id)}`;
