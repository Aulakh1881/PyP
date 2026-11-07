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
//
// Signing in through :3001 lands back on :3001/app/ (app/dashboard/page.tsx).

import { createReadStream, statSync } from "node:fs";
import http from "node:http";
import net from "node:net";
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
    // x-pyp-live-dashboard tells /dashboard to send sign-in back to this server's /app/.
    { hostname: APP.hostname, port: APP.port, method: req.method, path: req.url, headers: { ...req.headers, "x-pyp-live-dashboard": "1" } },
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

// Websockets (Next.js's dev connection at /_next/hmr) aren't plain requests, so the
// handler above never sees them. Without them the dev pages never start: forms look
// fine but do nothing (sign-in just reloads). Pass the raw connection through.
server.on("upgrade", (req, socket, head) => {
  const upstream = net.connect(Number(APP.port || 80), APP.hostname, () => {
    const lines = [`${req.method} ${req.url} HTTP/${req.httpVersion}`];
    for (let i = 0; i < req.rawHeaders.length; i += 2) lines.push(`${req.rawHeaders[i]}: ${req.rawHeaders[i + 1]}`);
    lines.push("x-pyp-live-dashboard: 1");
    upstream.write(lines.join("\r\n") + "\r\n\r\n");
    if (head && head.length) upstream.write(head);
    upstream.pipe(socket);
    socket.pipe(upstream);
  });
  const close = () => { socket.destroy(); upstream.destroy(); };
  upstream.on("error", close);
  socket.on("error", close);
});

// Local only: this forwards to the app with your sign-in, so other machines mustn't reach it.
server.listen(PORT, "127.0.0.1", () => {
  console.log(`Pyp live dashboard: http://localhost:${PORT}/app/  (API and sign-in from ${APP.origin})`);
});
