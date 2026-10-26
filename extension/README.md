# extension/

**Owner:** A + C · Detail: `docs/technical-design.md` §6.1 and §11

The Chrome extension (Manifest V3). It opens Pyp in Chrome's **side panel** next to paypal.com or the sandbox site, with a compact inbox and the chat, reusing the dashboard's card and chat components.

Rules:
- It never draws on or changes PayPal's pages.
- It calls **only** our API, with a revocable session token. It holds no PayPal keys.
- It asks for as few permissions as possible.
- "Screenshot this page" (if built) captures only when the merchant clicks, and the image is untrusted input.
