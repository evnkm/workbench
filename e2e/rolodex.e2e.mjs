// Full local stack with disposable SQLite databases and real CLI inference.
// No production contacts, conversations, or credentials are modified.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { chromium, devices } from "playwright";
import { createAuthSession, Database, miniAppHostToken } from "../packages/db/src/index.ts";

const root = resolve(import.meta.dirname, "..");
const stateDir = mkdtempSync(join(tmpdir(), "wb-rolodex-e2e-"));
const base = "http://127.0.0.1:4313";
const db = new Database(join(stateDir, "workbench.sqlite"));
db.migrate();
const token = randomBytes(32).toString("base64url");
createAuthSession(db, createHash("sha256").update(token).digest("hex"), 600_000, "Rolodex integration test");
const logs = [];
const start = (entry) => {
  const child = spawn(process.execPath, [entry], {
    cwd: root,
    env: {
      ...process.env,
      WORKBENCH_STATE_DIR: stateDir,
      WORKBENCH_PORT: "4313",
      WORKBENCH_SECURE_COOKIES: "false",
      WORKBENCH_WEB_DIST: join(root, "apps/web/dist"),
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  child.stdout.on("data", (c) => logs.push(c.toString()));
  child.stderr.on("data", (c) => logs.push(c.toString()));
  return child;
};
const host = start("apps/miniapps/src/main.ts");
const server = start("apps/server/src/main.ts");
const browser = await chromium.launch({ args: ["--enable-unsafe-swiftshader"] });
const waitFor = async (fn, timeout = 90_000) => {
  const end = Date.now() + timeout;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch {
      /* Wait for startup/state transition. */
    }
    if (Date.now() > end) throw new Error("Timed out waiting for Rolodex");
    await new Promise((r) => setTimeout(r, 250));
  }
};
const request = async (path, body) => {
  const r = await fetch(`${base}/api/apps/rolodex${path}`, {
    method: body ? "POST" : "GET",
    headers: { Cookie: `wb_session=${token}`, Origin: base, "Content-Type": "application/json" },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.ok(r.ok, `${r.status} ${await r.clone().text()}`);
  return r.json();
};
let debugPage;
try {
  await waitFor(
    async () => (await fetch(`${base}/api/auth/session`, { headers: { Cookie: `wb_session=${token}` } })).ok,
  );
  await waitFor(
    async () =>
      (
        await fetch("http://127.0.0.1:4312/health", {
          headers: { Authorization: `Bearer ${miniAppHostToken(stateDir)}` },
        })
      ).ok,
  );
  assert.equal((await fetch(`${base}/api/apps/rolodex/state`)).status, 401);
  assert.equal((await fetch("http://127.0.0.1:4312/rolodex/state")).status, 401);
  const context = await browser.newContext({ viewport: { width: 1500, height: 1000 } });
  await context.addCookies([{ name: "wb_session", value: token, url: base }]);
  const page = await context.newPage();
  debugPage = page;
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto(`${base}/apps`);
  await page.getByRole("heading", { name: "Mini-apps" }).waitFor();
  await page.getByRole("button", { name: /^Rolodex/ }).click();
  await page.getByRole("heading", { name: "Rolodex", exact: true }).waitFor();
  const pill = page.getByRole("button", { name: "Open Rolodex chat" });
  await pill.waitFor();
  const old = await pill.boundingBox();
  await page.mouse.move(old.x + old.width / 2, old.y + old.height / 2);
  await page.mouse.down();
  await page.mouse.move(old.x + 200, old.y - 70, { steps: 10 });
  await page.mouse.up();
  const moved = await pill.boundingBox();
  assert.ok(moved.x > old.x + 100);
  assert.ok(moved.y < old.y - 50);
  await pill.click();
  const input = page.getByRole("textbox", { name: "Tell Rolodex about someone" });
  await input.fill(
    "I just met Test Bob at a robotics meetup. Test Bob is a designer and knows Test Alice, who is an engineer.",
  );
  await page.getByRole("button", { name: "Send Rolodex note" }).click();
  const first = await waitFor(async () => {
    const s = await request("/state");
    if (s.messages.at(-1)?.status === "failed") throw new Error(s.messages.at(-1).error);
    return s.people.length === 2 && s.connections.length === 1 ? s : null;
  });
  await page.getByText("2 people, 1 connection", { exact: true }).waitFor();
  assert.ok(await page.locator('[data-testid="rolodex-graph"] canvas').count());
  await page.getByRole("button", { name: "Collapse Rolodex chat" }).click();
  await page.getByRole("textbox", { name: "Find a person" }).fill("Test Bob");
  await page.getByRole("button", { name: /Test Bob/ }).click();
  await page.getByRole("region", { name: "Test Bob person card" }).waitFor();
  await page.screenshot({ path: "/tmp/workbench-rolodex-desktop.png" });
  await page.getByRole("button", { name: "Close person card" }).click();
  await page.getByRole("button", { name: "Open Rolodex chat" }).click();
  await page.getByRole("combobox", { name: "Rolodex AI provider" }).selectOption("claude");
  await input.fill(
    "I met a different person also named Test Bob at a poetry reading. This Test Bob is a poet, not the designer.",
  );
  await page.getByRole("button", { name: "Send Rolodex note" }).click();
  const confirm = await waitFor(async () => {
    const s = await request("/state");
    return s.messages.at(-1)?.status === "confirm" ? s : null;
  });
  assert.equal(confirm.people.length, 2);
  await page.getByText("Is this someone already in your Rolodex?").waitFor();
  assert.equal(await page.getByRole("button", { name: "Save", exact: true }).isDisabled(), true);
  await page.getByRole("radio", { name: /New person named/ }).check();
  await page.getByRole("button", { name: "Save", exact: true }).click();
  await waitFor(async () => (await request("/state")).people.length === 3);
  await page.getByRole("button", { name: "Collapse Rolodex chat" }).click();
  await page.reload();
  await page.getByText(/^3 people,/).waitFor();
  const state = await request("/state");
  assert.equal(state.people.filter((p) => p.name === "Test Bob").length, 2);
  const exportDb = new Database(join(stateDir, "miniapps/rolodex/rolodex.sqlite"));
  const backup = join(stateDir, "backup.sqlite");
  exportDb.backupTo(backup);
  exportDb.close();
  const restored = new Database(backup);
  assert.equal(restored.get("SELECT count(*) AS n FROM people").n, 3);
  restored.close();
  await context.close();
  const mobile = await browser.newContext(devices["iPhone 13"]);
  await mobile.addCookies([{ name: "wb_session", value: token, url: base }]);
  const phone = await mobile.newPage();
  phone.on("pageerror", (e) => errors.push(e.message));
  await phone.goto(`${base}/apps/rolodex`);
  await phone.getByRole("button", { name: "Open Rolodex chat" }).click();
  await phone.getByRole("textbox", { name: "Tell Rolodex about someone" }).waitFor();
  await phone.screenshot({ path: "/tmp/workbench-rolodex-mobile.png" });
  assert.equal(await phone.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  assert.deepEqual(errors, []);
  assert.equal(first.messages[0].provider, "codex");
  assert.equal(state.messages[1].provider, "claude");
  console.log(
    "PASS real Codex + Claude Code, authenticated local host, SSE graph updates, draggable pill, identity cards, separate same-name people, refresh, SQLite backup, desktop and mobile",
  );
  await mobile.close();
} catch (error) {
  if (debugPage && !debugPage.isClosed()) await debugPage.screenshot({ path: "/tmp/workbench-rolodex-failure.png" });
  writeFileSync("/tmp/workbench-rolodex-e2e-errors.log", logs.join(""));
  throw error;
} finally {
  await browser.close();
  host.kill("SIGTERM");
  server.kill("SIGTERM");
  await Promise.all(
    [host, server].map((child) =>
      child.exitCode !== null ? Promise.resolve() : new Promise((r) => child.once("exit", r)),
    ),
  );
  db.close();
  rmSync(stateDir, { recursive: true, force: true });
}
