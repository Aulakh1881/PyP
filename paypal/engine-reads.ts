// REST reads behind the engine's PayPalReads (engine/README.md §1). The plan
// is PayPal's MCP server first with REST for the gaps; until mcp-read-client
// exists, REST covers these reads. Nothing here writes.
//
// read-client.ts holds the dashboard's reads (normalized for display);
// this file holds the engine's (normalized into engine/types.ts shapes).

import type { ChatSubject } from "@/engine/chat";
import { formatMoney } from "@/engine/format";
import type { Client, Dispute, DisputeStatus, Invoice, InvoiceStatus, PayPalReads, Transaction } from "@/engine/types";
import { PayPalError, type PayPalHttp } from "./http";

/** The parts of a PayPal Invoicing v2 invoice we read. */
export interface PayPalInvoiceResource {
  id: string;
  status: InvoiceStatus;
  detail: {
    invoice_number?: string;
    currency_code: string;
    invoice_date?: string;
    payment_term?: { term_type?: string; due_date?: string };
    metadata?: { create_time?: string };
  };
  primary_recipients?: {
    billing_info?: {
      name?: { given_name?: string; surname?: string; full_name?: string };
      business_name?: string;
      email_address?: string;
    };
  }[];
  amount?: { currency_code: string; value: string };
  due_amount?: { currency_code: string; value: string };
  payments?: { transactions?: { payment_date?: string }[] };
}

/** The parts of a PayPal Disputes v1 dispute we read. */
export interface PayPalDisputeResource {
  dispute_id: string;
  status?: string;
  reason?: string;
  dispute_life_cycle_stage?: string;
  dispute_amount?: { currency_code: string; value: string };
  seller_response_due_date?: string;
  create_time?: string;
  disputed_transactions?: {
    seller_transaction_id?: string;
    buyer?: { name?: string };
    items?: { item_name?: string; item_quantity?: string }[];
  }[];
  messages?: { posted_by?: string; time_posted?: string; content?: string }[];
}

const PAID_STATUSES: InvoiceStatus[] = ["PAID", "MARKED_AS_PAID"];
const OPEN_INVOICE: InvoiceStatus[] = ["SENT", "UNPAID", "PARTIALLY_PAID"];
const DISPUTE_STATUSES: DisputeStatus[] = ["OPEN", "WAITING_FOR_SELLER_RESPONSE", "WAITING_FOR_BUYER_RESPONSE", "UNDER_REVIEW", "RESOLVED", "OTHER"];
const OPEN_DISPUTE: DisputeStatus[] = ["OPEN", "WAITING_FOR_SELLER_RESPONSE", "WAITING_FOR_BUYER_RESPONSE"];

/** How many recent invoices we scan for the client list. */
const CLIENT_SCAN = 100;

export function toInvoice(p: PayPalInvoiceResource): Invoice {
  const billing = p.primary_recipients?.[0]?.billing_info;
  const total = p.amount?.value ?? "0.00";
  return {
    id: p.id,
    number: p.detail.invoice_number ?? p.id,
    status: p.status,
    currency: p.detail.currency_code,
    total,
    amountDue: p.due_amount?.value ?? total,
    dueDate: p.detail.payment_term?.due_date ?? null,
    recipientName: personName(billing?.name),
    recipientEmail: billing?.email_address ?? null,
    // The last payment's date settles it (client history counts days late from it).
    paidDate: PAID_STATUSES.includes(p.status) ? (p.payments?.transactions?.at(-1)?.payment_date?.slice(0, 10) ?? null) : null,
  };
}

/**
 * PayPal's dispute plus the merchant's shipment tracking for its
 * transaction. Unverified against the live sandbox: field names follow the
 * Disputes v1 and Tracking v1 references.
 */
export function toDispute(d: PayPalDisputeResource, tracking: Dispute["tracking"] = []): Dispute {
  const tx = d.disputed_transactions?.[0];
  const status = (DISPUTE_STATUSES as string[]).includes(d.status ?? "") ? (d.status as DisputeStatus) : "OTHER";
  return {
    id: d.dispute_id,
    status,
    reason: d.reason ?? "OTHER",
    stage: d.dispute_life_cycle_stage ?? null,
    currency: d.dispute_amount?.currency_code ?? "USD",
    amount: d.dispute_amount?.value ?? "0.00",
    sellerResponseDueDate: d.seller_response_due_date ?? null,
    createdAt: d.create_time ?? "",
    transactionId: tx?.seller_transaction_id ?? null,
    buyerName: tx?.buyer?.name ?? null,
    items: (tx?.items ?? []).map((i) => ({ name: i.item_name ?? "Item", quantity: Number(i.item_quantity ?? "1") || 1 })),
    messages: (d.messages ?? [])
      .filter((m) => m.content)
      .map((m) => ({ postedBy: m.posted_by === "SELLER" ? ("SELLER" as const) : ("BUYER" as const), at: m.time_posted ?? "", text: m.content! }))
      .sort((a, b) => a.at.localeCompare(b.at)),
    tracking,
  };
}

const TRACKING_STATUS: Record<string, Dispute["tracking"][number]["status"]> = {
  DELIVERED: "DELIVERED",
  SHIPPED: "SHIPPED",
  IN_TRANSIT: "IN_TRANSIT",
};

export class PayPalReadClient implements PayPalReads {
  constructor(private readonly http: PayPalHttp) {}

  async getInvoice(id: string): Promise<Invoice | null> {
    try {
      const res = await this.http.request<PayPalInvoiceResource>("GET", `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
      return toInvoice(res.body);
    } catch (err) {
      if (err instanceof PayPalError && err.status === 404) return null;
      throw err;
    }
  }

  /** Everyone the merchant has invoiced, newest first, one entry per email. */
  async recentClients(): Promise<Client[]> {
    const res = await this.http.request<{ items?: PayPalInvoiceResource[] }>(
      "GET",
      `/v2/invoicing/invoices?page=1&page_size=${CLIENT_SCAN}&total_required=false`,
    );
    return clientsFrom(res.body.items ?? []);
  }

  /** Earlier invoices to one recipient, newest first (search-invoices: the list call can't filter). */
  async clientInvoices(email: string, limit: number): Promise<Invoice[]> {
    const res = await this.http.request<{ items?: PayPalInvoiceResource[] }>(
      "POST",
      `/v2/invoicing/search-invoices?page=1&page_size=${Math.min(Math.max(limit, 1), 100)}&total_required=false`,
      { body: { recipient_email: email } },
    );
    return [...(res.body.items ?? [])].sort((a, b) => created(b).localeCompare(created(a))).map(toInvoice);
  }

  async getDispute(id: string): Promise<Dispute | null> {
    let d: PayPalDisputeResource;
    try {
      d = (await this.http.request<PayPalDisputeResource>("GET", `/v1/customer/disputes/${encodeURIComponent(id)}`)).body;
    } catch (err) {
      if (err instanceof PayPalError && err.status === 404) return null;
      throw err;
    }
    return toDispute(d, await this.tracking(d.disputed_transactions?.[0]?.seller_transaction_id));
  }

  /** The merchant's shipment tracking for a transaction. Best effort: none found = no tracking. */
  private async tracking(transactionId: string | undefined): Promise<Dispute["tracking"]> {
    if (!transactionId) return [];
    try {
      const res = await this.http.request<{ trackers?: { tracking_number?: string; carrier?: string; status?: string }[] }>(
        "GET",
        `/v1/shipping/trackers?transaction_id=${encodeURIComponent(transactionId)}`,
      );
      return (res.body.trackers ?? [])
        .filter((t) => t.tracking_number)
        .map((t) => ({ carrier: t.carrier ?? "OTHER", number: t.tracking_number!, status: TRACKING_STATUS[t.status ?? ""] ?? "UNKNOWN" }));
    } catch (err) {
      if (err instanceof PayPalError && !err.retryable) return [];
      throw err;
    }
  }

  /**
   * Sweep read (design §9.3): unpaid invoices whose due date is before `today`
   * (merchant-local, YYYY-MM-DD), oldest due first. search-invoices filters by
   * status and due date; code filters again in case PayPal ignores a field.
   */
  async overdueInvoices(today: string, limit = 50): Promise<Invoice[]> {
    const res = await this.http.request<{ items?: PayPalInvoiceResource[] }>(
      "POST",
      `/v2/invoicing/search-invoices?page=1&page_size=${Math.min(Math.max(limit, 1), 100)}&total_required=false`,
      { body: { status: OPEN_INVOICE, due_date_range: { start: "2000-01-01", end: dayBefore(today) } } },
    );
    return (res.body.items ?? [])
      .map(toInvoice)
      .filter((i) => OPEN_INVOICE.includes(i.status) && !!i.dueDate && i.dueDate < today)
      .sort((a, b) => a.dueDate!.localeCompare(b.dueDate!));
  }

  /** Insights read: Transaction Search between two instants (PayPal allows up to 31 days per call). */
  async transactions(start: Date, end: Date): Promise<Transaction[]> {
    const iso = (d: Date) => d.toISOString().replace(/\.\d{3}Z$/, "Z");
    const out: Transaction[] = [];
    for (let page = 1; page <= MAX_TXN_PAGES; page++) {
      const q = new URLSearchParams({ start_date: iso(start), end_date: iso(end), fields: "transaction_info,payer_info", page_size: "500", page: String(page) });
      const res = await this.http.request<{ transaction_details?: PayPalTransactionDetail[]; total_pages?: number }>("GET", `/v1/reporting/transactions?${q}`);
      out.push(...(res.body.transaction_details ?? []).flatMap(toTransaction));
      if (!res.body.total_pages || page >= res.body.total_pages) break;
    }
    return out;
  }

  /** Insights read: every invoice still owed, from search-invoices filtered by status. */
  async unpaidInvoices(limit = 100): Promise<Invoice[]> {
    const res = await this.http.request<{ items?: PayPalInvoiceResource[] }>(
      "POST",
      `/v2/invoicing/search-invoices?page=1&page_size=${Math.min(Math.max(limit, 1), 100)}&total_required=false`,
      { body: { status: OPEN_INVOICE } },
    );
    return (res.body.items ?? []).map(toInvoice).filter((i) => OPEN_INVOICE.includes(i.status));
  }

  /** Sweep read: disputes waiting on the merchant whose response is due before `before`. */
  async disputesDueBefore(before: Date): Promise<Dispute[]> {
    const res = await this.http.request<{ items?: PayPalDisputeResource[] }>("GET", `/v1/customer/disputes?page_size=50`);
    return (res.body.items ?? [])
      .map((d) => toDispute(d))
      .filter((d) => d.status === "WAITING_FOR_SELLER_RESPONSE" && !!d.sellerResponseDueDate && Date.parse(d.sellerResponseDueDate) < before.getTime())
      .sort((a, b) => a.sellerResponseDueDate!.localeCompare(b.sellerResponseDueDate!));
  }

  /** Open invoices and disputes for the chat receptionist to choose from, one line each. */
  async openSubjects(): Promise<ChatSubject[]> {
    const [invoices, disputes] = await Promise.all([
      this.http.request<{ items?: PayPalInvoiceResource[] }>("GET", `/v2/invoicing/invoices?page=1&page_size=50&total_required=false`),
      this.http.request<{ items?: PayPalDisputeResource[] }>("GET", `/v1/customer/disputes?page_size=20`),
    ]);
    const inv: ChatSubject[] = (invoices.body.items ?? [])
      .map(toInvoice)
      .filter((i) => OPEN_INVOICE.includes(i.status))
      .map((i) => ({
        kind: "invoice",
        id: i.id,
        label: [`Invoice ${i.number}`, i.recipientName ?? i.recipientEmail, `${formatMoney(i.amountDue, i.currency)} due`, i.dueDate ? `due ${i.dueDate}` : null]
          .filter(Boolean)
          .join(" · "),
      }));
    const dis: ChatSubject[] = (disputes.body.items ?? [])
      .map((d) => toDispute(d))
      .filter((d) => OPEN_DISPUTE.includes(d.status))
      .map((d) => ({
        kind: "dispute",
        id: d.id,
        label: [`Dispute ${d.id}`, d.reason.toLowerCase().replace(/_/g, " "), formatMoney(d.amount, d.currency), d.sellerResponseDueDate ? `respond by ${d.sellerResponseDueDate.slice(0, 10)}` : null]
          .filter(Boolean)
          .join(" · "),
      }));
    return [...dis, ...inv];
  }
}

export function clientsFrom(invoices: PayPalInvoiceResource[]): Client[] {
  const newest = [...invoices].sort((a, b) => created(b).localeCompare(created(a)));
  const seen = new Map<string, Client>();
  for (const inv of newest) {
    const b = inv.primary_recipients?.[0]?.billing_info;
    const email = b?.email_address?.trim();
    if (!email || seen.has(email.toLowerCase())) continue;
    seen.set(email.toLowerCase(), {
      id: `cl_${seen.size + 1}`,
      name: personName(b?.name),
      businessName: b?.business_name ?? null,
      email,
    });
  }
  return [...seen.values()];
}

function created(p: PayPalInvoiceResource): string {
  return p.detail.metadata?.create_time ?? p.detail.invoice_date ?? "";
}

function personName(n: { given_name?: string; surname?: string; full_name?: string } | undefined): string | null {
  const name = n?.full_name ?? [n?.given_name, n?.surname].filter(Boolean).join(" ");
  return name || null;
}

/** "2026-11-07" → "2026-11-06" (plain calendar dates, no time zone). */
function dayBefore(date: string): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() - 1);
  return d.toISOString().slice(0, 10);
}

const MAX_TXN_PAGES = 4;

export interface PayPalTransactionDetail {
  transaction_info?: {
    transaction_id?: string;
    transaction_event_code?: string;
    transaction_initiation_date?: string;
    transaction_status?: string;
    transaction_amount?: { currency_code?: string; value?: string };
    fee_amount?: { currency_code?: string; value?: string };
  };
  payer_info?: { email_address?: string; payer_name?: { alternate_full_name?: string; given_name?: string; surname?: string } };
}

/**
 * Transaction Search event codes: T00xx are payments received; T1106 (a payment
 * reversed by PayPal) and T1107 (a refund the merchant made) are refunds. The
 * rest of T11xx is holds and their releases (T1110/T1111 for a dispute), fee and
 * hold reversals: "other", like bank transfers and T19xx corrections. "Other"
 * never counts as money a client paid or money refunded.
 */
const REFUND_CODES = ["T1106", "T1107"];
export function toTransaction(d: PayPalTransactionDetail): Transaction[] {
  const t = d.transaction_info;
  const value = t?.transaction_amount?.value;
  if (!t?.transaction_id || !value || !t.transaction_amount?.currency_code) return [];
  const code = t.transaction_event_code ?? "";
  const name = d.payer_info?.payer_name;
  const fullName = name?.alternate_full_name ?? ([name?.given_name, name?.surname].filter(Boolean).join(" ") || undefined);
  return [
    {
      id: t.transaction_id,
      at: t.transaction_initiation_date ?? "",
      kind: code.startsWith("T00") ? "payment" : REFUND_CODES.includes(code) ? "refund" : "other",
      status: t.transaction_status ?? "",
      currency: t.transaction_amount.currency_code,
      amount: value,
      fee: t.fee_amount?.value ?? null,
      counterparty: fullName ?? d.payer_info?.email_address ?? null,
    },
  ];
}
