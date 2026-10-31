# gateway/

**Owner:** B · Detail: `docs/technical-design.md` §7.7 and Appendix B.0

One `AgentClient` interface with adapters: Claude (evals and demo), Ollama (free local development) and a scripted adapter (repeatable tests, offline demo). It also holds the daily budget cap (fails closed) and stall timers. Switching models is a one-file change.

Models: Haiku 5.5 (screening, wording), Sonnet 5.5 (invoices, chat), Opus 5.5 (disputes).

**Files:** `anthropic.ts` (official `@anthropic-ai/sdk`, one structured call with `output_config.format`, cached system prompt, server-side refusal fallback on Sonnet/Opus), `ollama.ts` (Ollama's `/api/chat` with the schema as `format`), `scripted.ts` (fixed answers for tests), `budget.ts` (spend ledger; in-memory now, Postgres later), `models.ts` (tier → model and prices), `index.ts` (`createAgentClient()` picks the provider from `PYP_MODEL_PROVIDER`).

**Try it against a real model:** put `ANTHROPIC_API_KEY` (or `PYP_MODEL_PROVIDER=ollama` and `OLLAMA_MODEL`) in `.env.local`, then `npm run eval:live`.
