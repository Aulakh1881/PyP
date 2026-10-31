# gateway/

**Owner:** B · Detail: `docs/technical-design.md` §7.7 and Appendix B.0

One `AgentClient` interface with adapters: Claude (evals and demo), Ollama (free local development) and a scripted adapter (repeatable tests, offline demo). It also holds the daily budget cap (fails closed) and stall timers. Switching models is a one-file change.

Models: Haiku 5.5 (screening, wording), Sonnet 5.5 (invoices, chat), Opus 5.5 (disputes).

**Files:** `anthropic.ts` (official `@anthropic-ai/sdk`, one structured call with `output_config.format`, cached system prompt, server-side refusal fallback on Sonnet/Opus), `ollama.ts` (Ollama's `/api/chat` with the schema as `format`), `scripted.ts` (fixed answers for tests), `budget.ts` (spend ledger; in-memory now, Postgres later), `models.ts` (tier → model and prices), `index.ts` (`createAgentClient()` picks the provider from `PYP_MODEL_PROVIDER`).

**Try it against a real model:** put `ANTHROPIC_API_KEY` (or `PYP_MODEL_PROVIDER=ollama` and `OLLAMA_MODEL`) in `.env.local`, then `npm run eval:live`.

## Local model (Ollama)

Free, offline, and good enough to develop against. On an 8 GB M1 (Oct 28):

```bash
brew install ollama
ollama serve                 # leave running (or: brew services start ollama)
ollama pull qwen3:4b         # 2.5 GB
PYP_MODEL_PROVIDER=ollama OLLAMA_MODEL=qwen3:4b npm run eval:live
```

`qwen3:4b` passed all 7 live Collections cases on the first attempt, 25–45 s per case. With 16 GB or more, try `qwen3:8b`. `gemma4:e4b` is a 9.5 GB download, too big for 8 GB of RAM.

What makes small models work here:
- **Thinking off** (`think: false`, the default). With it on, some models put the JSON in the thinking output.
- **The full schema, limits included.** Ollama's constrained decoding enforces `maxLength`, so it gets `fullSchema`, while Claude gets the stripped one. The schema is also shown in the system prompt, as Ollama's docs recommend.
- **Code does the counting and matching.** Models were wrong about "which reminder is this" and "which client did they mean" until the case file said so (`next-reminder="3 of 3"`, `named-in-request="yes"`).

