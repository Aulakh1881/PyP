// The prototype dashboard's files (prototype/website), served on live data. Shared by
// scripts/live-dashboard.mjs (local, :3001 in front of `npm run dev`) and
// scripts/serve.mjs (production: Render), so both answer the same paths the same way.

import { createReadStream, statSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../prototype/website");
const NODE_MODULES = path.resolve(ROOT, "../../node_modules");

const TYPES = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".ico": "image/x-icon",
  ".json": "application/json",
};

// Switches the pages to the live transport (prototype/website/shared/live-transport.js).
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

function bryntumFile(pathname) {
  const match = pathname.match(/^\/vendor\/bryntum\/((?:core|engine|grid|scheduler)-community)\/(.+)$/);
  if (!match) return null;
  const file = path.resolve(NODE_MODULES, "@bryntum", match[1], match[2]);
  if (!file.startsWith(path.resolve(NODE_MODULES, "@bryntum") + path.sep)) return null;
  try {
    return statSync(file).isFile() ? file : null;
  } catch {
    return null;
  }
}

/**
 * Answers the request if it's one of the dashboard's files and returns true;
 * returns false so the caller hands it to the Next.js app.
 */
export function serveDashboardFile(req, res) {
  const url = new URL(req.url ?? "/", "http://localhost");

  if (url.pathname === "/shared/runtime-config.js") {
    res.writeHead(200, { "Content-Type": TYPES[".js"], "Cache-Control": "no-store" });
    res.end(RUNTIME_CONFIG);
    return true;
  }
  if (url.pathname === "/app") {
    res.writeHead(308, { Location: "/app/" + url.search });
    res.end();
    return true;
  }
  // The sign-in callback lands on "/?code=…": that's the app's, not the landing page's.
  const file = (req.method === "GET" || req.method === "HEAD") && !(url.pathname === "/" && url.searchParams.has("code"))
    ? bryntumFile(url.pathname) ?? staticFile(url.pathname)
    : null;
  if (!file) return false;
  res.writeHead(200, { "Content-Type": TYPES[path.extname(file)] ?? "application/octet-stream", "Cache-Control": "no-store" });
  if (req.method === "HEAD") res.end();
  else createReadStream(file).pipe(res);
  return true;
}
