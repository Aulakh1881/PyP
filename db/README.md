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
psql "$DATABASE_URL" -f db/migrations/006_paypal_reporting_cache.sql
psql "$DATABASE_URL" -f db/migrations/007_paypal_reporting_cache_write_policies.sql
```

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

Migration `007_paypal_reporting_cache_write_policies.sql` allows authenticated
members of the relevant merchant to insert and update cache rows during sync.

**The engine contract** (what runs hand over, proposal ids, `resolved`, re-checking before a write): [`engine/README.md`](../engine/README.md#the-contract-for-owners-a-and-c).
