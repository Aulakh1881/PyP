// Pyp toolbar popup: a way into the web app, plus everything Pyp is waiting on.
// Demo mode shares saved demo data with the widget on paypal.com (chrome.storage.local).
// Live mode shows your real Pyp cards from the Pyp server (see live-bridge.js).
// Opening this popup also grants "activeTab", which lets the widget take screenshots.

const DEFAULT_APP_URL = 'http://localhost:8080/app/';
const LEAF = { '#FF7A6B': '#2DBE8C', '#FFC23D': '#2DBE8C' };

const toggle = document.getElementById('toggle');
const openApp = document.getElementById('open-app');
const appUrl = document.getElementById('app-url');
const settingsBtn = document.getElementById('settings-btn');
const settings = document.getElementById('settings');
const countEl = document.getElementById('count');
const liveSwitch = document.getElementById('live');
const serverInput = document.getElementById('server');
const statusEl = document.getElementById('status');

let transport = null;
let mode = { live: false, server: window.PypBridge.DEFAULT_SERVER };

function isOpen(i) { return i.state === 'open' || i.state === 'auto'; }

async function init() {
  const { enabled, prefs, appUrl: savedUrl } = await chrome.storage.sync.get(['enabled', 'prefs', 'appUrl']);
  const p = prefs || {};
  const body = p.pip || '#1F6BFF';
  document.getElementById('pyp').innerHTML = window.PypFigure.svg({
    size: 44, mode: 'happy', body, leaf: LEAF[body] || '#FFB020', hat: p.hat || 'none', label: ''
  });
  setSwitch(enabled !== false);
  appUrl.value = savedUrl || DEFAULT_APP_URL;
  mode = await window.PypBridge.loadMode();
  showMode();

  transport = window.PypBridge.createTransport(mode);
  window.PypInbox.mount(document.getElementById('pending'), transport, {
    layout: 'stack',
    header: false,
    filter: isOpen,
    emptyText: 'Nothing is waiting on you. Nice!'
  });
  const count = (items) => { const n = items.filter(isOpen).length; countEl.textContent = n ? String(n) : ''; };
  transport.inbox().then((d) => { count(d.items); showStatus(); });
  transport.subscribe((items) => { count(items); showStatus(); });
}

function setSwitch(on) { toggle.setAttribute('aria-checked', String(on)); }

// Live mode opens the dashboard on the Pyp server; demo mode opens the address in settings.
function showMode() {
  liveSwitch.setAttribute('aria-checked', String(mode.live));
  serverInput.value = mode.server;
  document.getElementById('server-field').hidden = !mode.live;
  document.getElementById('app-url-field').hidden = mode.live;
  document.getElementById('reset').hidden = mode.live;
  const pill = document.getElementById('pill');
  pill.textContent = mode.live ? 'LIVE · SANDBOX' : 'DEMO DATA';
  pill.classList.toggle('live', mode.live);
  openApp.href = mode.live ? mode.server + '/app/' : appUrl.value;
}

// In live mode, say when Pyp can't load your cards (signed out, server off) instead of "all caught up".
function showStatus() {
  const err = transport && transport.lastError ? transport.lastError() : null;
  statusEl.hidden = !err;
  document.getElementById('pending').hidden = !!err; // no "Nothing is waiting on you" when Pyp can't know
  statusEl.textContent = err ? err.replace(/ and then reload this page\.$/, ', then open this again.') : '';
}

liveSwitch.addEventListener('click', async () => {
  await chrome.storage.sync.set({ live: liveSwitch.getAttribute('aria-checked') !== 'true' });
  location.reload(); // start the popup again on the other data
});

serverInput.addEventListener('change', async () => {
  let url = serverInput.value.trim() || window.PypBridge.DEFAULT_SERVER;
  // No http(s):// typed: localhost is plain http, a hosted server (Render) is https.
  if (!/^https?:\/\//i.test(url)) url = (/^(localhost|127\.0\.0\.1)(:|\/|$)/i.test(url) ? 'http://' : 'https://') + url;
  await chrome.storage.sync.set({ server: window.PypBridge.serverOf(url) });
  location.reload();
});

toggle.addEventListener('click', async () => {
  const next = toggle.getAttribute('aria-checked') !== 'true';
  setSwitch(next);
  await chrome.storage.sync.set({ enabled: next });
});

appUrl.addEventListener('change', async () => {
  let url = appUrl.value.trim() || DEFAULT_APP_URL;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  appUrl.value = url;
  showMode();
  await chrome.storage.sync.set({ appUrl: url });
});

settingsBtn.addEventListener('click', () => {
  const open = settings.hidden;
  settings.hidden = !open;
  settingsBtn.setAttribute('aria-expanded', String(open));
});

document.getElementById('reset').addEventListener('click', () => transport && transport.reset());

// Connection code: UI only for now. The real API will swap the code for a session token.
const codeInput = document.getElementById('code');
const connected = document.getElementById('connected');
function showConnected(code) {
  connected.hidden = !code;
  connected.textContent = code ? 'Connected with ' + code + ' (demo: nothing is sent anywhere yet)' : '';
}
chrome.storage.sync.get('connectCode').then(({ connectCode }) => showConnected(connectCode));
document.getElementById('connect').addEventListener('click', async () => {
  const code = codeInput.value.trim().toUpperCase();
  if (!/^PYP-[A-Z0-9]{4}-[A-Z0-9]{4}$/.test(code)) {
    connected.hidden = false;
    connected.textContent = 'That doesn’t look like a code. It should look like PYP-7F3A-K29Q.';
    return;
  }
  await chrome.storage.sync.set({ connectCode: code });
  codeInput.value = '';
  showConnected(code);
});

openApp.addEventListener('click', (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: openApp.href });
  window.close();
});

init();
