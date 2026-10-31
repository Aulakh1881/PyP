// REST reads behind the engine's PayPalReads (engine/README.md §1). The plan
// is PayPal's MCP server first with REST for the gaps; until mcp-read-client
// exists, REST covers these two reads. Invoicing v2 only. Nothing here writes.

import type { Client, Invoice, InvoiceStatus, PayPalReads } from "@/engine/types";
import { PayPalError, type PayPalHttp } from "./http";

/** The parts of a PayPal Invoicing v2 invoice we read. */
export interface PayPalInvoice {
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
}

/** How many recent invoices we scan for the client list. */
const CLIENT_SCAN = 100;

export function toInvoice(p: PayPalInvoice): Invoice {
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
  };
}

export class PayPalReadClient implements PayPalReads {
  constructor(private readonly http: PayPalHttp) {}

  async getInvoice(id: string): Promise<Invoice | null> {
    try {
      const res = await this.http.request<PayPalInvoice>("GET", `/v2/invoicing/invoices/${encodeURIComponent(id)}`);
      return toInvoice(res.body);
    } catch (err) {
      if (err instanceof PayPalError && err.status === 404) return null;
      throw err;
    }
  }

  /** Everyone the merchant has invoiced, newest first, one entry per email. */
  async recentClients(): Promise<Client[]> {
    const res = await this.http.request<{ items?: PayPalInvoice[] }>(
      "GET",
      `/v2/invoicing/invoices?page=1&page_size=${CLIENT_SCAN}&total_required=false`,
    );
    return clientsFrom(res.body.items ?? []);
  }
}

export function clientsFrom(invoices: PayPalInvoice[]): Client[] {
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

function created(p: PayPalInvoice): string {
  return p.detail.metadata?.create_time ?? p.detail.invoice_date ?? "";
}

function personName(n: { given_name?: string; surname?: string; full_name?: string } | undefined): string | null {
  const name = n?.full_name ?? [n?.given_name, n?.surname].filter(Boolean).join(" ");
  return name || null;
}
