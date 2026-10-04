import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { getWorkspace, listWorkspaces } from "@workbench/db";
import { Workspaces } from "../src/workspaces.ts";
import { makeContext, makeRepo, waitFor } from "./helpers.ts";

function setup() {
  const ctx = makeContext();
  const ws = new Workspaces(ctx);
  return { ctx, ws, repo: makeRepo() };
}

test("two workspaces get independent branches and worktrees", async () => {
  const { ctx, ws, repo } = setup();
  const { projectId } = await ws.registerProject({ path: repo });
  const a = await ws.createWorkspace({ projectId, name: "Feature A" });
  const b = await ws.createWorkspace({ projectId, name: "Feature B" });
  const wa = getWorkspace(ctx.db, a.workspaceId)!;
  const wb = getWorkspace(ctx.db, b.workspaceId)!;
  assert.equal(wa.state, "ready");
  assert.notEqual(wa.worktreePath, wb.worktreePath);
  assert.equal(wa.branch, "feature-a");
  const head = (p: string) => execFileSync("git", ["-C", p, "branch", "--show-current"], { encoding: "utf8" }).trim();
  assert.equal(head(wa.worktreePath), "feature-a");
  assert.equal(head(wb.worktreePath), "feature-b");
  writeFileSync(join(wa.worktreePath, "only-a.txt"), "a");
  assert.equal(existsSync(join(wb.worktreePath, "only-a.txt")), false);
  assert.notEqual(wa.portBase, wb.portBase);
});

test("registering the same repository twice returns the existing project", async () => {
  const { ws, repo } = setup();
  const a = await ws.registerProject({ path: repo });
  const b = await ws.registerProject({ path: join(repo, ".") });
  assert.equal(b.projectId, a.projectId);
  assert.equal(b.existing, true);
});

test("an existing branch name is rejected without creating anything", async () => {
  const { ctx, ws, repo } = setup();
  const { projectId } = await ws.registerProject({ path: repo });
  await ws.createWorkspace({ projectId, name: "x", branch: "dup" });
  await assert.rejects(ws.createWorkspace({ projectId, name: "y", branch: "dup" }), /already uses branch dup/);
  assert.equal(listWorkspaces(ctx.db).length, 1);
});

test("ambiguous default branches require an explicit choice", async () => {
  const { ws, repo } = setup();
  execFileSync("git", ["-C", repo, "branch", "master"]);
  await assert.rejects(ws.registerProject({ path: repo }), /Could not determine the default branch/);
  const r = await ws.registerProject({ path: repo, defaultBranch: "master" });
  assert.ok(r.projectId);
});

test("setup failure is visible and retry keeps the workspace identity", async () => {
  const { ctx, ws, repo } = setup();
  const marker = join(repo, "..", "allow-setup");
  const { projectId } = await ws.registerProject({ path: repo, setupCommand: `echo setting up; test -f ${marker}` });
  const { workspaceId } = await ws.createWorkspace({ projectId, name: "Setup" });
  const failed = await waitFor(() => {
    const w = getWorkspace(ctx.db, workspaceId)!;
    return w.state === "setup_failed" ? w : null;
  });
  assert.equal(failed.setupExitCode, 1);
  const run = ctx.db.get<{ id: string }>("SELECT id FROM runs WHERE workspace_id = :w", { w: workspaceId })!;
  assert.match(readFileSync(join(ctx.config.runsDir, run.id, "output.log"), "utf8"), /setting up/);
  writeFileSync(marker, "");
  await ws.retry(workspaceId);
  const ready = await waitFor(() => {
    const w = getWorkspace(ctx.db, workspaceId)!;
    return w.state === "ready" ? w : null;
  });
  assert.equal(ready.id, workspaceId);
  assert.equal(ready.worktreePath, failed.worktreePath);
});

test("a failed worktree creation can be retried", async () => {
  const { ctx, ws, repo } = setup();
  const { projectId } = await ws.registerProject({ path: repo });
  const { workspaceId } = await ws.createWorkspace({ projectId, name: "Retry" });
  const w = getWorkspace(ctx.db, workspaceId)!;
  // Simulate a partial failure: the worktree vanished and the row says create_failed.
  execFileSync("git", ["-C", repo, "worktree", "remove", "--force", w.worktreePath]);
  ctx.db.run("UPDATE workspaces SET state = 'create_failed' WHERE id = :id", { id: workspaceId });
  await ws.retry(workspaceId);
  assert.equal(getWorkspace(ctx.db, workspaceId)!.state, "ready");
  assert.ok(existsSync(w.worktreePath));
});

test("archive and restore preserve tracked and untracked changes", async () => {
  const { ctx, ws, repo } = setup();
  const { projectId } = await ws.registerProject({ path: repo });
  const { workspaceId } = await ws.createWorkspace({ projectId, name: "Dirty" });
  const w = getWorkspace(ctx.db, workspaceId)!;
  writeFileSync(join(w.worktreePath, "README.md"), "# edited\n");
  writeFileSync(join(w.worktreePath, "untracked.txt"), "keep me");
  await ws.archive(workspaceId);
  const archived = getWorkspace(ctx.db, workspaceId)!;
  assert.equal(archived.state, "archived");
  assert.equal(archived.portBase, null);
  assert.equal(readFileSync(join(w.worktreePath, "README.md"), "utf8"), "# edited\n");
  await ws.restore(workspaceId);
  const restored = getWorkspace(ctx.db, workspaceId)!;
  assert.equal(restored.state, "ready");
  assert.equal(readFileSync(join(w.worktreePath, "untracked.txt"), "utf8"), "keep me");
  assert.equal(readFileSync(join(w.worktreePath, "README.md"), "utf8"), "# edited\n");
});

test("new port blocks never overlap blocks allocated earlier, even with a different block size", async () => {
  const { ctx, ws, repo } = setup();
  const { projectId } = await ws.registerProject({ path: repo });
  const a = await ws.createWorkspace({ projectId, name: "A" });
  // Simulate a block allocated under an older, smaller block size in the middle of the range.
  ctx.db.run("UPDATE workspaces SET port_base = 10250 WHERE id = :id", { id: a.workspaceId });
  const b = await ws.createWorkspace({ projectId, name: "B" });
  const c = await ws.createWorkspace({ projectId, name: "C" });
  const bases = [b, c].map((x) => getWorkspace(ctx.db, x.workspaceId)!.portBase!);
  assert.deepEqual(bases, [10000, 10600]);
});
