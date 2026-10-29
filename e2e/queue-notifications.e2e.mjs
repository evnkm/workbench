// Disposable API and platform fixtures; never submits a real Codex turn or push.
import assert from "node:assert/strict";
import { chromium, devices } from "playwright";

const base = process.env.B ?? "http://127.0.0.1:5180";
const now = new Date().toISOString();
const conversation = {
  id: "c",
  workspaceId: "w",
  provider: "codex",
  title: "Queued conversation",
  model: null,
  reasoningEffort: null,
  serviceTier: null,
  approvalPolicy: "never",
  createdAt: now,
  lastActivityAt: now,
};
const workspace = {
  id: "w",
  projectId: "p",
  name: "Queue fixture",
  state: "ready",
  branch: "test",
  baseRef: "main",
  worktreePath: "/fixture",
  createdAt: now,
};
const initialRun = {
  id: "active",
  kind: "agent_turn",
  conversationId: "c",
  workspaceId: "w",
  state: "running",
  summary: "Original task",
  createdAt: now,
  startedAt: now,
  endedAt: null,
};
const browser = await chromium.launch();
try {
  for (const [name, options] of [
    ["desktop", { viewport: { width: 1440, height: 1000 } }],
    ["mobile", devices["iPhone 13"]],
    ["installed mobile", devices["iPhone 13"]],
  ]) {
    const context = await browser.newContext(options);
    let seq = 100;
    const commands = [];
    const subscriptions = [];
    let runs = [initialRun];
    await context.addInitScript((standalone) => {
      if (standalone) {
        const original = window.matchMedia.bind(window);
        window.matchMedia = (query) => (query === "(display-mode: standalone)" ? { matches: true } : original(query));
      }
      window.EventSource = class extends EventTarget {
        constructor() {
          super();
          window.testEvents = this;
          setTimeout(() => this.dispatchEvent(new Event("ready")), 5);
        }
        close() {}
      };
      window.soundCount = 0;
      window.AudioContext = class {
        currentTime = 0;
        destination = {};
        resume() {
          return Promise.resolve();
        }
        createOscillator() {
          return {
            frequency: {},
            connect() {},
            start() {
              window.soundCount++;
            },
            stop() {},
          };
        }
        createGain() {
          return {
            gain: { setValueAtTime() {}, linearRampToValueAtTime() {}, exponentialRampToValueAtTime() {} },
            connect() {},
          };
        }
      };
      window.PushManager = class {};
      window.Notification = {
        permission: "default",
        requestPermission() {
          window.Notification.permission = "granted";
          return Promise.resolve("granted");
        },
      };
      let subscription = null;
      const pushManager = {
        getSubscription: async () => subscription,
        subscribe: async () => {
          subscription = {
            endpoint: "https://fcm.googleapis.com/fcm/send/fixture",
            options: {},
            toJSON: () => ({
              endpoint: "https://fcm.googleapis.com/fcm/send/fixture",
              keys: { p256dh: "key", auth: "auth" },
            }),
            unsubscribe: async () => {
              subscription = null;
              return true;
            },
          };
          return subscription;
        },
      };
      const registration = { pushManager };
      Object.defineProperty(navigator, "serviceWorker", {
        value: { register: async () => registration, ready: Promise.resolve(registration) },
      });
    }, name === "installed mobile");
    const page = await context.newPage();
    const errors = [];
    page.on("pageerror", (error) => errors.push(error.message));
    const event = async (run) => {
      runs = [...runs.filter((r) => r.id !== run.id), run];
      await page.evaluate(
        (event) => window.testEvents.dispatchEvent(new MessageEvent("event", { data: JSON.stringify(event) })),
        { type: "run.upserted", run, conversationId: "c", seq: ++seq, createdAt: now },
      );
    };
    await context.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/state")
        return route.fulfill({
          json: {
            cursor: seq,
            projects: [],
            workspaces: [workspace],
            conversations: [conversation],
            activeRuns: runs.filter((r) => ["running", "queued"].includes(r.state)),
            openInputs: [],
            worker: { heartbeatAt: now, codex: { state: "ready" } },
          },
        });
      if (path.endsWith("/snapshot"))
        return route.fulfill({ json: { cursor: seq, conversation, runs, items: [], inputs: [], hasMore: false } });
      if (path === "/api/commands") {
        const command = route.request().postDataJSON();
        commands.push(command);
        if (command.type === "turn.start")
          await event({
            ...initialRun,
            id: `queued-${commands.length}`,
            state: "queued",
            startedAt: null,
            summary: command.payload.text,
          });
        if (command.type === "turn.interrupt")
          await event({
            ...runs.find((r) => r.id === command.payload.runId),
            state: "cancelled",
            endedAt: new Date().toISOString(),
          });
        return route.fulfill({ json: { command: { id: command.requestId, state: "succeeded", result: {} } } });
      }
      if (path === "/api/notifications/key")
        return route.fulfill({
          json: {
            publicKey: "BAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA",
          },
        });
      if (path === "/api/notifications/subscriptions" || path === "/api/notifications/test")
        subscriptions.push({ path, method: route.request().method() });
      return route.fulfill({ json: { ok: true } });
    });
    await page.goto(`${base}/w/w/c/c`);
    const input = page.getByRole("combobox", { name: "Message" });
    await input.fill("First follow-up");
    await page.getByRole("button", { name: "Queue message", exact: true }).click();
    await input.fill("Second follow-up");
    if (name === "desktop") await input.press("Enter");
    else await page.getByRole("button", { name: "Queue message", exact: true }).click();
    await page.getByRole("region", { name: "Queued messages" }).getByText("2 queued", { exact: false }).waitFor();
    assert.equal(commands.filter((c) => c.type === "turn.start").length, 2);
    await page.reload();
    await page.getByRole("region", { name: "Queued messages" }).getByText("First follow-up").waitFor();
    await page.getByRole("button", { name: "Remove queued message 1" }).click();
    await page.getByRole("region", { name: "Queued messages" }).getByText("1 queued", { exact: false }).waitFor();
    assert.equal(runs.find((r) => r.id === "active").state, "running");
    const bell = page.getByRole("button", { name: "Turn notifications", exact: true });
    await bell.filter({ visible: true }).click();
    const dialog = page.getByRole("dialog", { name: "Turn notifications" });
    await dialog.getByRole("checkbox").check();
    assert.equal(await page.evaluate(() => window.soundCount), 2);
    const delivered = runs.find((r) => r.state === "queued");
    if (delivered) {
      await event({
        ...delivered,
        state: "succeeded",
        stopReason: "delivered to live turn",
        endedAt: new Date().toISOString(),
      });
      assert.equal(await page.evaluate(() => window.soundCount), 2);
      assert.equal(runs.find((r) => r.id === "active").state, "running");
      assert.equal(await page.getByRole("region", { name: "Queued messages" }).count(), 0);
    }
    await event({ ...initialRun, state: "succeeded", endedAt: new Date().toISOString() });
    assert.equal(await page.evaluate(() => window.soundCount), 4);
    await event({ ...initialRun, state: "succeeded", endedAt: new Date().toISOString() });
    assert.equal(await page.evaluate(() => window.soundCount), 4);
    if (name !== "mobile") {
      await dialog.getByRole("button", { name: "Enable device notifications" }).click();
      await dialog.getByRole("button", { name: "Send test notification" }).click();
      await dialog.getByText("Test notification sent to this device.").waitFor();
      await dialog.getByRole("button", { name: "Disable device notifications" }).click();
      assert.deepEqual(
        subscriptions.map((r) => r.method),
        ["POST", "POST", "DELETE"],
      );
    } else {
      await dialog.getByText(/add Workbench to your Home Screen/).waitFor();
      assert.equal(await dialog.getByRole("button", { name: "Enable device notifications" }).isDisabled(), true);
    }
    assert.deepEqual(errors, []);
    console.log(`${name}: queue, removal, refresh, sound deduplication, and notifications passed`);
    await context.close();
  }
} finally {
  await browser.close();
}
