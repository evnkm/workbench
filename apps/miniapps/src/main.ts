// Independent local mini-app host. Workbench authenticates and proxies its API;
// neither the app database nor this loopback listener is exposed to the network.
import { join } from "node:path";
import { serve } from "@hono/node-server";
import { rolodexMessageSchema, rolodexResolutionSchema } from "@workbench/contracts";
import { createLogger, loadConfig, miniAppHostToken } from "@workbench/db";
import { Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { streamSSE } from "hono/streaming";
import { z } from "zod";
import { interpret } from "./agent.ts";
import { RolodexStore } from "./store.ts";

const config = loadConfig();
const log = createLogger("miniapps", config.logLevel);
const store = new RolodexStore(join(config.stateDir, "miniapps/rolodex/rolodex.sqlite"));
store.recover();
const app = new Hono();
const token = miniAppHostToken(config.stateDir);
app.use("*", async (c, next) => {
  if (c.req.header("authorization") !== `Bearer ${token}`) return c.json({ error: "Not authorized." }, 401);
  return next();
});
app.use("*", bodyLimit({ maxSize: 32_000 }));
app.onError((error, c) => c.json({ error: error instanceof z.ZodError ? z.prettifyError(error) : error.message }, 400));
app.get("/health", (c) => c.json({ ok: true }));
app.get("/rolodex/state", (c) => {
  c.header("Cache-Control", "no-store");
  return c.json(store.state());
});
app.get("/rolodex/events", (c) =>
  streamSSE(c, async (stream) => {
    let previous = -1;
    let heartbeat = 0;
    while (!stream.aborted && !stopping) {
      if (store.revision() !== previous) {
        const state = store.state();
        await stream.writeSSE({ event: "state", data: JSON.stringify(state), id: String(state.revision) });
        previous = state.revision;
      } else if (++heartbeat % 30 === 0) await stream.writeSSE({ event: "heartbeat", data: "{}" });
      await stream.sleep(500);
    }
  }),
);
app.post("/rolodex/messages", async (c) => {
  const body = rolodexMessageSchema.parse(await c.req.json());
  store.enqueue(body.id, body.text, body.provider);
  void drain();
  return c.json({ id: body.id }, 202);
});
app.post("/rolodex/messages/:id/resolve", async (c) => {
  const body = rolodexResolutionSchema.parse(await c.req.json());
  store.resolve(c.req.param("id"), body.choices, body.cancel);
  void drain();
  return c.json({ ok: true });
});
let working = false;
let stopping = false;
async function drain() {
  if (working || stopping) return;
  working = true;
  try {
    for (let row = store.next(); row && !stopping; row = store.next()) {
      store.update(row.id, "running");
      try {
        store.propose(row.id, await interpret(config, row.provider, row.text, store.state()));
      } catch (error) {
        store.update(row.id, "failed", (error as Error).message);
      }
    }
  } finally {
    working = false;
    if (stopping) {
      store.db.close();
      process.exit(0);
    }
  }
}
const timer = setInterval(() => void drain(), 1000);
const server = serve({ fetch: app.fetch, hostname: "127.0.0.1", port: 4312 }, () =>
  log.info("mini-app host listening", { port: 4312 }),
);
for (const signal of ["SIGTERM", "SIGINT"])
  process.on(signal, () => {
    stopping = true;
    clearInterval(timer);
    server.close();
    // systemd kills the service cgroup, including outstanding native CLI children.
    if (!working) {
      store.db.close();
      process.exit(0);
    }
  });
