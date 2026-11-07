import type { SupabaseClient } from "@supabase/supabase-js";
import {
  getPayPalBalances,
  getPayPalDisputes,
  getPayPalInvoices,
  getPayPalOrder,
  getPayPalTransactions,
} from "@/paypal/read-client";

export const DEMO_MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

function decimal(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function timestamp(value: string | null): string | null {
  return value || null;
}

export async function syncPayPalReporting(supabase: SupabaseClient) {
  const [balances, transactionData, invoiceData, disputeData] = await Promise.all([
    getPayPalBalances(),
    getPayPalTransactions(
      new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
      new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
      { page: 1, pageSize: 100 },
    ),
    getPayPalInvoices({ page: 1, pageSize: 25 }),
    getPayPalDisputes({ page: 1, pageSize: 25 }),
  ]);

  const balanceRows = balances.map((item) => ({
    merchant_id: DEMO_MERCHANT_ID,
    currency: item.currency,
    available: decimal(item.available),
    withheld: decimal(item.withheld),
    synced_at: new Date().toISOString(),
  }));
  const transactionRows = transactionData.transactions.map((item) => ({
    merchant_id: DEMO_MERCHANT_ID,
    paypal_id: item.id,
    order_id: item.orderId,
    occurred_at: timestamp(item.date),
    type_code: item.type,
    type_label: item.typeLabel,
    status_code: item.status,
    status_label: item.statusLabel,
    subject: item.subject,
    amount: decimal(item.amount),
    currency: item.currency,
    fee: decimal(item.fee),
    net: decimal(item.net),
    synced_at: new Date().toISOString(),
  }));
  const invoiceRows = invoiceData.invoices.map((item) => ({
    merchant_id: DEMO_MERCHANT_ID,
    paypal_id: item.id,
    invoice_number: item.number,
    status_code: item.status,
    status_label: item.statusLabel,
    issued_at: item.date,
    due_at: item.dueDate,
    recipient: item.recipient,
    amount: decimal(item.amount),
    due_amount: decimal(item.dueAmount),
    currency: item.currency,
    synced_at: new Date().toISOString(),
  }));
  const disputeRows = disputeData.disputes.map((item) => ({
    merchant_id: DEMO_MERCHANT_ID,
    paypal_id: item.id,
    status_code: item.status,
    status_label: item.statusLabel,
    reason_code: item.reason,
    reason_label: item.reasonLabel,
    created_at: timestamp(item.createdAt),
    updated_at: timestamp(item.updatedAt),
    response_due_at: timestamp(item.responseDueDate),
    amount: decimal(item.amount),
    currency: item.currency,
    transaction_id: item.transactionId,
    synced_at: new Date().toISOString(),
  }));

  const upsert = async (table: string, rows: unknown[]) => {
    if (rows.length === 0) return;
    const { error } = await supabase.from(table).upsert(rows);
    if (error) throw new Error(`Could not update ${table}: ${error.message}`);
  };

  await upsert("paypal_balances", balanceRows);
  await upsert("paypal_transactions", transactionRows);
  await upsert("paypal_invoices", invoiceRows);
  await upsert("paypal_disputes", disputeRows);

  const orderIds = [...new Set(transactionData.transactions.flatMap((item) => item.orderId ? [item.orderId] : []))];
  const orderRows = [];
  for (const orderId of orderIds) {
    const order = await getPayPalOrder(orderId);
    orderRows.push({
      merchant_id: DEMO_MERCHANT_ID,
      paypal_id: order.id,
      status: order.status,
      intent: order.intent,
      created_at: timestamp(order.createdAt),
      updated_at: timestamp(order.updatedAt),
      amount: decimal(order.amount),
      currency: order.currency,
      payer_email: order.payerEmail,
      synced_at: new Date().toISOString(),
    });
  }
  await upsert("paypal_orders", orderRows);

  return {
    balances: balanceRows.length,
    transactions: transactionRows.length,
    invoices: invoiceRows.length,
    disputes: disputeRows.length,
    orders: orderRows.length,
  };
}
