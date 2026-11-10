// Production server (Render): one process, one origin.
//
// Serves the dashboard's files (prototype/website, on live data) and hands every
// other request (/api, /login, /dashboard, /_next, the sign-in callback) to the
// Next.js app in this same process. It's what `npm run live` + `npm run dev` do
// locally, without the second port. The worker loop (instrumentation.ts) starts
// with the app, so keep exactly one instance running.
//
//   npm run build
//   npm start          # NODE_ENV=production node scripts/serve.mjs, on $PORT

import http from "node:http";
import next from "next";
import { serveDashboardFile } from "./dashboard-files.mjs";

const port = Number(process.env.PORT || 3000);
const dev = process.env.NODE_ENV !== "production";
const app = next({ dev, port });
const handle = app.getRequestHandler();

await app.prepare();

http
  .createServer((req, res) => {
    if (serveDashboardFile(req, res)) return;
    // The dashboard is on this origin's /app/: tells /dashboard to send sign-in there
    // (a fixed path, so a forged header can only send you to this origin's /app/).
    req.headers["x-pyp-live-dashboard"] = "1";
    handle(req, res);
  })
  .listen(port, () => {
    console.log(`Pyp on http://localhost:${port}/ (${dev ? "development" : "production"})`);
  });
