import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync } from "node:fs";
import { createServer as createHttpsServer } from "node:https";
import { connect } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, test } from "node:test";
import { nowIso, uuidv7 } from "@workbench/contracts";
import { createLogger, Database, loadConfig, saveProcess, saveProject, saveWorkspace } from "@workbench/db";
import { Previews } from "../src/previews.ts";

const closers: (() => void)[] = [];
after(() => {
  for (const c of closers) c();
});

test("previews proxy HTTPS dev servers with self-signed certificates, including WebSocket upgrades", async () => {
  const dir = mkdtempSync(join(tmpdir(), "wb-preview-"));
  // A self-signed localhost certificate, like Vite's plugin-basic-ssl.
  execFileSync(
    "openssl",
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-nodes",
      "-days",
      "1",
      "-subj",
      "/CN=localhost",
      "-keyout",
      join(dir, "key.pem"),
      "-out",
      join(dir, "cert.pem"),
    ],
    { stdio: "ignore" },
  );
  const appPort = 19600 + Math.floor(Math.random() * 150);
  const app = createHttpsServer(
    { key: readFileSync(join(dir, "key.pem")), cert: readFileSync(join(dir, "cert.pem")) },
    (req, res) => {
      res.end(`secure app host=${req.headers.host} cookie=${req.headers.cookie ?? ""}`);
    },
  );
  app.on("upgrade", (_req, socket) => {
    socket.write("HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\n\r\n");
    socket.on("data", (d) => socket.write(`echo:${d}`));
  });
  await new Promise<void>((r) => app.listen(appPort, "127.0.0.1", r));
  closers.push(() => app.close());

  process.env.WORKBENCH_PREVIEW_HOST = "127.0.0.1";
  const config = loadConfig({ WORKBENCH_STATE_DIR: join(dir, "state") } as NodeJS.ProcessEnv);
  const db = new Database(config.dbPath);
  db.migrate();
  const now = nowIso();
  const project = saveProject(db, {
    id: uuidv7(),
    name: "p",
    repoPath: dir,
    defaultBranch: "main",
    setupCommand: null,
    runCommand: null,
    createdAt: now,
    updatedAt: now,
  });
  const workspace = saveWorkspace(db, {
    id: uuidv7(),
    projectId: project.id,
    name: "w",
    branch: "b",
    baseRef: "main",
    worktreePath: dir,
    state: "ready",
    error: null,
    setupExitCode: null,
    portBase: appPort - 1,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  saveProcess(db, {
    id: uuidv7(),
    workspaceId: workspace.id,
    kind: "app",
    name: "App",
    command: "x",
    cwd: dir,
    tmuxSession: "t",
    state: "running",
    exitCode: null,
    port: appPort,
    createdAt: now,
    updatedAt: now,
    endedAt: null,
  });
  const previews = new Previews(db, config, createLogger("test", "error"));
  closers.push(() => previews.close());

  const link = new URL(await previews.link(appPort, "/"));
  assert.equal(Number(link.port), appPort + 10_000);
  const enter = await fetch(link, { redirect: "manual" });
  assert.equal(enter.status, 302);
  const cookie = enter.headers.get("set-cookie")!.split(";")[0]!;
  const page = await fetch(`${link.origin}/`, { headers: { cookie: `${cookie}; theirs=1` } });
  assert.equal(page.status, 200);
  assert.equal(await page.text(), `secure app host=localhost:${appPort} cookie=theirs=1`);

  // A browser whose only cookie is the preview cookie (the common first request).
  const only = await fetch(`${link.origin}/`, { headers: { cookie } });
  assert.equal(only.status, 200);
  assert.equal(await only.text(), `secure app host=localhost:${appPort} cookie=`);

  const s = connect(Number(link.port), "127.0.0.1");
  await new Promise((r) => s.on("connect", r));
  s.write(
    `GET /hmr HTTP/1.1\r\nHost: ${link.host}\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nCookie: ${cookie}\r\n\r\n`,
  );
  let buf = "";
  s.on("data", (d) => {
    buf += d;
  });
  await new Promise((r) => setTimeout(r, 300));
  s.write("ping");
  await new Promise((r) => setTimeout(r, 300));
  s.destroy();
  assert.match(buf, /^HTTP\/1\.1 101/);
  assert.match(buf, /echo:ping/);
  delete process.env.WORKBENCH_PREVIEW_HOST;
});
