# app/

**Owner:** A (UI) and C (API routes) · Detail: `docs/technical-design.md` §6 and §11

The Next.js app (App Router). One codebase, three parts:

- **Website**: the public landing page (what Pyp is, the demo video, "Open the demo").
- **Dashboard**: the Inbox of action cards (each flips to its trace), the Activity tab (AG Grid), the setup screen (dial, limits, kill switch) and the Pyp widget with chat.
- **API routes**: `/api/cards`, `/api/cards/{id}/approve|dismiss|undo|promote`, `/api/rules`, `/api/kill-switch`, `/api/chat`, `/api/stream`, `/api/activity`, `/api/cards/{id}/answer`, `/api/login`, `/api/extension/token`, and `/api/webhooks/paypal` (webhook intake).

**Sign-in (working default):** one demo password (`DEMO_LOGIN_PASSWORD`) sets an HTTP-only session cookie. API routes accept that cookie or the extension's bearer token. See the design §11.4.

API routes never call PayPal's write client. Approvals go to the queue, and the executor does the writing.

> Scaffolding note: `create-next-app` refuses a folder that already has files. Scaffold in a temporary folder and move the files in, keeping these READMEs.
