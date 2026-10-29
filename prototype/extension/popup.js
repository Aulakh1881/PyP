// Pyp toolbar popup: a way into the web app, plus everything Pyp is waiting on.
// Shares saved demo data with the widget on paypal.com (chrome.storage.local).
// Opening this popup also grants "activeTab", which lets the widget take screenshots.

const DEFAULT_APP_URL = 'http://localhost:8080/app/';
const LEAF = { '#FF7A6B': '#2DBE8C', '#FFC23D': '#2DBE8C' };

const toggle = document.getElementById('toggle');
const openApp = document.getElementById('open-app');
const appUrl = document.getElementById('app-url');
const settingsBtn = document.getElementById('settings-btn');
const settings = document.getElementById('settings');
const countEl = document.getElementById('count');

const transport = window.PypDemo.createTransport({ persist: window.PypDemo.chromePersist() });

function isOpen(i) { return i.state === 'open' || i.state === 'auto'; }

async function init() {
  const { enabled, prefs, appUrl: savedUrl } = await chrome.storage.sync.get(['enabled', 'prefs', 'appUrl']);
  const p = prefs || {};
  const body = p.pip || '#1F6BFF';
  document.getElementById('pyp').innerHTML = window.PypFigure.svg({
    size: 44, mode: 'happy', body, leaf: LEAF[body] || '#FFB020', hat: p.hat || 'none', label: ''
  });
  setSwitch(enabled !== false);
  setUrl(savedUrl || DEFAULT_APP_URL);

  window.PypInbox.mount(document.getElementById('pending'), transport, {
    layout: 'stack',
    header: false,
    filter: isOpen,
    emptyText: 'Nothing is waiting on you. Nice!'
  });
  const count = (items) => { const n = items.filter(isOpen).length; countEl.textContent = n ? String(n) : ''; };
  transport.inbox().then((d) => count(d.items));
  transport.subscribe(count);
}

function setSwitch(on) { toggle.setAttribute('aria-checked', String(on)); }

function setUrl(url) {
  appUrl.value = url;
  openApp.href = url;
}

toggle.addEventListener('click', async () => {
  const next = toggle.getAttribute('aria-checked') !== 'true';
  setSwitch(next);
  await chrome.storage.sync.set({ enabled: next });
});

appUrl.addEventListener('change', async () => {
  let url = appUrl.value.trim() || DEFAULT_APP_URL;
  if (!/^https?:\/\//i.test(url)) url = 'https://' + url;
  setUrl(url);
  await chrome.storage.sync.set({ appUrl: url });
});

settingsBtn.addEventListener('click', () => {
  const open = settings.hidden;
  settings.hidden = !open;
  settingsBtn.setAttribute('aria-expanded', String(open));
});

document.getElementById('reset').addEventListener('click', () => transport.reset());

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
