# app/

**Owner:** A (UI) and C (API routes) · Detail: `docs/technical-design.md` §6 and §11

The Next.js app (App Router). One codebase, three parts:

- **Website**: the public landing page (what Pyp is, the demo video, "Open the demo").
- **Dashboard**: the Inbox of action cards (each flips to its trace), the Activity tab (AG Grid), the Settings screen (permissions, limits, Pause Pyp) and the Pyp widget with chat.
- **API routes**: `/api/cards`, `/api/cards/{id}/approve|dismiss|undo|promote`, `/api/rules`, `/api/kill-switch`, `/api/chat`, `/api/stream`, `/api/activity`, `/api/cards/{id}/answer`, `/api/login`, `/api/logout`, `/api/extension/token` (POST to issue, DELETE to revoke), and `/api/webhooks/paypal` (webhook intake).

**Sign-in (working default):** one demo password (`DEMO_LOGIN_PASSWORD`) sets an HTTP-only session cookie. API routes accept that cookie or the extension's bearer token. See the design §11.4.

API routes never call PayPal's write client. Approvals go to the queue, and the executor does the writing.

The Next.js project itself (package.json, configs) sits at the repo root, so this folder is the App Router folder: `page.tsx` is the landing page and `api/health/route.ts` is Render's health check.
