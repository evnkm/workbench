import assert from "node:assert/strict";
import { createECDH, createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { Run, TurnNotification } from "@workbench/contracts";
import { createAuthSession, createLogger, Database, loadConfig, saveRun, updateRun } from "@workbench/db";
import { createApp } from "../src/app.ts";
import { Auth } from "../src/auth.ts";
import { PushNotifications } from "../src/notifications.ts";
import { WorkerLink } from "../src/worker-link.ts";

const origin = "https://workbench.test";
const subscription = {
  endpoint: "https://fcm.googleapis.com/fcm/send/test-device",
  keys: {
    p256dh: createECDH("prime256v1").generateKeys().toString("base64url"),
    auth: randomBytes(16).toString("base64url"),
  },
};
const run = (): Run => ({
  id: crypto.randomUUID(),
  kind: "agent_turn",
  workspaceId: "w",
  conversationId: "c",
  jobId: null,
  state: "running",
  providerTurnId: "turn",
  summary: "work",
  stopReason: null,
  error: null,
  attempt: 1,
  createdAt: new Date().toISOString(),
  startedAt: new Date().toISOString(),
  endedAt: null,
});

test("authenticated device subscriptions, transactional completion outbox, retries, restart, and logout", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-notifications-"));
  const config = loadConfig({ WORKBENCH_STATE_DIR: dir });
  const db = new Database(config.dbPath);
  db.migrate();
  const token = randomBytes(32).toString("base64url");
  const hash = createHash("sha256").update(token).digest("hex");
  createAuthSession(db, hash, 60_000, "test");
  const log = createLogger("test", "error");
  const deliveries: TurnNotification[] = [];
  let failure: number | null = null;
  const sender = async (_subscription: unknown, payload: string) => {
    if (failure) throw { statusCode: failure };
    deliveries.push(JSON.parse(payload));
  };
  const push = new PushNotifications(db, config, log, sender);
  const app = createApp({
    db,
    config,
    auth: new Auth(db, config),
    link: new WorkerLink(config.workerSocket, log),
    log,
    notifications: push,
  });
  const call = (path: string, method = "GET", body?: unknown, authenticated = true) =>
    app.request(`${origin}${path}`, {
      method,
      headers: {
        host: "workbench.test",
        origin,
        "content-type": "application/json",
        ...(authenticated ? { cookie: `wb_session=${token}` } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  try {
    assert.equal((await call("/api/notifications/key", "GET", undefined, false)).status, 401);
    const publicKey = ((await (await call("/api/notifications/key")).json()) as { publicKey: string }).publicKey;
    assert.equal(
      (
        await call("/api/notifications/subscriptions", "POST", {
          ...subscription,
          endpoint: "https://127.0.0.1/secret",
        })
      ).status,
      400,
    );
    assert.equal((await call("/api/notifications/subscriptions", "POST", subscription)).status, 200);
    db.raw.exec(`INSERT INTO projects (id,name,repo_path,default_branch,created_at,updated_at) VALUES ('p','p','/repo','main','now','now');
      INSERT INTO workspaces (id,project_id,name,branch,base_ref,worktree_path,state,created_at,updated_at) VALUES ('w','p','w','main','main','/worktree','ready','now','now');
      INSERT INTO conversations (id,workspace_id,provider,title,approval_policy,created_at,updated_at,last_activity_at) VALUES ('c','w','codex','A conversation','never','now','now','now');`);
    const first = saveRun(db, run());
    assert.throws(
      () =>
        db.tx(() => {
          updateRun(db, first.id, { state: "succeeded", endedAt: new Date().toISOString() });
          throw new Error("rollback");
        }),
      /rollback/,
    );
    assert.equal(db.all("SELECT * FROM push_deliveries").length, 0);
    updateRun(db, first.id, { state: "succeeded", endedAt: new Date().toISOString() });
    updateRun(db, first.id, { state: "succeeded" });
    assert.equal(db.all("SELECT * FROM push_deliveries").length, 1);
    failure = 503;
    await push.deliver();
    assert.equal(db.get<{ attempts: number }>("SELECT attempts FROM push_deliveries")!.attempts, 1);
    failure = null;
    db.run("UPDATE push_deliveries SET next_attempt_at = 0");
    const restarted = new PushNotifications(db, config, log, sender);
    assert.equal(restarted.publicKey, publicKey);
    await restarted.deliver();
    assert.equal(deliveries.length, 1);
    assert.equal(deliveries[0]!.url, "/w/w/c/c");
    assert.equal(deliveries[0]!.tag, first.id);
    assert.equal(deliveries[0]!.title, "Codex finished");
    assert.equal(db.all("SELECT * FROM push_deliveries").length, 0);
    const queued = saveRun(db, { ...run(), state: "queued", providerTurnId: null, startedAt: null });
    updateRun(db, queued.id, { state: "cancelled", endedAt: new Date().toISOString() });
    assert.equal(db.all("SELECT * FROM push_deliveries").length, 0);
    const steered = saveRun(db, { ...run(), state: "queued", providerTurnId: null, startedAt: null });
    updateRun(db, steered.id, {
      state: "succeeded",
      endedAt: new Date().toISOString(),
      stopReason: "delivered to live turn",
    });
    assert.equal(db.all("SELECT * FROM push_deliveries").length, 0);
    assert.equal((await call("/api/notifications/test", "POST", null)).status, 400);
    assert.equal((await call("/api/notifications/test", "POST", { endpoint: subscription.endpoint })).status, 200);
    failure = 410;
    await restarted.deliver();
    assert.equal(db.all("SELECT * FROM push_subscriptions").length, 0);
    assert.equal(db.all("SELECT * FROM push_deliveries").length, 0);
    await call("/api/notifications/subscriptions", "POST", subscription);
    await call("/api/notifications/test", "POST", { endpoint: subscription.endpoint });
    await call("/api/auth/logout", "POST", {});
    assert.equal(db.all("SELECT * FROM push_subscriptions").length, 0);
    assert.equal(db.all("SELECT * FROM push_deliveries").length, 0);
  } finally {
    push.stop();
    db.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
