/*
 * Which data the pages use. Served as-is (demo data) by a plain static server
 * such as port 8080. scripts/live-dashboard.mjs (port 3001) serves its own
 * version of this file with live: true, so the same pages run on the real API.
 */
(function (root) {
  'use strict';
  root.PYP_CONFIG = root.PYP_CONFIG || { live: false };
  root.PypTransport = function () {
    if (root.PYP_CONFIG.live && root.PypLive) return root.PypLive.createTransport();
    return root.PypDemo.createTransport({ persist: root.PypDemo.localPersist() });
  };
})(typeof window !== 'undefined' ? window : globalThis);
