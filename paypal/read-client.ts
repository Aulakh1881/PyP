import { getPayPalAccessToken } from "./oauth";

const PAYPAL_SANDBOX_API = "https://api-m.sandbox.paypal.com";
const PAYPAL_LIVE_API = "https://api-m.paypal.com";

export type PayPalBalance = {
  currency: string;
  available: string;
  withheld: string;
};

export type PayPalTransaction = {
  id: string;
  date: string;
  type: string;
  typeLabel: string;
  status: string;
  statusLabel: string;
  amount: string | null;
  currency: string | null;
  fee: string | null;
  net: string | null;
  subject: string | null;
};

export type PayPalInvoice = {
  id: string;
  number: string | null;
  status: string;
  statusLabel: string;
  date: string | null;
  dueDate: string | null;
  recipient: string | null;
  amount: string | null;
  dueAmount: string | null;
  currency: string | null;
};

const TRANSACTION_EVENT_LABELS: Record<string, string> = {
  T0001: "Payment",
  T1900: "Payment received",
};

const TRANSACTION_STATUS_LABELS: Record<string, string> = {
  D: "Denied",
  P: "Pending",
  S: "Success",
  V: "Voided",
};

const INVOICE_STATUS_LABELS: Record<string, string> = {
  DRAFT: "Draft",
  SENT: "Sent",
  SCHEDULED: "Scheduled",
  PAID: "Paid",
  MARKED_AS_PAID: "Marked as paid",
  CANCELLED: "Cancelled",
  REFUNDED: "Refunded",
  PARTIALLY_REFUNDED: "Partially refunded",
};

export class PayPalReadError extends Error {
  readonly status?: number;
  readonly debugId?: string;

  constructor(message: string, details?: { status?: number; debugId?: string }) {
    super(message);
    this.name = "PayPalReadError";
    this.status = details?.status;
    this.debugId = details?.debugId;
  }
}

function getApiBase(): string {
  return (process.env.PAYPAL_ENVIRONMENT ?? "SANDBOX") === "LIVE"
    ? PAYPAL_LIVE_API
    : PAYPAL_SANDBOX_API;
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" ? value as Record<string, unknown> : null;
}

function transactionTypeLabel(code: string): string {
  return TRANSACTION_EVENT_LABELS[code] ?? `PayPal transaction (${code})`;
}

function transactionStatusLabel(code: string): string {
  return TRANSACTION_STATUS_LABELS[code] ?? `PayPal status (${code})`;
}

function invoiceStatusLabel(status: string): string {
  return INVOICE_STATUS_LABELS[status] ?? `PayPal status (${status})`;
}

async function paypalGet(
  path: string,
  fetcher: typeof fetch = fetch,
): Promise<unknown> {
  const token = await getPayPalAccessToken(fetcher);
  let response: Response;
  try {
    response = await fetcher(`${getApiBase()}${path}`, {
      headers: {
        Accept: "application/json",
        Authorization: `${token.token_type} ${token.access_token}`,
      },
      cache: "no-store",
    });
  } catch {
    throw new PayPalReadError("Could not reach PayPal");
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new PayPalReadError("PayPal returned an invalid response", { status: response.status });
  }

  if (!response.ok) {
    const record = objectValue(body);
    throw new PayPalReadError(
      `PayPal read failed with status ${response.status}`,
      {
        status: response.status,
        debugId: stringValue(record?.debug_id) ?? undefined,
      },
    );
  }

  return body;
}

export async function getPayPalBalances(
  fetcher: typeof fetch = fetch,
): Promise<PayPalBalance[]> {
  const body = objectValue(await paypalGet("/v1/reporting/balances", fetcher));
  const balances = Array.isArray(body?.balances) ? body.balances : [];

  return balances.flatMap((entry) => {
    const balance = objectValue(entry);
    const amount = objectValue(balance?.total_balance);
    const withheld = objectValue(balance?.withheld_balance);
    const currency = stringValue(amount?.currency_code);
    if (!currency) return [];
    return [{
      currency,
      available: stringValue(amount?.value) ?? "0",
      withheld: stringValue(withheld?.value) ?? "0",
    }];
  });
}

export async function getPayPalTransactions(
  startDate: string,
  endDate: string,
  optionsOrFetcher: { page?: number; pageSize?: number } | typeof fetch = {},
  fetcher: typeof fetch = fetch,
): Promise<{
  transactions: PayPalTransaction[];
  totalItems: number;
  page: number;
  pageSize: number;
}> {
  const options = typeof optionsOrFetcher === "function" ? {} : optionsOrFetcher;
  if (typeof optionsOrFetcher === "function") fetcher = optionsOrFetcher;
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 100;
  const query = new URLSearchParams({
    start_date: startDate,
    end_date: endDate,
    page: String(page),
    page_size: String(pageSize),
  });
  const body = objectValue(
    await paypalGet(`/v1/reporting/transactions?${query.toString()}`, fetcher),
  );
  const entries = Array.isArray(body?.transaction_details) ? body.transaction_details : [];

  return {
    totalItems: typeof body?.total_items === "number" ? body.total_items : entries.length,
    page,
    pageSize,
    transactions: entries.flatMap((entry) => {
      const detail = objectValue(entry);
      const info = objectValue(detail?.transaction_info);
      const payer = objectValue(detail?.payer_info);
      const payerName = objectValue(payer?.payer_name);
      const amount = objectValue(info?.transaction_amount);
      const fee = objectValue(info?.fee_amount);
      const net = objectValue(info?.net_amount);
      const id = stringValue(info?.transaction_id);
      if (!id) return [];
      return [{
        id,
        date: stringValue(info?.transaction_initiation_date) ?? "",
        type: stringValue(info?.transaction_event_code) ?? "UNKNOWN",
        typeLabel: transactionTypeLabel(stringValue(info?.transaction_event_code) ?? "UNKNOWN"),
        status: stringValue(info?.transaction_status) ?? "UNKNOWN",
        statusLabel: transactionStatusLabel(stringValue(info?.transaction_status) ?? "UNKNOWN"),
        amount: stringValue(amount?.value),
        currency: stringValue(amount?.currency_code),
        fee: stringValue(fee?.value),
        net: stringValue(net?.value),
        subject: stringValue(payerName?.alternate_full_name),
      }];
    }),
  };
}

export async function getPayPalInvoices(
  optionsOrFetcher: { page?: number; pageSize?: number } | typeof fetch = {},
  fetcher: typeof fetch = fetch,
): Promise<{
  invoices: PayPalInvoice[];
  totalItems: number;
  page: number;
  pageSize: number;
}> {
  const options = typeof optionsOrFetcher === "function" ? {} : optionsOrFetcher;
  if (typeof optionsOrFetcher === "function") fetcher = optionsOrFetcher;
  const page = options.page ?? 1;
  const pageSize = options.pageSize ?? 25;
  const query = new URLSearchParams({
    page: String(page),
    page_size: String(pageSize),
  });
  const body = objectValue(
    await paypalGet(`/v2/invoicing/invoices?${query.toString()}`, fetcher),
  );
  const entries = Array.isArray(body?.items) ? body.items : [];

  return {
    totalItems: typeof body?.total_items === "number" ? body.total_items : entries.length,
    page,
    pageSize,
    invoices: entries.flatMap((entry) => {
      const invoice = objectValue(entry);
      const detail = objectValue(invoice?.detail);
      const amount = objectValue(invoice?.amount);
      const dueAmount = objectValue(invoice?.due_amount);
      const recipients = Array.isArray(invoice?.primary_recipients) ? invoice.primary_recipients : [];
      const recipient = objectValue(recipients[0]);
      const billingInfo = objectValue(recipient?.billing_info);
      const name = objectValue(billingInfo?.name);
      const recipientName = [
        stringValue(name?.given_name),
        stringValue(name?.surname),
      ].filter(Boolean).join(" ") || stringValue(billingInfo?.email_address);
      const id = stringValue(invoice?.id);
      const status = stringValue(invoice?.status) ?? "UNKNOWN";
      if (!id) return [];
      return [{
        id,
        number: stringValue(detail?.invoice_number),
        status,
        statusLabel: invoiceStatusLabel(status),
        date: stringValue(detail?.invoice_date),
        dueDate: stringValue(detail?.due_date),
        recipient: recipientName || null,
        amount: stringValue(amount?.value),
        dueAmount: stringValue(dueAmount?.value),
        currency: stringValue(amount?.currency_code),
      }];
    }),
  };
}
