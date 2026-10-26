// Pyp background service worker.
// Only job for now: take a screenshot of the visible tab when the widget asks.
// (Content scripts can't capture the page themselves.)

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message && message.type === 'pyp:capture') {
    const windowId = sender.tab ? sender.tab.windowId : chrome.windows.WINDOW_ID_CURRENT;
    chrome.tabs.captureVisibleTab(windowId, { format: 'png' })
      .then((url) => sendResponse({ ok: true, url }))
      .catch((err) => sendResponse({ ok: false, error: String(err && err.message || err) }));
    return true; // keep the channel open for the async response
  }
  return false;
});

chrome.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason === 'install') {
    await chrome.storage.sync.set({ enabled: true });
  }
});
