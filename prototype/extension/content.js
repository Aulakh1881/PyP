// Pyp content script: puts Pyp in the corner of paypal.com.
// Demo data by default. With "Live data" on in the popup's settings, Pyp uses your
// real Pyp account through the Pyp server (see live-bridge.js).

(function () {
  'use strict';
  if (window.top !== window) return;             // never inside iframes (e.g. checkout frames)
  if (document.querySelector('[data-pyp]')) return;

  let widget = null;

  function injectFonts() {
    if (document.getElementById('pyp-fonts')) return;
    const url = (f) => chrome.runtime.getURL('fonts/' + f);
    const style = document.createElement('style');
    style.id = 'pyp-fonts';
    style.textContent = [
      ['Nunito', 600, 'nunito-latin-600-normal.woff2'],
      ['Nunito', 700, 'nunito-latin-700-normal.woff2'],
      ['Nunito', 800, 'nunito-latin-800-normal.woff2'],
      ['Baloo 2', 800, 'baloo-2-latin-800-normal.woff2']
    ].map(([family, weight, file]) =>
      `@font-face{font-family:"${family}";font-weight:${weight};font-style:normal;font-display:swap;src:url("${url(file)}") format("woff2")}`
    ).join('\n');
    (document.head || document.documentElement).appendChild(style);
  }

  function makeTransport(mode) {
    // Demo data is saved in chrome.storage.local, so the toolbar popup and every PayPal tab share it.
    const transport = window.PypBridge.createTransport(mode);
    transport.capture = () => new Promise((resolve, reject) => {
      chrome.runtime.sendMessage({ type: 'pyp:capture' }, (res) => {
        if (chrome.runtime.lastError || !res || !res.ok) {
          reject(new Error((res && res.error) || (chrome.runtime.lastError && chrome.runtime.lastError.message) || 'capture failed'));
        } else {
          resolve(res.url);
        }
      });
    });
    return transport;
  }

  let lastSaved = '';
  const prefs = {
    load: () => chrome.storage.sync.get('prefs').then((r) => r.prefs || {}),
    save: (p) => { lastSaved = JSON.stringify(p); return chrome.storage.sync.set({ prefs: p }); }
  };

  let showing = null;
  function show() {
    if (widget || showing) return showing;
    injectFonts();
    showing = window.PypBridge.loadMode().then((mode) => {
      widget = window.PypWidget.mount({ transport: makeTransport(mode), prefs, right: 24, bottom: 24 });
      showing = null;
    });
    return showing;
  }

  function hide() {
    if (!widget) return;
    widget.destroy();
    widget = null;
  }

  chrome.storage.sync.get('enabled').then(({ enabled }) => {
    if (enabled !== false) show();
  });

  chrome.storage.onChanged.addListener((changes, area) => {
    if (area !== 'sync') return;
    if (changes.enabled) changes.enabled.newValue === false ? hide() : show();
    // Switched between demo and live data (or a new server): start Pyp again on the new data.
    if ((changes.live || changes.server) && widget) { hide(); show(); }
    // Another PayPal tab (or the popup) changed Pyp's look: follow it here too.
    if (changes.prefs && widget && changes.prefs.newValue) {
      const next = JSON.stringify(changes.prefs.newValue);
      if (next !== lastSaved) { lastSaved = next; widget.setPrefs(changes.prefs.newValue); }
    }
  });

  // The popup can ask Pyp to open (e.g. "Open Pyp" button).
  chrome.runtime.onMessage.addListener((message) => {
    if (message && message.type === 'pyp:open') Promise.resolve(show()).then(() => widget && widget.open());
  });
})();
