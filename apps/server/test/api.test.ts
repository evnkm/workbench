import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nowIso, uuidv7 } from "@workbench/contracts";
import {
  createLogger,
  Database,
  getItem,
  loadConfig,
  saveConversation,
  saveItem,
  saveProject,
  saveWorkspace,
} from "@workbench/db";
import { createApp } from "../src/app.ts";
import { Auth, hashPassword } from "../src/auth.ts";
import { WorkerLink } from "../src/worker-link.ts";

const PASSWORD = "correct horse battery";
const ORIGIN = "http://wb.test";

function setup() {
  const state = mkdtempSync(join(tmpdir(), "wb-api-"));
  const config = loadConfig({
    WORKBENCH_STATE_DIR: state,
    WORKBENCH_PASSWORD_HASH: hashPassword(PASSWORD),
    WORKBENCH_SECURE_COOKIES: "false",
  } as NodeJS.ProcessEnv);
  const db = new Database(config.dbPath);
  db.migrate();
  const log = createLogger("test", "error");
  // No worker is listening: commands must still persist.
  const link = new WorkerLink(join(state, "absent.sock"), log);
  const app = createApp({ db, config, auth: new Auth(db, config), link, log });
  const call = (path: string, init: RequestInit & { cookie?: string } = {}) =>
    app.request(`${ORIGIN}${path}`, {
      ...init,
      headers: {
        host: "wb.test",
        "content-type": "application/json",
        ...(init.cookie ? { cookie: init.cookie } : {}),
        ...init.headers,
      },
    });
  const login = async () => {
    const r = await call("/api/auth/login", {
      method: "POST",
      headers: { origin: ORIGIN },
      body: JSON.stringify({ password: PASSWORD }),
    });
    assert.equal(r.status, 200);
    return r.headers.get("set-cookie")!.split(";")[0]!;
  };
  return { db, call, login, config };
}

test("unauthenticated requests cannot read state, send commands, or subscribe", async () => {
  const { call } = setup();
  assert.equal((await call("/api/state")).status, 401);
  assert.equal((await call("/api/events")).status, 401);
  const r = await call("/api/commands?wait=0", { method: "POST", headers: { origin: ORIGIN }, body: "{}" });
  assert.equal(r.status, 401);
});

test("wrong passwords are rejected and the cookie is HttpOnly and SameSite=Strict", async () => {
  const { call } = setup();
  const bad = await call("/api/auth/login", {
    method: "POST",
    headers: { origin: ORIGIN },
    body: JSON.stringify({ password: "nope" }),
  });
  assert.equal(bad.status, 401);
  const ok = await call("/api/auth/login", {
    method: "POST",
    headers: { origin: ORIGIN },
    body: JSON.stringify({ password: PASSWORD }),
  });
  const cookie = ok.headers.get("set-cookie")!;
  assert.match(cookie, /HttpOnly/);
  assert.match(cookie, /SameSite=Strict/);
});

test("mutations from another origin, or without an origin, are refused", async () => {
  const { call, login } = setup();
  const cookie = await login();
  const body = JSON.stringify({ requestId: "r-12345678", type: "project.register", payload: { path: "/x" } });
  const evil = await call("/api/commands?wait=0", {
    method: "POST",
    cookie,
    headers: { origin: "http://evil.test" },
    body,
  });
  assert.equal(evil.status, 403);
  const none = await call("/api/commands?wait=0", { method: "POST", cookie, body });
  assert.equal(none.status, 403);
  const sse = await call("/api/events", { cookie, headers: { origin: "http://evil.test" } });
  assert.equal(sse.status, 403);
});

test("repeated submission with one request id stores one command", async () => {
  const { call, login, db } = setup();
  const cookie = await login();
  const body = JSON.stringify({ requestId: "r-abcdefgh", type: "project.register", payload: { path: "/x" } });
  const send = () => call("/api/commands?wait=0", { method: "POST", cookie, headers: { origin: ORIGIN }, body });
  const [a, b] = await Promise.all([send(), send()]);
  const ca = (await a.json()) as { command: { id: string; state: string } };
  const cb = (await b.json()) as { command: { id: string } };
  assert.equal(ca.command.id, cb.command.id);
  assert.equal(ca.command.state, "accepted");
  assert.equal(db.get<{ n: number }>("SELECT count(*) n FROM commands")!.n, 1);
  const invalid = await call("/api/commands?wait=0", {
    method: "POST",
    cookie,
    headers: { origin: ORIGIN },
    body: JSON.stringify({ requestId: "r-abcdefgi", type: "workspace.create", payload: { projectId: "p", name: "" } }),
  });
  assert.equal(invalid.status, 400);
});

async function readSse(res: Response, until: (text: string) => boolean) {
  const reader = res.body!.getReader();
  let text = "";
  const dec = new TextDecoder();
  const deadline = Date.now() + 5000;
  while (!until(text) && Date.now() < deadline) {
    const { value, done } = await reader.read();
    if (done) break;
    text += dec.decode(value);
  }
  await reader.cancel();
  return text;
}

test("the event stream replays from a cursor and resets when the cursor is not retained", async () => {
  const { call, login, db } = setup();
  const cookie = await login();
  const now = nowIso();
  for (const name of ["a", "b", "c"]) {
    saveProject(db, {
      id: uuidv7(),
      name,
      repoPath: `/r/${name}`,
      defaultBranch: "main",
      setupCommand: null,
      runCommand: null,
      createdAt: now,
      updatedAt: now,
    });
  }
  const replay = await readSse(await call("/api/events?after=1", { cookie, headers: { origin: ORIGIN } }), (t) =>
    t.includes("id: 3"),
  );
  assert.match(replay, /event: ready/);
  assert.doesNotMatch(replay, /\nid: 1\n/);
  assert.match(replay, /id: 2\n/);
  assert.match(replay, /id: 3\n/);
  const reset = await readSse(await call("/api/events?after=999", { cookie, headers: { origin: ORIGIN } }), (t) =>
    t.includes("reset"),
  );
  assert.match(reset, /event: reset/);
  // Last-Event-ID (sent by EventSource on reconnect) takes precedence.
  const resumed = await readSse(
    await call("/api/events?after=0", { cookie, headers: { origin: ORIGIN, "last-event-id": "2" } }),
    (t) => t.includes("id: 3"),
  );
  assert.doesNotMatch(resumed, /id: 2\n/);
});

test("the worker link survives a stale socket file and a vanished worker", async () => {
  const { writeFileSync } = await import("node:fs");
  const dir = mkdtempSync(join(tmpdir(), "wb-link-"));
  const path = join(dir, "worker.sock");
  writeFileSync(path, ""); // left behind by a crashed worker
  const link = new WorkerLink(path, createLogger("test", "error"));
  link.start();
  await new Promise((r) => setTimeout(r, 2500)); // several reconnect attempts
  assert.equal(link.connected, false);
  link.close();
});

test("conversation images require auth and a stored image reference, and survive source deletion", async () => {
  const { db, call, login, config } = setup();
  const now = nowIso();
  const projectId = uuidv7(),
    workspaceId = uuidv7(),
    conversationId = uuidv7(),
    itemId = uuidv7();
  saveProject(db, {
    id: projectId,
    name: "Images",
    repoPath: config.stateDir,
    defaultBranch: "main",
    setupCommand: null,
    runCommand: null,
    createdAt: now,
    updatedAt: now,
  });
  saveWorkspace(db, {
    id: workspaceId,
    projectId,
    name: "Images",
    branch: "main",
    baseRef: "main",
    worktreePath: config.stateDir,
    state: "ready",
    error: null,
    setupExitCode: null,
    portBase: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  saveConversation(db, {
    id: conversationId,
    workspaceId,
    provider: "codex",
    providerThreadId: null,
    title: "Images",
    model: null,
    approvalPolicy: "never",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  });
  const path = join(config.stateDir, "screen.png");
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  writeFileSync(path, bytes);
  saveItem(db, {
    id: itemId,
    conversationId,
    runId: null,
    providerItemId: null,
    kind: "agent_message",
    status: "completed",
    data: { text: `![Screenshot](${path})\n\n\`\`\`md\n![Example](/tmp/private.png)\n\`\`\`` },
    createdAt: now,
    updatedAt: now,
  });
  const url = `/api/items/${itemId}/image?source=${encodeURIComponent(path)}`;
  assert.equal((await call(url)).status, 401);
  const cookie = await login();
  assert.equal((await call(`/api/items/${itemId}/image?source=/tmp/private.png`, { cookie })).status, 404);
  const first = await call(url, { cookie });
  assert.equal(first.status, 200);
  assert.equal(first.headers.get("content-type"), "image/png");
  assert.equal(first.headers.get("x-content-type-options"), "nosniff");
  assert.deepEqual(Buffer.from(await first.arrayBuffer()), bytes);
  assert.ok(getItem(db, itemId)!.data.images?.[0]?.mediaId);
  rmSync(path);
  const replay = await call(url, { cookie });
  assert.equal(replay.status, 200);
  assert.deepEqual(Buffer.from(await replay.arrayBuffer()), bytes);
});
