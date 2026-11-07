# engine/

**Owner:** B · Detail: `docs/technical-design.md` §7 and §8

The heart of Pyp, plain TypeScript:

- `registry.ts`: the list of skills (one line per skill)
- `run-skill.ts`: gather → menu → decide (the one model call) → check → policy. It returns a `RunResult`; it never writes anywhere
- `schema-builder.ts`: command definitions → the JSON schema Claude must answer in
- `prompt-builder.ts`: cached system prompt + per-case turn prompt
- `validator.ts`: re-checks each proposal against fresh PayPal data
- `policy.ts`: the dial (Off / Ask me / Auto), limits, never-Auto list, kill switch
- `trace.ts`: the timestamped steps on the back of each card
- `router.ts`: `handleEvent()`, the fixed-label door for PayPal events. Events with one right answer (paid, cancelled, dispute closed) run a skill's plain-code handler with no model call; the rest are normal runs
- `quarantine.ts`: the separate, command-free call that classifies buyer text (design §7.6)
- `chat.ts`: `handleChat()`, the minimal chat receptionist (design §7.8 stage 1)
- `content-checks.ts`: outbound text rules every skill shares (amounts, invoice numbers, links)
- `stream.ts`: draining the gateway stream; the partial summary kept for the trace
- `types.ts`: the shared contracts (SkillDef, CommandDef, CaseFile, AgentClient, the PayPal reads and database calls the engine needs). **Change these deliberately and tell the team.**
- `format.ts` and `xml.ts`: money and date helpers (integer cents, never floats), and XML building with escaping
- `commands/merchant-ask.ts`: the question card every skill offers

The engine's types are agreed first, so the other folders can be built in parallel.

## The contract for owners A and C

This section is the one place the hand-off is written down. The types are in `types.ts`, `run-skill.ts` (`RunResult`, `Proposal`) and `gateway/budget.ts` (`SpendLedger`). Tests use fakes of everything below (`skills/collections/evals/fixtures.ts`).

**1. What C implements for the engine**

| Interface | Methods | Notes |
|---|---|---|
| `PayPalReads` | `getInvoice(id)`, `recentClients()`; optional `clientInvoices(email, limit)`, `getDispute(id)` | Over PayPal's MCP read tools, with REST reads for gaps. Money stays as PayPal's decimal strings. `recentClients()` is newest first; clients without an email are dropped by the engine. `clientInvoices` is `search-invoices` by recipient email, newest first, with `paidDate` set on paid ones (client history; without it the case file says history isn't available). `getDispute` returns the `Dispute` shape in `types.ts` (messages oldest first, tracking, items); Disputes fails cleanly without it. |
| `EngineDb` | `remindersSent(invoiceId)`, `remindCallsToday(merchantId)`, `merchantNotes(subject)`; optional `activeHold(subject)` | Postgres. **`remindersSent` counts reminders sent *or* scheduled in their undo window**, so a second run inside the window can't send one more than the limit. `remindCallsToday` counts PayPal `/remind` calls today (PayPal allows 2 a day). `activeHold` returns the merchant's "hold off" on a subject (reason, set-at, until date or null); the engine ignores an expired one itself. |
| `SpendLedger` | `reserve(usd, cap, purpose)`, `settle(id, actualUsd)` | A Postgres version over `runs.cost_usd` or `spend_ledger`. `reserve` must check the cap and add the reservation **in one atomic step** (for example a conditional `UPDATE … WHERE reserved + $1 <= cap`), because several workers share it. Throw `BudgetExceeded` to fail closed. |

**2. Storing a `RunResult`** (TDD §10)

- `runs`: `status` (`ok` / `paused` / `failed`), `failure`, `model`, `case_file_xml` (`caseFile.xml`), `output_json` (`response`), `usage_json` and `cost_usd` (sum of `usage[].costUsd`).
- `proposals`: one row per `proposals[]` entry. **The engine's proposals have no id: assign one on insert.** Store `command_id`, `params_json`, `resolved_json`, `why`, `decision` and `policy_rule` (from `policy`), and `status`. The engine's statuses are `awaiting_approval`, `scheduled`, `blocked` and `invalid` (failed its check; never shown as an approval). Later statuses (`rejected` when the merchant dismisses, `executing`, `executed`, `expired`, `obsolete`, `undone`) are the job layer's.
- `trace_steps`: one row per `trace[]` entry; `stage` → `kind`, `label`, `detail` → `detail_json`.
- `cards`: one per proposal that is `awaiting_approval` or `scheduled` (the front is built from `response.title`, `response.summary`, `resolved` and `policy.reason`).

**3. The executor**

- It sends **`resolved`**, never the model's `params`, and never re-derives an amount, date or recipient.
- The proposal id is the `PayPal-Request-Id`; a command with two writes uses `<id>:create` and `<id>:send`.
- Just before writing, it re-runs the command's `check()` and `overLimit()` with fresh reads (TDD §9.4): the world may have changed since the run.

**4. Triggers.** `skillForTrigger()` in `registry.ts` maps a PayPal event type or sweep name (`overdue-invoices`, `dispute-deadlines`) to a skill.

- **Events:** call `handleEvent({ eventType, subject, ctx, agent })` after webhook intake. It returns `unrouted`, `run` (a normal `RunResult` to store), or `handled` with an outcome and its own trace. For `stand_down`: mark this subject's pending proposals whose command is in `obsoleteCommands` as `obsolete`, cancel its follow-ups if `cancelFollowUps`, and write `message` as the activity entry. `ignore` means the fresh read disagreed with the event; do nothing (the nightly reconcile is the safety net).
- **Chat:** call `handleChat({ message, chatId, subjects, ctx, agent })`, where `subjects` lists open invoices and disputes with a one-line label each (the receptionist can only pick from these). It returns Pyp's `reply`, the route, and the `run` (a `RunResult` to store like any other) or null.
- **Cards:** `caseFile.urgency` says when to flag a card urgent and which deadline to show.
- **Cost:** a Disputes run makes two model calls (quarantine, then the decision) and a chat message one more (the receptionist); every one is in `usage`.
