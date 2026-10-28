# gateway/

**Owner:** B · Detail: `docs/technical-design.md` §7.7 and Appendix B.0

One `AgentClient` interface with adapters: Claude (evals and demo), Ollama (free local development) and a scripted adapter (repeatable tests, offline demo). It also holds the daily budget cap (fails closed) and stall timers. Switching models is a one-file change.

Models: Haiku 5.5 (screening, wording), Sonnet 5.5 (invoices, chat), Opus 5.5 (disputes).
