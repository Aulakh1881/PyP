// Pyp background service worker.
// 1. Takes a screenshot of the visible tab when the widget asks
//    (content scripts can't capture the page themselves).
// 2. In live mode, makes the widget's and popup's requests to the Pyp server.
//    A content script on paypal.com can't send the Pyp sign-in cookie itself,
//    but this worker can, because the extension has host permission for localhost.

const DEFAULT_SERVER = 'http://localhost:3001';

async function callApi(message) {
  const path = String(message.path || '');
  // Only Pyp's own API, never an arbitrary address.
  if (!/^\/api\/[A-Za-z0-9/_\-.?=&%]*$/.test(path)) throw new Error('Not a Pyp API path: ' + path);
  const { server } = await chrome.storage.sync.get('server');
  const base = String(server || DEFAULT_SERVER).replace(/\/+$/, '');
  let res;
  try {
    res = await fetch(base + path, {
      method: message.method === 'POST' ? 'POST' : 'GET',
      headers: { 'Content-Type': 'application/json' },
      body: message.method === 'POST' ? message.body || '{}' : undefined,
      credentials: 'include',
      cache: 'no-store'
    });
  } catch (e) {
    throw new Error('the Pyp server at ' + base + ' isn’t answering. Is it running (npm run dev and npm run live)?');
  }
  let body = {};
  try { body = await res.json(); } catch (e) { /* not JSON */ }
  return { status: res.status, body };
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'pyp:capture') {
    const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
      .then((url) => sendResponse({ ok: true, url }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true; // keep the channel open for the async response
  }
  if (message && message.type === 'pyp:api') {
    callApi(message)
      .then((r) => sendResponse({ ok: true, status: r.status, body: r.body }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true;
  }
  return false;
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await chrome.storage.sync.set({ enabled: true });
  }
});
