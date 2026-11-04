# TODO

Open tasks that aren't code. The [Master Plan](master-plan.md) is the source of truth; this list tracks loose ends. Tick items off in the same commit that finishes them.

Roles: **A** frontend · **B** engine and AI · **C** PayPal and infrastructure.

## Built so far (role B)

- Engine core (WP3): registry, `runSkill`, schema and prompt builders, validator, policy, trace, money and XML helpers. *(PRs #2–#4)*
- Model gateway: Claude (official SDK, structured output, refusal fallbacks, stall timers), Ollama (`qwen3:4b`) and scripted adapters; in-memory spend cap. *(PRs #2–#4)*
- Collections: `sendReminder`, `scheduleFollowUp`, `createAndSend` from chat, `merchant.ask`; 7 live cases pass on `qwen3:4b`. *(PRs #2–#4)*
- The write boundary: lint rule, test and CI. *(PRs #2–#4)*
- Collections, second wave: `invoice.cancel` (never Auto; offered only when the merchant asks or every reminder has gone out), `invoice.suggestAutoReminders` (card only), client history in the overdue case file (computed in code), structured merchant holds that stop reminders in code, and a stand-down on `INVOICING.INVOICE.PAID` / `CANCELLED` with no model call (`engine/router.ts`).
- Quarantine call for buyer text (design §7.6, `engine/quarantine.ts`): fast tier, no commands, enums and booleans only, plus code red flags; a failure counts as suspicious.
- Disputes skill (WP7, engine side): case file with deadline, urgency, tracking and quarantined buyer facts; `provideEvidence`, `makeOffer`, `acceptClaim` (all never Auto), `sendMessage` (asks after suspicious buyer text); stand-down when an update closes the dispute.
- Chat receptionist (WP8 stage 1, `engine/chat.ts`): sentence → route (new invoice, an existing invoice or dispute, or a reply) → skill run → card.
- Prompt-injection suite (G4 gate, `evals/injection.test.ts`) and golden prompt snapshots (`evals/prompts.test.ts`).
- Trace keeps the model's partial summary when an answer can't be used (design §7.7).

## Engine work still open (role B)

- [ ] Run `npm run eval:live` once with a real `ANTHROPIC_API_KEY` (Collections and the new Disputes cases)
- [ ] Chat stage 2: read-only lookup tools for questions (design §7.8)
- [ ] Insights lite (WP10)
- [ ] Dispute evidence notes: check that every factual sentence cites an id (design B.2); today the note must carry at least one valid citation

## Needed from C for the new engine features

These are optional in `engine/types.ts`, so nothing breaks until they exist. Fakes in `skills/*/evals/fixtures.ts` show the expected shapes.

- [ ] `PayPalReads.getDispute(id)`: one dispute with messages, items and tracking (Disputes can't run without it)
- [ ] `PayPalReads.clientInvoices(email, limit)`: `POST /v2/invoicing/search-invoices` by recipient email, with `paidDate` on each invoice (client history)
- [ ] `EngineDb.activeHold(subject)`: a holds table the setup screen or a card button writes to
- [ ] Job layer: apply `handleEvent()` outcomes (`stand_down` → mark listed commands' pending proposals `obsolete`, cancel follow-ups, write the activity entry)
- [ ] Chat route: call `handleChat()` with open invoices and disputes as `subjects`
- [ ] Cards: show `caseFile.urgency` (dispute due within 72 h)

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
- [ ] Run `npm run eval:live` once with a real `ANTHROPIC_API_KEY` to confirm the API accepts our generated schemas end to end, including Disputes' nullable `trackingRef` *Owner: B*
- [x] Ollama follows our `anyOf` / `enum` schemas: `qwen3:4b` passes all 7 live Collections cases on an 8 GB M1, 25–45 s each (Oct 28; setup in `gateway/README.md`)
- [ ] Does PayPal expose its own auto-reminder history, or do we count only Pyp's reminders? (design B.1) *Owner: C*
- [ ] Set the Render cron UTC hour for 08:00 merchant-local after US daylight saving ends Nov 1 (design §9.3) *Owner: C*
- [ ] A buyer-side agent can use the customer-side dispute endpoints with its own sandbox credentials (item 2; decides Pyp-to-Pyp on Nov 3)
- [ ] Sandbox-only dispute helpers work for a standard app (item 3)
- [ ] Dispute evidence and offer type values, and the provide-evidence upload format (item 4)
- [ ] Inngest runs cleanly on Render, or we switch to a Postgres job table + Render cron (item 5)
- [ ] Recheck model prices before quoting any cost (item 6)
