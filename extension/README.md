# extension/

**Owner:** A + C · Detail: `docs/technical-design.md` §6.1 and §11

The Chrome extension (Manifest V3). It opens Pyp in Chrome's **side panel** next to paypal.com or the sandbox site, with a compact inbox and the chat.

**Working defaults:** a small separate build (e.g. Vite) that imports the dashboard's React card and chat components through a path alias (no iframe). It connects with a token from the **Connect extension** button on the setup screen, stored in `chrome.storage.local`, and sent as `Authorization: Bearer`. It reads `/api/stream` with fetch streaming. Done when a card can be approved from the panel (WP12).

Rules:
- It never draws on or changes PayPal's pages.
- It calls **only** our API, with a revocable extension token. It holds no PayPal keys.
- It asks for as few permissions as possible.
- "Screenshot this page" is not planned for Nov 12 (it would capture PayPal pages full of personal data); see `docs/TODO.md`.
