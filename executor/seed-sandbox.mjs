// Gives a fresh PayPal sandbox account a client history, so Pyp has someone to
// invoice: one DRAFT invoice per demo client. Drafts send no email. Sandbox
// only; safe to run twice (fixed PayPal-Request-Ids). All names are DEMO DATA.
//
//   node --env-file=.env.local executor/seed-sandbox.mjs

const BASE = "https://api-m.sandbox.paypal.com";

const CLIENTS = [
  { given: "Jordan", surname: "Kim", email: "jordan.kim@example.com", item: "Brand consultation", value: "150.00" },
  { given: "Sam", surname: "Lee", business: "Acme Studio", email: "sam@acme.example.com", item: "Website design", value: "1200.00" },
  { given: "Priya", surname: "Shah", business: "Beta LLC", email: "priya@beta.example.com", item: "Monthly retainer", value: "800.00" },
];

if (process.env.PAYPAL_ENVIRONMENT !== "SANDBOX") throw new Error("Sandbox only: set PAYPAL_ENVIRONMENT=SANDBOX");
const { PAYPAL_CLIENT_ID: id, PAYPAL_CLIENT_SECRET: secret } = process.env;
if (!id || !secret) throw new Error("Set PAYPAL_CLIENT_ID and PAYPAL_CLIENT_SECRET in .env.local");

const tokenRes = await fetch(`${BASE}/v1/oauth2/token`, {
  method: "POST",
  headers: { Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`, "Content-Type": "application/x-www-form-urlencoded" },
  body: "grant_type=client_credentials",
});
if (!tokenRes.ok) throw new Error(`PayPal sign-in failed (${tokenRes.status}); check the sandbox keys`);
const { access_token } = await tokenRes.json();

for (const c of CLIENTS) {
  const res = await fetch(`${BASE}/v2/invoicing/invoices`, {
    method: "POST",
    headers: {
      Authorization: `Bearer ${access_token}`,
      "Content-Type": "application/json",
      Prefer: "return=representation",
      "PayPal-Request-Id": `pyp-seed-${c.email}`,
    },
    body: JSON.stringify({
      detail: { currency_code: "USD", note: "DEMO DATA: seeded by Pyp for the hackathon demo" },
      primary_recipients: [
        { billing_info: { name: { given_name: c.given, surname: c.surname }, email_address: c.email, ...(c.business ? { business_name: c.business } : {}) } },
      ],
      items: [{ name: c.item, quantity: "1", unit_amount: { currency_code: "USD", value: c.value } }],
    }),
  });
  const body = await res.json().catch(() => ({}));
  console.log(res.ok ? `draft ${body.id} for ${c.given} ${c.surname}` : `failed for ${c.email}: ${res.status} ${JSON.stringify(body)}`);
}
