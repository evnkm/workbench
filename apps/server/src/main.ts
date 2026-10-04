// Workbench API server: authentication, static assets, commands, and event
// delivery. Restarting it never affects the worker or running executions.
import { existsSync, readFileSync } from "node:fs";
import type { Server } from "node:http";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createLogger, Database, loadConfig, pruneAuthSessions } from "@workbench/db";
import { createApp } from "./app.ts";
import { Auth } from "./auth.ts";
import { Previews } from "./previews.ts";
import { attachTerminals } from "./terminals.ts";
import { WorkerLink } from "./worker-link.ts";

const config = loadConfig();
const log = createLogger("server", config.logLevel);
const db = new Database(config.dbPath);
db.migrate();
const auth = new Auth(db, config);
const link = new WorkerLink(config.workerSocket, log);
link.start();

const previews = new Previews(db, config, log);
const app = createApp({ db, config, auth, link, log, previews });

// Static web assets with an SPA fallback. Hashed assets are immutable.
if (existsSync(config.webDist)) {
  app.use(
    "/assets/*",
    serveStatic({
      root: config.webDist,
      onFound: (_p, c) => {
        c.header("Cache-Control", "public, max-age=31536000, immutable");
      },
    }),
  );
  app.use("/*", serveStatic({ root: config.webDist }));
  app.get("*", (c) => {
    if (c.req.path.startsWith("/api/")) return c.json({ error: "Not found." }, 404);
    c.header("Cache-Control", "no-cache");
    // Read per request so a rebuilt bundle never pairs with a stale index.
    return c.html(readFileSync(join(config.webDist, "index.html"), "utf8"));
  });
} else {
  log.warn("web assets not built; serving the API only", { webDist: config.webDist });
}

const server = serve({ fetch: app.fetch, hostname: config.host, port: config.port }, (info) =>
  log.info("server listening", { host: info.address, port: info.port }),
);

attachTerminals(server as Server, { db, config, auth, log });

const sweeper = setInterval(() => pruneAuthSessions(db), 3600_000);
const previewSweeper = setInterval(() => previews.sweep(), 30_000);

function shutdown(signal: string) {
  log.info("server stopping", { signal });
  clearInterval(sweeper);
  clearInterval(previewSweeper);
  previews.close();
  link.close();
  server.close();
  // Open SSE streams would otherwise hold the process.
  setTimeout(() => process.exit(0), 2000).unref();
  db.close();
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));
