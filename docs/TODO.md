# TODO

Open tasks that aren't code. The [Master Plan](master-plan.md) is the source of truth; this list tracks loose ends. Tick items off in the same commit that finishes them.

Roles: **A** frontend · **B** engine and AI · **C** PayPal and infrastructure.

## Before submission (Nov 12, 12 PM PT)

- [ ] **Add an open-source license file** at the repo root (for example MIT). Our saved summary of the hackathon rules says the public repo must show an open-source license. The team picks the license. *Owner: team lead*
- [ ] **Make the repo public** before submitting (the rules call for a public repository; it's private now). *Owner: team lead*
- [ ] **Re-read the official rules** on the Devpost page: submission contents, partner-tool judging, video length (under 3 minutes). Master Plan §3, item 7. *Owner: team lead*
- [ ] **Re-check the PayPal newsroom** for anything that overlaps Pyp before the pitch is final.

## PayPal MCP server (Master Plan §3, item 8)

Desk check done Oct 26 from the published `@paypal/mcp` 1.8.1 package and PayPal's MCP page. Still to confirm live in the sandbox (WP1, owner C):

- [ ] Start the local server with **read tools only** and a sandbox access token:
      `npx -y @paypal/mcp@1.8.1 --tools=invoices.list,invoices.get,disputes.list,disputes.get,transactions.list,orders.get,shipment.get`
      (with `PAYPAL_ACCESS_TOKEN` and `PAYPAL_ENVIRONMENT=SANDBOX` set). Confirm no write tool shows up in its tool list.
- [ ] Call each read tool against seeded sandbox data and save sample responses for case-file builders.
- [ ] Confirm the token handling: the server takes a fixed access token, so `paypal/mcp-read-client` starts it with a fresh token per job run (or restarts it before the token expires).
- [ ] Pin versions: `@paypal/mcp` depends on `@paypal/agent-toolkit@latest`. Pin both in our lockfile.
- [ ] Gaps that use REST reads instead: the overdue sweep (`invoices.list` only pages, with no status or due-date filter, so use `POST /v2/invoicing/search-invoices`), balances, capture details.
- [ ] Decide whether the hosted server (`https://mcp.sandbox.paypal.com`) is worth showing at all. It involves a PayPal login and consent, which fits a desktop AI app better than our server.

## Decisions to make as we build

- [ ] **Render plan:** free web services sleep when idle and free Postgres may expire before judging ends (verify current terms). Use paid instances, possibly covered by Render's partner credits? *Owner: C*
- [ ] **A read-only sandbox app for the MCP server:** the MCP process gets a token that can write; see whether a second sandbox app with fewer features is possible. *Owner: C*
- [ ] **Judges and the demo sign-in:** do judges get the demo password (Approve writes to the sandbox only)? *Owner: team lead*
- [ ] **"Screenshot this page" in the extension:** not planned for Nov 12; revisit after the core works. *Owner: A*
- [ ] **Where the job worker loop runs:** inside the web service process (working default, paid instance) or a separate Render Background Worker. Tied to the Render plan. *Owner: C*
- [ ] **Free-text answers for `merchant.ask`** (for example typing a new client's email); today a question card has buttons only. *Owner: B + A*
- [ ] **More hackathon sponsors?** The plan uses Render, AG Grid and APIMatic and skips the rest. The Devpost prize list (seen through search; the page blocks our fetch) also has **Bryntum** (3 × $1,000; scheduling, calendar and Gantt UI components) and **Channel3** (1 × $1,500; product search for AI agents). Ideas to weigh: a Bryntum calendar of what Pyp has scheduled (follow-ups, due dates, dispute deadlines); APIMatic's generated PayPal Server SDK in the write client if it covers our endpoints (check). Channel3 has no natural fit yet. *Owner: team lead*
- [ ] **Undo window length:** is 60 s right for the demo? *Owner: A*
- [ ] **Pyp-to-Pyp:** confirm the buyer side can send messages and accept or deny offers, and which dispute stages allow `make-offer` (before the Nov 3 go/no-go). *Owner: B + C*

## Other checks from the Master Plan (§3)

- [ ] `/remind`, create-invoice and `/send` accept `PayPal-Request-Id`, including a `:step` suffix (item 1)
- [ ] Webhook self-check: what webhook id do simulator events carry, and how does the sandbox check accept it? (design §9.2) *Owner: C*
- [x] Structured-output API shape: `output_config.format` with a JSON schema through the official SDK; limits enforced in code (design §6.2)
- [ ] Run `npm run eval:live` once with a real `ANTHROPIC_API_KEY` to confirm the API accepts our generated schema end to end *Owner: B*
- [ ] Whether Ollama models follow our `anyOf` / `enum` schemas (`PYP_MODEL_PROVIDER=ollama npm run eval:live`) *Owner: B*
- [ ] Does PayPal expose its own auto-reminder history, or do we count only Pyp's reminders? (design B.1) *Owner: C*
- [ ] Set the Render cron UTC hour for 08:00 merchant-local after US daylight saving ends Nov 1 (design §9.3) *Owner: C*
- [ ] A buyer-side agent can use the customer-side dispute endpoints with its own sandbox credentials (item 2; decides Pyp-to-Pyp on Nov 3)
- [ ] Sandbox-only dispute helpers work for a standard app (item 3)
- [ ] Dispute evidence and offer type values, and the provide-evidence upload format (item 4)
- [ ] Inngest runs cleanly on Render, or we switch to a Postgres job table + Render cron (item 5)
- [ ] Recheck model prices before quoting any cost (item 6)
