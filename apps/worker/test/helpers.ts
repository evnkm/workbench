import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { uuidv7 } from "@workbench/contracts";
import { createLogger, Database, loadConfig } from "@workbench/db";
import { WorkerContext } from "../src/context.ts";

export function tempDir(prefix = "wb-test-") {
  return mkdtempSync(join(tmpdir(), prefix));
}

/** A small Git repository with one commit on `main`. */
export function makeRepo(root = tempDir()): string {
  const repo = join(root, "repo");
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) => execFileSync("git", ["-C", repo, ...args], { stdio: "pipe" });
  git("init", "-q", "-b", "main");
  writeFileSync(join(repo, "README.md"), "# test\n");
  git("add", "-A");
  git("-c", "user.email=t@t", "-c", "user.name=t", "commit", "-qm", "init");
  return repo;
}

export function makeContext(env: Record<string, string> = {}) {
  const state = tempDir("wb-state-");
  const config = loadConfig({
    WORKBENCH_STATE_DIR: state,
    WORKBENCH_CODEX_BIN: join(import.meta.dirname, "fake-codex.mjs"),
    WORKBENCH_TMUX_SOCKET: `wb-test-${process.pid}`,
    ...env,
  } as NodeJS.ProcessEnv);
  for (const d of [config.reposDir, config.worktreesDir, config.runsDir]) mkdirSync(d, { recursive: true });
  const db = new Database(config.dbPath);
  db.migrate();
  const log = createLogger("test", "error");
  return new WorkerContext(config, db, log, uuidv7());
}

export async function waitFor<T>(fn: () => T | undefined | null | false, timeoutMs = 5000): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > deadline) throw new Error("waitFor timed out");
    await new Promise((r) => setTimeout(r, 20));
  }
}
