# prototype/: Pyp UI preview

A clickable, **UI-only** version of Pyp's three surfaces, running entirely on **DEMO DATA** in the browser. There's no server, database, AI or PayPal connection. It's here so the team can see and try the interface now, and port it into the real app.

> Independent hackathon concept, not affiliated with or endorsed by PayPal.

| Surface | Where | What it does |
|---|---|---|
| **Website** | `website/index.html` | Landing page: what Pyp is, the live inbox, the safety rules, install steps. A live Pyp sits in the corner. |
| **Dashboard** | `website/app/` | Demo sign-in (any password), then **Inbox** (cards with Approve / Review / Dismiss / Undo, filters, flip to "How I got here"), **Activity** (filterable log with a detail drawer), **Weekly brief**, and **Setup** (Off / Ask me / Auto per skill, limits, **Pause Pyp**, extension connection code, reset demo data). Pyp's chat widget is on every page. |
| **Chrome extension** | `extension/` | Puts Pyp in the **bottom-right corner of paypal.com**. The toolbar popup has **Open the Pyp web app** and the list of actions **waiting on you**, plus settings (show on PayPal, web app address, connection code). |

## Run it locally

No install step. Node is only needed for the tests and the helper scripts.

**Website and dashboard**

```bash
cd prototype
npm run serve           # or: python3 -m http.server 8080 --directory website
```

Open <http://localhost:8080> for the website and <http://localhost:8080/app/> for the dashboard.

**Chrome extension**

1. Open `chrome://extensions` and switch on **Developer mode** (top right).
2. Click **Load unpacked** and choose the `prototype/extension` folder.
3. Go to `https://www.paypal.com` (or `sandbox.paypal.com`). Pyp appears in the bottom-right corner.
4. Click the Pyp icon in Chrome's toolbar to see what's waiting on you, or open the web app. It points to `http://localhost:8080/app/` by default; change that under the popup's settings.

**Tests**

```bash
cd prototype
npm test                # policy rules + demo data (node --test, no dependencies)
npm run check           # fails if the shared/ copies are out of date
```

## How it's put together

```
prototype/
  shared/            the real source for everything both surfaces use
    pyp-figure.js      draws Pyp (modes: idle, perk, happy, avatar; 7 hats)
    policy.js          "The AI proposes. Code decides." Plain rules for auto / ask / blocked
    demo-data.js       the demo transport: cards, chat replies, activity, settings, pause
    pyp-inbox.js       the card inbox (flip, undo countdown, filters)
    pyp-widget.js      the corner widget: launcher, fly-in, chat, + menu, inbox tab, customize
  extension/         Manifest V3: content script (corner widget), background (screenshots), popup
  website/           landing page + app/ (dashboard)
  scripts/           sync-shared.mjs (copies shared/ into extension/ and website/), render-icons.py
  tests/             node --test
```

Chrome loads an unpacked extension only from its own folder, so `extension/shared/` and `website/shared/` are **copies**. Edit files in `shared/`, then run `npm run sync`.

The widget renders inside a **shadow root**, so paypal.com's styles can't change it and its styles can't leak onto PayPal's page. It never reads or changes PayPal's own page content.

### Shared demo state

- The dashboard, the landing page and other open tabs share one saved demo state (`localStorage`). Approve a card in one tab and the others update.
- The extension's popup and every paypal.com tab share their own saved state (`chrome.storage.local`).
- The extension and the web app don't share data yet. That needs the real API.

## Plugging in the real API

Everything goes through a **transport** object. `shared/demo-data.js` documents its methods at the top: `greet`, `chat`, `inbox`, `act`, `activity`, `brief`, `getSettings` / `updateSettings`, `setPaused`, `subscribe`, and `capture`. To use the backend, write a transport that calls `/api/cards`, `/api/chat`, `/api/stream` and so on, with the same method names and the same card shape, and pass it to `PypWidget.mount({ transport })` and `PypInbox.mount(el, transport)`. The UI doesn't need to change.

## Where this differs from the master plan (for the team to decide)

- **Extension placement:** the master plan (Oct 26) says the extension opens in Chrome's **side panel** and never draws on PayPal's pages. This prototype puts Pyp **in the corner of paypal.com**, as requested, using a content script and shadow DOM. The toolbar popup covers the "compact inbox" role.
- **Screenshot this page:** included in the widget's + menu. The master plan parks it until after Nov 12 because PayPal pages are full of personal data. Chrome only allows the screenshot after the user has clicked Pyp's toolbar icon on that tab (`activeTab`); otherwise Pyp says so in the chat.
- **Stack:** plain HTML/CSS/JS with no build, so it runs anywhere today. The plan's real app is Next.js/React. Port the pieces when ready; the transport interface is the seam.
- **Refunds card:** shown because it's in the card demo video. The master plan parks Refunds as a skill.
