import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { after, test } from "node:test";
import { getProcess, getWorkspace } from "@workbench/db";
import { Processes, portFree } from "../src/processes.ts";
import { Workspaces } from "../src/workspaces.ts";
import { makeContext, makeRepo } from "./helpers.ts";

const sockets: string[] = [];
after(() => {
  for (const s of sockets) {
    try {
      execFileSync("tmux", ["-L", s, "kill-server"], { stdio: "ignore" });
    } catch {}
  }
});

async function setup(devCommand: string) {
  const ctx = makeContext({
    WORKBENCH_TMUX_SOCKET: `wb-test-${process.pid}-${sockets.length}`,
    WORKBENCH_PORT_RANGE: "47000-47999",
  });
  sockets.push(ctx.config.tmuxSocket);
  const repo = makeRepo();
  writeFileSync(
    join(repo, "workbench.json"),
    JSON.stringify({ dev: { command: devCommand, port: "PORT" }, ports: ["PORT", "OTHER"] }),
  );
  execFileSync("git", ["-C", repo, "add", "-A"]);
  execFileSync("git", ["-C", repo, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "cfg"]);
  const ws = new Workspaces(ctx);
  const procs = new Processes(ctx);
  ws.addArchiveGuard(procs.archiveBlocker);
  const { projectId } = await ws.registerProject({ path: repo });
  const { workspaceId } = await ws.createWorkspace({ projectId, name: "P" });
  return { ctx, ws, procs, workspace: getWorkspace(ctx.db, workspaceId)! };
}

test("a shell gets the workspace's port environment and is recorded when it exits", async () => {
  const { ctx, procs, workspace } = await setup("true");
  const { processId } = await procs.createShell(workspace.id);
  const p = getProcess(ctx.db, processId)!;
  execFileSync("tmux", [
    "-L",
    ctx.config.tmuxSocket,
    "send-keys",
    "-t",
    p.tmuxSession,
    `echo port=$PORT other=$OTHER; exit 3`,
    "Enter",
  ]);
  for (let i = 0; i < 100 && getProcess(ctx.db, processId)!.state === "running"; i++) {
    await procs.reconcile();
    await new Promise((r) => setTimeout(r, 50));
  }
  const done = getProcess(ctx.db, processId)!;
  assert.equal(done.state, "failed");
  assert.equal(done.exitCode, 3);
  assert.equal(workspace.portBase, 47000);
});

test("app start validates the reserved ports and reports an occupied one", async () => {
  const { ctx, procs, workspace } = await setup("sleep 30");
  const blocker = createServer().listen(workspace.portBase! + 1, "127.0.0.1");
  await new Promise((r) => blocker.once("listening", r));
  try {
    await assert.rejects(procs.startApp(workspace.id), /Port 47001 \(OTHER\) is already in use/);
  } finally {
    blocker.close();
  }
  const { processId, port } = await procs.startApp(workspace.id);
  assert.equal(port, 47000);
  await assert.rejects(procs.startApp(workspace.id), /already running/);
  await procs.stop(processId, "app");
  assert.equal(getProcess(ctx.db, processId)!.state, "exited");
});

test("archive is refused while a shell or app is running", async () => {
  const { ws, procs, workspace } = await setup("sleep 30");
  const { processId } = await procs.createShell(workspace.id);
  await assert.rejects(ws.archive(workspace.id), /Stop its running shell/);
  await procs.stop(processId, "shell");
  await ws.archive(workspace.id);
});

test("port probing detects listeners", async () => {
  const srv = createServer().listen(0, "127.0.0.1");
  await new Promise((r) => srv.once("listening", r));
  const port = (srv.address() as { port: number }).port;
  assert.equal(await portFree(port), false);
  srv.close();
  await new Promise((r) => setTimeout(r, 50));
  assert.equal(await portFree(port), true);
});

test("shells lost with the tmux server (for example after a reboot) are recorded as exited", async () => {
  const { ctx, procs, workspace } = await setup("true");
  const { processId } = await procs.createShell(workspace.id);
  execFileSync("tmux", ["-L", ctx.config.tmuxSocket, "kill-server"]);
  await procs.tmux.ensureServer(); // a fresh, empty server, as after a reboot
  await procs.reconcile();
  assert.equal(getProcess(ctx.db, processId)!.state, "exited");
});
