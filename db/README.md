# db/

**Owner:** C · Detail: `docs/technical-design.md` §10 and Appendix F

Postgres schema, migrations and queries. Week 1 builds the **9-table core**: `merchants` (one seeded row), `rules`, `events`, `runs`, `proposals`, `executions`, `trace_steps`, `cards`, `activity_log`. Add `client_profiles`, `preferences`, `spend_ledger` and `paypal_connections` only when a feature needs them.

Until then: client history is computed live from PayPal, and merchant notes come from seeded demo data in `db/seed/`. If Inngest doesn't run on Render, add a `jobs` table (the design §10). The spend cap sums today's `runs.cost_usd` against `SPEND_CAP_USD`.
