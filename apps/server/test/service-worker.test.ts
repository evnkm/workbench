import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { runInNewContext } from "node:vm";

test("push always displays an alert and notification clicks focus the correct same-origin conversation", async () => {
  const handlers = new Map<string, (event: unknown) => void>();
  const shown: unknown[] = [];
  const navigated: string[] = [];
  let focused = 0;
  const origin = "https://workbench.test";
  const self = {
    addEventListener: (name: string, callback: (event: unknown) => void) => handlers.set(name, callback),
    location: { origin },
    registration: { showNotification: async (title: string, options: unknown) => shown.push({ title, options }) },
    clients: {
      matchAll: async () => [
        { url: `${origin}/`, navigate: async (url: string) => navigated.push(url), focus: async () => focused++ },
      ],
      openWindow: async (url: string) => navigated.push(url),
    },
  };
  runInNewContext(readFileSync(new URL("../../web/public/sw.js", import.meta.url), "utf8"), { self, URL });
  let pending: Promise<unknown> | null = null;
  const waitUntil = (promise: Promise<unknown>) => {
    pending = promise;
  };
  handlers.get("push")!({
    data: { json: () => ({ title: "Codex finished", body: "Feature", tag: "run-id", url: "/w/w/c/c" }) },
    waitUntil,
  });
  await pending;
  assert.equal(shown.length, 1);
  assert.equal((shown[0] as { title: string }).title, "Codex finished");
  handlers.get("notificationclick")!({ notification: { close: () => {}, data: { url: "/w/w/c/c" } }, waitUntil });
  await pending;
  assert.deepEqual(navigated, [`${origin}/w/w/c/c`]);
  assert.equal(focused, 1);
  handlers.get("notificationclick")!({
    notification: { close: () => {}, data: { url: "https://external.test/" } },
    waitUntil,
  });
  assert.equal(navigated.length, 1);
});
