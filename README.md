# Pyp

**The agentic AI that runs your PayPal business, within your rules.** Pyp watches a merchant's PayPal account, notices what needs doing (overdue invoices, new disputes), and either does it or asks first, always within limits the merchant sets.

> *Pyp is an independent project built for the PayPal AI Hackathon 2026. It is not affiliated with or endorsed by PayPal. It runs against the PayPal sandbox only, and all sample data is demo data.*

## The idea in one line

**The AI proposes, code decides.** Code gathers the facts, Claude makes the judgment call and writes the words, and code checks the decision and carries it out. Every step is timestamped, so any action card can be flipped over to show why it happened.

## What it does

- **Inbox of action cards.** Each thing Pyp wants to do appears as a card: approve, edit, answer or undo. The merchant sets which actions run on their own (with an undo window) and which wait for approval, and one switch pauses Pyp entirely.
- **Collections.** Create and send invoices from a sentence ("Invoice Jordan Kim $300, net 30"), then chase overdue ones with follow-ups.
- **Disputes.** Pyp drafts the evidence and response before the deadline, and the merchant approves it. A timeline shows every open dispute against its deadline.
- **Insights.** A weekly brief on what came in, what's overdue and what's at risk.
- **Chat and documents.** Ask Pyp in plain language, and upload a PDF or image (a quote, a shipping receipt) for it to read and use, for example as dispute proof.
- **Custom skills and workflows.** Teach Pyp your own routines and run them on a schedule.
- **Connections.** Pyp as a Slack bot (DMs with buttons, `/pyp`), Discord, or any app through Zapier, Make or n8n.
- **Three surfaces on one backend:** a website, the dashboard, and a Chrome extension that puts Pyp in the corner of paypal.com.

**Stack:** TypeScript, Next.js, Postgres on Supabase, and Claude, with Ollama for local development. Hosted on Render. AG Grid powers the Activity tab and Bryntum Scheduler Community the disputes timeline.

## Use Pyp

Pyp is hosted on Render at **<https://pyp-agent.onrender.com>**. It runs on one shared PayPal **sandbox** business ("Pyp Demo Business"), so no real money moves. Everyone who signs in sees that same business and Inbox, and anything you approve really happens in the sandbox.

### Sign in

1. Open <https://pyp-agent.onrender.com/login>.
2. **First time:** click **Sign up**, enter your email and a password (6 characters or more), and click **Create account**. You're signed straight in.
3. **Next time:** **Sign in** with your email and password. Forgot it? Click **Forgot password?** under the Sign in button.
4. On **Connect a sandbox PayPal Business account**, click **Check sandbox connection**. Pyp checks its shared sandbox merchant; you never enter PayPal credentials. Then click **Open dashboard**.
5. The dashboard is at <https://pyp-agent.onrender.com/app/>. **Sign out** is in its menu.

### Install the Chrome extension

The extension isn't in the Chrome Web Store, so you load it from this repository. It works in Chrome and other Chromium browsers (Edge, Brave).

1. Get the code: `git clone https://github.com/Aulakh1881/PyP`, or on GitHub click **Code → Download ZIP** and unzip it.
2. In Chrome, go to `chrome://extensions` and switch on **Developer mode** (top right).
3. Click **Load unpacked** and choose the **`prototype/extension`** folder (the one that contains `manifest.json`).
4. Click the puzzle-piece icon in the toolbar and pin **Pyp**.
5. Click the Pyp icon, then the gear (**Settings**). Leave **Live data** on, and set **Pyp server** to `https://pyp-agent.onrender.com`. It saves when you leave the field.
6. In the **same Chrome profile**, sign in at <https://pyp-agent.onrender.com/login>. The extension uses that sign-in.
7. Open <https://www.paypal.com> (any page). Pyp's bubble is in the bottom-right corner: click it to chat or to see your **Inbox**. The toolbar popup lists what's **waiting on you** and has **Open the Pyp web app**.

If Pyp says you're signed out, sign in again and reload the PayPal tab. If the bubble doesn't appear, reload the tab and check that **Show Pyp on PayPal** is on in the popup's settings. After pulling new code, click the reload icon on Pyp's card in `chrome://extensions`. To try it with made-up data and no server, switch off **Live data**. More detail is in [`prototype/README.md`](prototype/README.md).

## Design rules

- **Nothing writes to PayPal except the executor.** Reads go through PayPal's official MCP server (read tools only), and writes go through our REST client in `executor/`. ESLint (`no-restricted-imports`) and a test (`evals/boundary.test.ts`) both fail if anything else imports the write client.
- **Code does the maths.** The model never calculates money; it picks among ids that code gives it.
- **Untrusted text stays data.** Emails, dispute messages and uploaded documents are evidence for the model, never instructions to it.
- **A daily model budget** that fails closed.

## Documentation

| Document | What it is |
|---|---|
| [`docs/master-plan.md`](docs/master-plan.md) | Scope, decisions and the demo script |
| [`docs/technical-design.md`](docs/technical-design.md) | How each part works: data model, prompts, APIs, test cases |
| [`engine/README.md`](engine/README.md) | The engine's contract for the other folders |
| [`db/README.md`](db/README.md) | Schema, migrations and seed |
| [`gateway/README.md`](gateway/README.md) | Model providers (Claude, Ollama) |

## Repository map

| Folder | What lives there |
|---|---|
| [`app/`](app/) | Next.js: pages, API routes, PayPal and Slack webhook intake |
| [`engine/`](engine/) | Registry, run-skill, prompt and schema builders, validator, policy, trace |
| [`skills/`](skills/) | One folder per skill: `collections/`, `disputes/`, `insights/` |
| [`gateway/`](gateway/) | Model connection (Claude, Ollama, scripted) and the daily budget cap |
| [`paypal/`](paypal/) | MCP read client, REST write client (executor only), webhook verification |
| [`executor/`](executor/) | The only place that writes to PayPal |
| [`jobs/`](jobs/) | Sweeps, scheduled skills, undo timers |
| [`db/`](db/) | Schema, migrations and seed |
| [`prototype/`](prototype/) | The dashboard, website and Chrome extension front ends |
| [`evals/`](evals/) | The write-boundary test, prompt snapshots and live model checks |
| [`docs/`](docs/) | Plan, technical design, diagrams |

## Getting started

You need Node 22 or later, a Supabase project, a PayPal developer sandbox app, and either an Anthropic API key or a local Ollama model.

```bash
npm install
cp .env.example .env.local   # fill in your own sandbox values; never commit this file
```

Then, in two terminals:

```bash
npm run dev    # the app and API on :3000
npm run live   # the dashboard on live data, on :3001
```

Use **http://localhost:3001** for everything: sign in at `/login`, and the dashboard is at `/app/`. The Chrome extension talks to :3001 too (see `prototype/README.md`).

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server (app and API, :3000) |
| `npm run live` | The dashboard on live data at :3001; run it next to `npm run dev` |
| `npm run check` | Lint, typecheck and tests |
| `npm test` | Vitest, including the write-boundary test |
| `npm run eval:live` | The Collections cases against a real model; see `gateway/README.md` |
| `npm run build` | Production build |
| `npm start` | The production server (`scripts/serve.mjs`): site, dashboard, API and worker on one port |

If a page keeps reloading itself, stop both terminals, delete the `.next` folder and start them again.

### Try it: "Invoice Jordan Kim $300, net 30"

1. In `.env.local`, set the Supabase URL and publishable key, `DATABASE_URL` (Supabase: Connect, Session pooler), `PAYPAL_ENVIRONMENT=SANDBOX` with your sandbox app's client id and secret, and a model: `ANTHROPIC_API_KEY`, or `OLLAMA_MODEL=qwen3:4b` with `ollama serve` running.
2. Apply `db/migrations` and the seed in the order `db/README.md` gives.
3. Give the sandbox a client history: `node --env-file=.env.local executor/seed-sandbox.mjs` (three draft invoices, no emails sent).
4. Start both terminals, sign in, open the dashboard and type the sentence. Approve the card; "Why?" flips it over to the trace.

Pyp only invoices clients PayPal already knows, named in full ("Jordan Kim", not "Jordan"). Database tests need `TEST_DATABASE_URL` (see `.env.example`); without it they're skipped.

## Deploying to Render

`render.yaml` is a Render blueprint for one web service. `npm start` runs `scripts/serve.mjs`, which serves the dashboard files and the Next.js app on one origin: the hosted version of `npm run dev` plus `npm run live`.

Use a plan that doesn't sleep (Starter or above). A sleeping server runs no sweeps, Auto actions, undo windows or Slack posts. Keep **one instance**, so the worker loop never runs twice.

1. Render: New → Blueprint, and pick your copy of this repo. Fill in the `sync: false` values **before the first deploy**, because the `NEXT_PUBLIC_*` ones are baked in at build time.
2. Once it's live, set `PYP_PUBLIC_DASHBOARD_URL` to `https://<service>.onrender.com/app/`.
3. Supabase: Authentication → URL Configuration, and add the Render URL to the redirect URLs.
4. Check the deploy and its PayPal webhook: `node --env-file=.env.local scripts/deploy-check.mjs https://<service>.onrender.com`. It probes the routes and lists the sandbox app's webhooks. Add `--create` to register one at `/api/webhooks/paypal`, then put its id in `PAYPAL_WEBHOOK_ID` on Render and redeploy.
5. Slack (optional): run `node scripts/slack-manifest.mjs https://<service>.onrender.com` and create or update the Slack app from that manifest.
6. The Chrome extension: in the popup's settings, set **Pyp server** to the Render URL (see [Install the Chrome extension](#install-the-chrome-extension)).

If a local server shares the hosted database, run it with `PYP_WORKER=off` so only one worker claims work.

## License

[MIT](LICENSE) © 2026 Anveer Aulakh, Brandon Santamaria and William Yuan.
