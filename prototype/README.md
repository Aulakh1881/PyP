# prototype/: Pyp UI preview

A clickable, **UI-only** version of Pyp's three surfaces, running entirely on **DEMO DATA** in the browser. There's no server, database, AI or PayPal connection. It's here so the team can see and try the interface now, and port it into the real app.

> Independent hackathon concept, not affiliated with or endorsed by PayPal.

| Surface | Where | What it does |
|---|---|---|
| **Website** | `website/index.html` | Landing page: what Pyp is, the live inbox, the safety rules, install steps. A live Pyp sits in the corner. |
| **Dashboard** | `website/app/` | Demo sign-in (any password), then **Inbox** (cards with Approve / Review / Dismiss / Undo, filters, flip to "How I got here"), **Activity** (one AG Grid table of live sandbox payments, invoices and disputes plus Pyp's own actions: sort, filter, search, filter by type, export CSV, click a row for details), **Weekly brief**, and **Settings** (Permissions: Off / Ask me / Auto per skill, limits, **Pause Pyp**, extension connection code, reset demo data). Pyp's chat widget is on every page. |
| **Chrome extension** | `extension/` | Puts Pyp in the **bottom-right corner of paypal.com**. The toolbar popup has **Open the Pyp web app** and the list of actions **waiting on you**, plus settings (show on PayPal, **Live data** on your real Pyp account, web app address, connection code). |

## Run it locally, step by step

### What you need

- **Google Chrome** (or another Chromium browser like Edge or Brave) for the extension.
- **One of these** to run a tiny local web server. Check in a terminal:
  - **Python 3**: `python3 --version` (on Windows: `py --version`), or
  - **Node.js 18 or newer**: `node --version`. Node is also what runs the tests.
- **Git**, or download the code as a ZIP from GitHub.

You don't need to install any packages, API keys or accounts.

### 1. Get the code

With Git:

```bash
git clone https://github.com/Aulakh1881/pyp.git
cd pyp
git checkout ui-prototype      # only until this branch is merged into main
```

Without Git: on GitHub, switch to the `ui-prototype` branch, click **Code → Download ZIP**, unzip it, and open a terminal in the unzipped folder.

### 2. Start the website and dashboard

From the repo folder, run **one** of these and leave the terminal open:

```bash
python3 -m http.server 8080 --directory prototype/website     # Python (Windows: py -m http.server 8080 --directory prototype/website)
```

```bash
cd prototype && npm run serve                                  # Node (downloads a small server the first time)
```

Then open in Chrome:

- **Website:** <http://localhost:8080>
- **Dashboard:** <http://localhost:8080/app/>. Type any password and click **Sign in**.

To stop the server, press **Ctrl + C** in that terminal.

### 3. Install the Chrome extension

1. In Chrome, go to `chrome://extensions`.
2. Switch on **Developer mode** (top-right corner).
3. Click **Load unpacked** and choose the **`prototype/extension`** folder. Pick that exact folder, the one containing `manifest.json`.
4. Optional: click the puzzle-piece icon in the toolbar and pin **Pyp** so its icon is always visible.

### 4. Try it on PayPal

1. Go to <https://www.paypal.com> (or <https://www.sandbox.paypal.com>). If you already had a PayPal tab open, **reload it**. Pyp appears in the **bottom-right corner**.
2. Hover over Pyp (it blinks and looks at you), then click it. It hops into the chat.
3. Click Pyp's **toolbar icon** to see the actions waiting on you, or **Open the Pyp web app**. That opens <http://localhost:8080/app/>, so keep step 2's server running.

### 5. Use your real Pyp account in the extension (live data)

The extension uses your **real Pyp account** by default (the popup's pill says **LIVE · SANDBOX**):

1. Start the real app: `npm run dev` and `npm run live` from the repo folder (see the main README).
2. Sign in at <http://localhost:3001/app/> in the same Chrome.
3. In `chrome://extensions`, click the reload icon on Pyp's card after pulling new code.
4. Reload your PayPal tab. Pyp's chat and Inbox now use your real account.

To use made-up demo data instead (no server needed), open the popup's settings and switch off **Live data**.

If Pyp says you're signed out, sign in at <http://localhost:3001/app/> again and reload the PayPal tab. The extension's requests go through its background worker, which sends your Pyp sign-in cookie; it only talks to `/api/` on the Pyp server address in settings (default `http://localhost:3001`). Once the app is hosted on Render, put its address (e.g. `https://pyp.onrender.com`) in **Pyp server**; `*.onrender.com` is already allowed.

### Things to try

- **Chat:** tap a quick action, or type “late invoices”, “refund status” or “how was my week?”.
- **+ menu:** upload a photo, or take a screenshot of the page (see the troubleshooting note below).
- **Palette button** in the chat header: change Pyp's color and hat, the chat color and the message box.
- **Inbox:** Approve the Acme reminder, Review and edit the dispute draft, Undo the refund before the timer ends, or click **How I got here** to flip a card.
- **Dashboard → Settings:** switch on **Pause Pyp**, then go back to the Inbox; the refund timer freezes.
- **Start over:** Settings → **Reset demo data** (or the popup's settings → Reset demo data).

### If something doesn't work

| Problem | Fix |
|---|---|
| Pyp doesn't appear on PayPal | Reload the PayPal tab. Check the extension is switched on in `chrome://extensions`, and that **Show Pyp on PayPal** is on in the popup's settings. |
| “Load unpacked” shows a manifest error | You picked the wrong folder. Choose `prototype/extension` itself. |
| “Open the Pyp web app” shows “site can't be reached” | The local server from step 2 isn't running. Start it again. |
| Screenshot says it couldn't take one | Chrome only allows it after you click Pyp's toolbar icon once on that tab. Click it, close the popup, and try again. |
| Pyp says the Pyp server isn't answering | Start `npm run dev` and `npm run live`, then reload the PayPal tab. Or switch off **Live data** in the popup's settings to use demo data. |
| `localhost:8080` is already in use | Use another port, e.g. `python3 -m http.server 8081 --directory prototype/website`, and update the web app address in the popup's settings. |
| The page looks stale after you pull new code | Hard-reload (Ctrl + Shift + R, or Cmd + Shift + R on Mac). For the extension, click the reload icon on its card in `chrome://extensions`. |

### Tests (Node)

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
    live-transport.js  the live transport: the same methods on the real API (dashboard on :3001, extension in live mode)
    pyp-inbox.js       the card inbox (flip, undo countdown, filters)
    pyp-widget.js      the corner widget: launcher, fly-in, chat, + menu, inbox tab, customize
  extension/         Manifest V3: content script (corner widget), background (screenshots + live API calls), live-bridge.js (demo or live), popup
  website/           landing page + app/ (dashboard)
  scripts/           sync-shared.mjs (copies shared/ into extension/ and website/), render-icons.py
  tests/             node --test
```

Chrome loads an unpacked extension only from its own folder, so `extension/shared/` and `website/shared/` are **copies**. Edit files in `shared/`, then run `npm run sync`.

The widget renders inside a **shadow root**, so paypal.com's styles can't change it and its styles can't leak onto PayPal's page. It never reads or changes PayPal's own page content.

### Shared demo state

- The dashboard, the landing page and other open tabs share one saved demo state (`localStorage`). Approve a card in one tab and the others update.
- The extension's popup and every paypal.com tab share their own saved state (`chrome.storage.local`).
- In demo mode the extension and the web app don't share data. In live mode both use your real Pyp account.

## Plugging in the real API

Everything goes through a **transport** object. `shared/demo-data.js` documents its methods at the top: `greet`, `chat`, `inbox`, `act`, `activity`, `brief`, `getSettings` / `updateSettings`, `setPaused`, `subscribe`, and `capture`. To use the backend, write a transport that calls `/api/cards`, `/api/chat`, `/api/stream` and so on, with the same method names and the same card shape, and pass it to `PypWidget.mount({ transport })` and `PypInbox.mount(el, transport)`. The UI doesn't need to change.

## Where this differs from the master plan (for the team to decide)

- **Extension placement:** the master plan (Oct 26) says the extension opens in Chrome's **side panel** and never draws on PayPal's pages. This prototype puts Pyp **in the corner of paypal.com**, as requested, using a content script and shadow DOM. The toolbar popup covers the "compact inbox" role.
- **Screenshot this page:** included in the widget's + menu. The master plan parks it until after Nov 12 because PayPal pages are full of personal data. Chrome only allows the screenshot after the user has clicked Pyp's toolbar icon on that tab (`activeTab`); otherwise Pyp says so in the chat.
- **Stack:** plain HTML/CSS/JS with no build, so it runs anywhere today. The plan's real app is Next.js/React. Port the pieces when ready; the transport interface is the seam.
- **Refunds card:** shown because it's in the card demo video. The master plan parks Refunds as a skill.
