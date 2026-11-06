import { createClient } from "@/lib/supabase/server";
import {
  getPayPalBalances,
  getPayPalDisputes,
  getPayPalInvoices,
  getPayPalOrder,
  getPayPalTransactions,
  PayPalReadError,
} from "@/paypal/read-client";
import { PayPalAuthenticationError, PayPalConfigurationError } from "@/paypal/oauth";

const DEMO_MERCHANT_ID = "00000000-0000-0000-0000-000000000001";

function responseHeaders(request: Request): HeadersInit {
  const origin = request.headers.get("origin");
  return origin === "http://localhost:8080"
    ? { "Access-Control-Allow-Origin": origin, "Access-Control-Allow-Credentials": "true" }
    : {};
}

function decimal(value: string | null): number | null {
  return value === null ? null : Number(value);
}

function timestamp(value: string | null): string | null {
  return value || null;
}

export async function POST(request: Request) {
  const headers = responseHeaders(request);
  const supabase = await createClient();
  const { data: { user } } = await supabase.auth.getUser();
  if (!user) return Response.json({ error: "Authentication required" }, { status: 401, headers });

  const { data: membership, error: membershipError } = await supabase
    .from("merchant_members")
    .select("merchant_id")
    .eq("user_id", user.id)
    .eq("merchant_id", DEMO_MERCHANT_ID)
    .maybeSingle();
  if (membershipError) throw membershipError;
  if (!membership) return Response.json({ error: "Merchant access required" }, { status: 403, headers });

  try {
    const [balances, transactionData, invoiceData, disputeData] = await Promise.all([
      getPayPalBalances(),
      getPayPalTransactions(
        new Date(Date.now() - 31 * 24 * 60 * 60 * 1000).toISOString().replace(/\.\d{3}Z$/, "Z"),
        new Date().toISOString().replace(/\.\d{3}Z$/, "Z"),
        { page: 1, pageSize: 100 },
      ),
      getPayPalInvoices({ page: 1, pageSize: 100 }),
      getPayPalDisputes({ page: 1, pageSize: 100 }),
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

    if (balanceRows.length > 0) {
      const { error } = await supabase.from("paypal_balances").upsert(balanceRows);
      if (error) throw error;
    }
    if (transactionRows.length > 0) {
      const { error } = await supabase.from("paypal_transactions").upsert(transactionRows);
      if (error) throw error;
    }
    if (invoiceRows.length > 0) {
      const { error } = await supabase.from("paypal_invoices").upsert(invoiceRows);
      if (error) throw error;
    }
    if (disputeRows.length > 0) {
      const { error } = await supabase.from("paypal_disputes").upsert(disputeRows);
      if (error) throw error;
    }

    const orderIds = [...new Set(transactionData.transactions.flatMap((item) => item.orderId ? [item.orderId] : []))];
    let orderCount = 0;
    for (const orderId of orderIds) {
      const order = await getPayPalOrder(orderId);
      const { error } = await supabase.from("paypal_orders").upsert({
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
      if (error) throw error;
      orderCount += 1;
    }

    return Response.json({
      ok: true,
      synced: {
        balances: balanceRows.length,
        transactions: transactionRows.length,
        invoices: invoiceRows.length,
        disputes: disputeRows.length,
        orders: orderCount,
      },
      note: "This initial sync imports the current 31-day transaction window and first invoice/dispute page.",
    }, { headers });
  } catch (error) {
    if (error instanceof PayPalConfigurationError || error instanceof PayPalAuthenticationError) {
      return Response.json({ error: "PayPal is not available" }, { status: 503, headers });
    }
    if (error instanceof PayPalReadError) {
      console.error("PayPal reporting cache sync failed", { status: error.status, debugId: error.debugId });
      return Response.json({ error: "PayPal data could not be synchronized" }, { status: 502, headers });
    }
    throw error;
  }
}
