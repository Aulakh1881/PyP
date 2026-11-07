// Picks the data source for the corner widget and the toolbar popup.
//   Demo (default): made-up data saved in chrome.storage.local.
//   Live: your real Pyp account, through the Pyp server (npm run dev + npm run live).
// Live requests go through background.js, which sends the Pyp sign-in cookie.

(function (root) {
  'use strict';

  const DEFAULT_SERVER = 'http://localhost:3001';

  function serverOf(saved) {
    return String(saved || DEFAULT_SERVER).replace(/\/+$/, '');
  }

  async function loadMode() {
    const { live, server } = await chrome.storage.sync.get(['live', 'server']);
    return { live: live === true, server: serverOf(server) };
  }

  // A fetch look-alike for the live transport: only the bits it uses.
  function bgFetch(path, init) {
    init = init || {};
    return new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'pyp:api', path, method: init.method || 'GET', body: init.body }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          reject(new Error((res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'request failed'));
          return;
        }
        resolve({ ok: res.status >= 200 && res.status < 300, status: res.status, json: () => Promise.resolve(res.body) });
      });
    });
  }

  function createTransport(mode, hooks) {
    hooks = hooks || {};
    if (!mode.live) return root.PypDemo.createTransport({ persist: root.PypDemo.chromePersist() });
    return root.PypLive.createTransport({
      apiBase: '',
      fetch: bgFetch,
      onSignedOut: hooks.onSignedOut || function () {},
      signedOutText: 'You’re signed out. Sign in at ' + mode.server + '/app/ and then reload this page.'
    });
  }

  root.PypBridge = { DEFAULT_SERVER, serverOf, loadMode, createTransport };
})(typeof window !== 'undefined' ? window : globalThis);
