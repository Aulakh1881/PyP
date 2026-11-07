// The prototype dashboard (prototype/website) on live data, at http://localhost:3001.
//
// Serves the prototype's files, and forwards everything else (/api, /login,
// /_next, the sign-in callback) to the Next.js app on port 3000. The browser
// sees one origin, so the sign-in cookie rides along and no CORS is needed.
// It also serves its own shared/runtime-config.js that switches the pages to
// the live transport (prototype/website/shared/live-transport.js).
//
//   npm run dev     # the app and API on :3000
//   npm run live    # this, on :3001

import { createReadStream, statSync } from "node:fs";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PORT = Number(process.env.LIVE_PORT ?? 3001);
const APP = new URL(process.env.LIVE_APP_URL ?? "http://localhost:3000");
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prototype/website");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

const RUNTIME_CONFIG = `(function (root) {
  'use strict';
  root.PYP_CONFIG = { live: true };
  root.PypTransport = function () { return root.PypLive.createTransport(); };
})(window);
`;

/** A prototype file for this path, or null to hand the request to the app. */
function staticFile(pathname) {
  let rel;
  try {
    rel = decodeURIComponent(pathname);
  } catch {
    return null;
  }
  if (rel.endsWith("/")) rel += "index.html";
  const file = path.resolve(ROOT, "." + rel);
  if (!file.startsWith(ROOT + path.sep)) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

function forward(req, res) {
  const upstream = http.request(
    { hostname: APP.hostname, port: APP.port, method: req.method, path: req.url, headers: req.headers },
    (up) => {
      res.writeHead(up.statusCode ?? 502, up.headers);
      up.pipe(res);
    },
  );
  upstream.on("error", () => {
    if (!res.headersSent) res.writeHead(502, { "Content-Type": "text/plain; charset=utf-8" });
    res.end(`Can't reach the app at ${APP.origin}. Is "npm run dev" running?`);
  });
  req.pipe(upstream);
}

const server = http.createServer((req, res) => {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/shared/runtime-config.js") {
    res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" });
    res.end(RUNTIME_CONFIG);
    return;
  }
  if (url.pathname === "/app") {
    res.writeHead(308, { Location: "/app/" + url.search });
    res.end();
    return;
  }
  // The sign-in callback lands on "/?code=…": that's the app's, not the landing page's.
  const file = req.method === "GET" && !(url.pathname === "/" && url.searchParams.has("code")) ? staticFile(url.pathname) : null;
  if (!file) {
    forward(req, res);
    return;
  }
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  createReadStream(file).pipe(res);
});

server.listen(PORT, () => {
  console.log(`Pyp live dashboard: http://localhost:${PORT}/app/  (API and sign-in from ${APP.origin})`);
});
