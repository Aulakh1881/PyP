# db/

**Owner:** C · Detail: `docs/technical-design.md` §10 and Appendix F

Postgres schema, migrations and queries. Week 1 builds the **9-table core**:
`merchants`, `rules`, `events`, `runs`, `proposals`, `executions`,
`trace_steps`, `cards`, and `activity_log`.

Migration `002_auth_accounts.sql` adds the Supabase Auth relationships:
`profiles` stores Pyp-specific information for a person in `auth.users`, and
`merchant_members` connects people to the businesses they can manage. It also
enables Row Level Security for these account tables and merchant reads.

Migration `003_provision_demo_account.sql` adds a restricted function that
creates a signed-in user's profile and connects them as an owner of the seeded
demo merchant. This is intended for the prototype onboarding flow.

## Applying the schema

Run the migration and demo seed with `psql` against the target database:

```sh
psql "$DATABASE_URL" -f db/migrations/001_core_schema.sql
psql "$DATABASE_URL" -f db/migrations/002_auth_accounts.sql
psql "$DATABASE_URL" -f db/seed/001_demo_merchant.sql
psql "$DATABASE_URL" -f db/migrations/003_provision_demo_account.sql
psql "$DATABASE_URL" -f db/migrations/004_engine_records.sql
psql "$DATABASE_URL" -f db/migrations/005_holds_and_events.sql
psql "$DATABASE_URL" -f db/migrations/006_paypal_reporting_cache.sql
psql "$DATABASE_URL" -f db/migrations/007_paypal_reporting_cache_write_policies.sql
psql "$DATABASE_URL" -f db/migrations/010_card_cleared.sql
```

Migration `004_engine_records.sql` adds what the engine hands over (`resolved_json`, the case file for the executor's re-check, run failures, per-step executions), the spend ledger, and **turns on Row Level Security for every table**. The server connects over `DATABASE_URL` as the table owner, which bypasses RLS; the browser's publishable key sees none of Pyp's records. `executor/execute.test.ts` applies all migrations to a throwaway database and fails if any table is left without RLS.

Migration `010_card_cleared.sql` adds `cards.cleared_at`: when the merchant used **Remove from Inbox** on a finished card. It only hides the card from the Inbox; the card and its audit trail stay, and Activity still lists it. The app reads the column in a way that works before the migration is applied (nothing reads as removed), so pulling the code first is safe.

Migration `005_holds_and_events.sql` adds `holds` (a merchant's "hold off" on an invoice or dispute, which stops reminders in code), lets one webhook event make at most one run, and records when and how each event was processed.

The migration enables `pgcrypto` for UUID generation. It is intentionally
ordered by foreign-key dependencies and should be applied once to a new
database. The seed is idempotent and inserts the one demo merchant referenced
by the design.

Add `client_profiles`, `preferences`, `spend_ledger`, and
`paypal_connections` only when a feature needs them. Until then, client
history is computed live from PayPal, merchant notes come from seeded demo
data, and the spend cap sums today's `runs.cost_usd` against
`SPEND_CAP_USD`. If Inngest does not run on Render, add the `jobs` table
described in the design's Section 10.

Migration `006_paypal_reporting_cache.sql` adds merchant-scoped read-only
tables for the PayPal dashboard. `POST /api/paypal/sync` performs the initial
31-day transaction and first-page invoice/dispute import. Webhooks can later
upsert the same rows without changing the dashboard contract.

The independent webhook endpoint is `POST /api/webhooks/paypal`. It verifies
PayPal signatures, stores event IDs in `events`, and refreshes the reporting
cache. Configure `PAYPAL_WEBHOOK_ID` and the server-only
`SUPABASE_SERVICE_ROLE_KEY` before exposing this endpoint publicly.

Migration `007_paypal_reporting_cache_write_policies.sql` allows authenticated
members of the relevant merchant to insert and update cache rows during sync.

**The engine contract** (what runs hand over, proposal ids, `resolved`, re-checking before a write): [`engine/README.md`](../engine/README.md#the-contract-for-owners-a-and-c).
