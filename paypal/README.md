# paypal/

**Owner:** C · Detail: `docs/technical-design.md` §9 and ADR-006

- `mcp-read-client.ts`: starts **PayPal's official MCP server** (the local `@paypal/mcp` package, pinned) with **read tools only** and a fresh access token per run, and exposes those tools to case files, the validator and chat. The model never sees PayPal's raw tool list. Setup checks: `docs/TODO.md`.
- `read-client.ts`: REST reads for anything the MCP server lacks: the overdue invoice search, balances, capture details.
- `write-client.ts`: REST writes with `PayPal-Request-Id`. **Imported only by `executor/`**; a lint rule and a test fail the build otherwise.
- `webhook-verify.ts`: checks PayPal's webhook signatures.

Credentials come from environment variables and never reach the model, logs or traces.

## Sandbox OAuth

`oauth.ts` obtains a server-side sandbox access token with
`PAYPAL_CLIENT_ID` and `PAYPAL_CLIENT_SECRET`. The authenticated
`GET /api/paypal/connection` route uses that token request as a connection
health check and returns only the environment and connection status. It never
returns the access token or PayPal credentials to the browser.

`PAYPAL_WEBHOOK_ID` is not required for OAuth. It is only needed after a
PayPal webhook is created and webhook signature verification is enabled.

## Read-only reporting

`read-client.ts` uses the server-side OAuth token to read sandbox balances and
transaction reporting data. The authenticated app routes expose the normalized
read model without returning PayPal tokens or raw response bodies:

- `GET /api/paypal/overview`
- `GET /api/paypal/transactions?start_date=&end_date=&page=&page_size=`
- `GET /api/paypal/invoices?page=&page_size=`

Transaction reporting is limited to PayPal's 31-day reporting window. The
transactions response keeps PayPal's event and status codes while also
returning human-readable labels, and supports pages of 1-100 records. These
routes do not create, update, refund, or otherwise write to PayPal.
