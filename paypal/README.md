# paypal/

**Owner:** C · Detail: `docs/technical-design.md` §9 and ADR-006

- `mcp-read-client.ts`: connects to **PayPal's official MCP server** and exposes only an **allow-list of read tools** (invoices, disputes, transactions) to case files, the validator and chat. The model never sees PayPal's raw tool list.
- `read-client.ts`: REST reads for anything the MCP server lacks (e.g. balances).
- `write-client.ts`: REST writes with `PayPal-Request-Id`. **Imported only by `executor/`**; a lint rule and a test fail the build otherwise.
- `webhook-verify.ts`: checks PayPal's webhook signatures.

Credentials come from environment variables and never reach the model, logs or traces.
