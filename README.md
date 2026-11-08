# Pyp

**The agentic AI that runs your PayPal business, within your rules.** Pyp watches a merchant's PayPal account, notices what needs doing (overdue invoices, new disputes), and either does it or asks first, always within limits the merchant sets.

> *Pyp is an independent hackathon project, not affiliated with or endorsed by PayPal. Sandbox only; all sample data is DEMO DATA.*

PayPal AI Hackathon 2026 · feature freeze **Tue Nov 10** · submission **Thu Nov 12, 12 PM PT**

## Start here

| Document | What it is |
|---|---|
| [`docs/master-plan.md`](docs/master-plan.md) | **The source of truth.** Scope, decisions, schedule, roles, work packages. If anything disagrees with it, it wins. |
| [`docs/technical-design.md`](docs/technical-design.md) | The detail behind the plan: how each part works, the data model, prompts, API list, test cases. |
| [`docs/TODO.md`](docs/TODO.md) | Loose ends to close before submission (license file, MCP server checks). |

## The idea in one line

**The AI proposes, code decides.** Code gathers the facts, Claude makes the judgment call and writes the words, and code checks the decision and carries it out. Every step is timestamped, so any action card can be flipped over to show why it happened.

## What we're building

- **Three surfaces on one backend:** a **website** (public landing page), the **dashboard** (Inbox of action cards, Activity tab, setup screen, Pyp widget and chat), and a **Chrome extension** that opens Pyp in Chrome's side panel next to PayPal.
- **Skills:** Collections (create, send and chase invoices), Disputes (draft evidence, merchant approves), Insights lite (weekly brief). Stretch: Pyp-to-Pyp dispute negotiation.
- **PayPal:** reads through PayPal's official MCP server (read tools only); writes through our REST client in the executor, the only code that changes anything in PayPal.
- **Stack:** TypeScript, Next.js on Render, Render Postgres, Claude (Haiku / Sonnet / Opus 5.5) with Ollama for local development, AG Grid for the Activity tab, and Bryntum Scheduler Community for the Disputes deadline timeline.

## Repository map

| Folder | What lives there | Owner |
|---|---|---|
| [`app/`](app/) | Next.js: website, dashboard, API routes, PayPal webhook intake | A (UI), C (API) |
| [`extension/`](extension/) | Chrome side-panel extension | A + C |
| [`engine/`](engine/) | Registry, run-skill, prompt and schema builders, validator, policy, trace | B |
| [`skills/`](skills/) | One folder per skill: `collections/`, `disputes/`, `insights/` | B |
| [`gateway/`](gateway/) | Model connection (Claude, Ollama, scripted), daily budget cap | B |
| [`paypal/`](paypal/) | MCP read client, REST write client (executor only), webhook verification | C |
| [`executor/`](executor/) | The only place that writes to PayPal | C |
| [`jobs/`](jobs/) | Sweeps, execute, undo timers, cleanup | C |
| [`db/`](db/) | Schema and migrations (9-table core first) | C |
| [`evals/`](evals/) | The write-boundary test and live model checks (`live/`); the prompt-injection suite comes later | B |
| [`docs/`](docs/) | Master plan, technical design, diagrams | All |

Roles: **A** frontend · **B** engine and AI · **C** PayPal and infrastructure (master plan §7).

## Rules for the team

- **Nothing writes to PayPal except the executor.** No exceptions, including "just for the demo".
- **Code does the maths.** Claude never calculates money.
- **No secrets in Git.** Keys go in `.env.local` (git-ignored); `.env.example` lists the names.
- **Sandbox only, DEMO DATA labels, no PayPal logos,** and the disclaimer in the app and the video.
- **Merge small and often.** Each person works in their own folders.

## Getting started

Needs Node 22 or later.

```bash
npm install
cp .env.example .env.local   # fill in the sandbox values; never commit this file
npm run dev                  # http://localhost:3000 (health check: /api/health)
```

| Command | What it does |
|---|---|
| `npm run dev` | Next.js dev server |
| `npm run check` | Lint, typecheck and tests: run before you push |
| `npm test` | Vitest, including the write-boundary test (`evals/boundary.test.ts`) |
| `npm run lint` / `npm run typecheck` | Each check on its own |
| `npm run eval:live` | The Collections cases against a real model (Claude, or Ollama with `PYP_MODEL_PROVIDER=ollama`); see `gateway/README.md` |
| `npm run build` | Production build, as Render runs it |

### The demo path: "Invoice Jordan Kim $300, net 30"

1. In `.env.local`: the Supabase URL and publishable key, `DATABASE_URL` (Supabase: Connect, Session pooler), `PAYPAL_ENVIRONMENT=SANDBOX` with the sandbox app's client id and secret, and a model: `OLLAMA_MODEL=qwen3:4b` (run `ollama serve`) or `ANTHROPIC_API_KEY`.
2. Apply `db/migrations` and the seed in the order `db/README.md` gives.
3. Give the sandbox a client history: `node --env-file=.env.local executor/seed-sandbox.mjs` (three DRAFT invoices, no emails).
4. `npm run dev`, sign in, open `/dashboard`, and type the sentence. Approve the card; "Why?" flips it to the trace.

Pyp only invoices clients PayPal already knows, named in full ("Jordan Kim", not "Jordan"; decision D13). Database tests need `TEST_DATABASE_URL` (see `.env.example`); without it they are skipped.

### Bryntum dispute schedule

The live prototype Disputes page includes a read-only Bryntum Scheduler Community timeline. It maps each PayPal dispute's creation date to its response deadline and shows status, reason, and amount in the event tooltip. The Community package is MIT-licensed and is installed with `npm install`; `npm run live` serves its browser modules locally through the prototype server.

One Next.js project lives at the repo root. `app/` is the App Router folder (pages and API routes); the other folders are plain TypeScript, imported with the `@/` alias (for example `@/engine/policy`). CI runs lint, typecheck, tests and the build on every pull request and every push to `main`.

The write boundary is enforced twice: ESLint (`no-restricted-imports`) and a test both fail if anything outside `executor/` imports `paypal/write-client`.
