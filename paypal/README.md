# paypal/

**Owner:** C · Detail: `docs/technical-design.md` §9 and ADR-006

- `mcp-read-client.ts`: starts **PayPal's official MCP server** (the local `@paypal/mcp` package, pinned) with **read tools only** and a fresh access token per run, and exposes those tools to case files, the validator and chat. The model never sees PayPal's raw tool list. Setup checks: `docs/TODO.md`.
- `read-client.ts`: REST reads for anything the MCP server lacks: the overdue invoice search, balances, capture details.
- `write-client.ts`: REST writes with `PayPal-Request-Id`. **Imported only by `executor/`**; a lint rule and a test fail the build otherwise.
- `webhook-verify.ts`: checks PayPal's webhook signatures.

Credentials come from environment variables and never reach the model, logs or traces.
