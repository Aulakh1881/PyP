// After a Render deploy: checks the hosted Pyp and its PayPal webhook.
//
//   node --env-file=.env.local scripts/deploy-check.mjs https://pyp.onrender.com
//   node --env-file=.env.local scripts/deploy-check.mjs https://pyp.onrender.com --create
//
// 1. Probes the address: /api/health, the site, sign-in, the dashboard, and the
//    webhook route (which should refuse a GET, not 404).
// 2. Lists the sandbox app's PayPal webhooks (read-only) and says whether one
//    points at <address>/api/webhooks/paypal.
// 3. Only with --create: registers that webhook (app configuration, not a
//    merchant write) and prints its id, for PAYPAL_WEBHOOK_ID on Render.
//    Other webhooks (a teammate's tunnel) are left alone.

const args = process.argv.slice(2);
const create = args.includes("--create");
const base = (args.find((a) => !a.startsWith("--")) ?? "").replace(/\/+$/, "");
if (!/^https:\/\/[^/]+$/.test(base)) {
  console.error("Usage: node --env-file=.env.local scripts/deploy-check.mjs https://your-pyp-address [--create]");
  process.exit(1);
}

const EVENTS = [
  "CUSTOMER.DISPUTE.CREATED",
  "CUSTOMER.DISPUTE.UPDATED",
  "INVOICING.INVOICE.PAID",
  "INVOICING.INVOICE.CANCELLED",
  "PAYMENT.CAPTURE.COMPLETED",
  "PAYMENT.CAPTURE.REFUNDED",
  "PAYMENT.CAPTURE.REVERSED",
];

let failed = false;
const ok = (msg) => console.log(`  ok    ${msg}`);
const bad = (msg) => {
  failed = true;
  console.log(`  FAIL  ${msg}`);
};

console.log(`Pyp at ${base}`);
const probes = [
  ["/api/health", (s) => s === 200],
  ["/", (s) => s === 200],
  ["/login", (s) => s === 200],
  ["/app/", (s) => s === 200],
  ["/api/webhooks/paypal", (s) => s === 405],
];
for (const [path, good] of probes) {
  try {
    const res = await fetch(base + path, { redirect: "manual", signal: AbortSignal.timeout(60_000) });
    (good(res.status) ? ok : bad)(`${path} → ${res.status}`);
  } catch (err) {
    bad(`${path} → ${err.message} (a first request after a deploy can take a minute)`);
  }
}

const id = process.env.PAYPAL_CLIENT_ID;
const secret = process.env.PAYPAL_CLIENT_SECRET;
if (!id || !secret) {
  console.log("\nNo PAYPAL_CLIENT_ID / PAYPAL_CLIENT_SECRET: skipping the webhook check (use --env-file=.env.local).");
  process.exit(failed ? 1 : 0);
}
const api = process.env.PAYPAL_ENVIRONMENT === "LIVE" ? "https://api-m.paypal.com" : "https://api-m.sandbox.paypal.com";
const tokenRes = await fetch(`${api}/v1/oauth2/token`, {
  method: "POST",
  headers: {
    Authorization: `Basic ${Buffer.from(`${id}:${secret}`).toString("base64")}`,
    "Content-Type": "application/x-www-form-urlencoded",
  },
  body: "grant_type=client_credentials",
});
if (!tokenRes.ok) {
  console.error(`\nPayPal sign-in failed: ${tokenRes.status}`);
  process.exit(1);
}
const { access_token } = await tokenRes.json();
const headers = { Authorization: `Bearer ${access_token}`, "Content-Type": "application/json" };

const target = `${base}/api/webhooks/paypal`;
const { webhooks = [] } = await (await fetch(`${api}/v1/notifications/webhooks`, { headers })).json();
console.log(`\nPayPal webhooks on this app (${webhooks.length}):`);
for (const w of webhooks) console.log(`  ${w.id}  ${w.url}${w.url === target ? "   <- this deploy" : ""}`);
const mine = webhooks.find((w) => w.url === target);

if (mine) {
  const same = mine.id === process.env.PAYPAL_WEBHOOK_ID;
  console.log(`\nWebhook for this deploy: ${mine.id}. Set PAYPAL_WEBHOOK_ID=${mine.id} on Render${same ? " (.env.local already has it)" : ""}.`);
} else if (!create) {
  console.log(`\nNo webhook points at ${target}. Re-run with --create to register one.`);
} else {
  const res = await fetch(`${api}/v1/notifications/webhooks`, {
    method: "POST",
    headers,
    body: JSON.stringify({ url: target, event_types: EVENTS.map((name) => ({ name })) }),
  });
  const body = await res.json();
  if (!res.ok) {
    console.error(`\nCreating the webhook failed: ${res.status} ${body.name ?? ""} ${body.message ?? ""}`);
    process.exit(1);
  }
  console.log(`\nCreated webhook ${body.id} → ${target}`);
  console.log(`Set PAYPAL_WEBHOOK_ID=${body.id} on Render (Environment), then redeploy.`);
}

process.exit(failed ? 1 : 0);
