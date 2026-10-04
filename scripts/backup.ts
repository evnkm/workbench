// Consistent backup of Workbench state. Safe to run while services are up.
//
// Contents of <backupDir>/<timestamp>/:
//   workbench.sqlite      VACUUM INTO copy of the application database
//   codex/                Codex provider state needed to resume threads:
//                         its SQLite databases (VACUUM INTO) and session files
//   worktrees/<id>.patch  uncommitted tracked changes per workspace (binary diff)
//   worktrees/<id>.tar    untracked, non-ignored files per workspace
//   manifest.json         what was captured, with sizes and Git HEADs
//
// Credentials (~/.codex/auth.json, ~/.config/workbench/env) are excluded on
// purpose: re-authenticate after a restore. Run logs are excluded by default
// (pass --with-runs to include them).
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { Database, listWorkspaces, loadConfig } from "@workbench/db";

const config = loadConfig();
const keep = Number(process.env.WORKBENCH_BACKUP_KEEP ?? 7);
const withRuns = process.argv.includes("--with-runs");
const stamp = new Date().toISOString().replace(/[:.]/g, "-");
if (!existsSync(config.dbPath)) {
  console.log(`No database at ${config.dbPath} yet; nothing to back up.`);
  process.exit(0);
}

const out = join(config.backupsDir, stamp);
mkdirSync(join(out, "worktrees"), { recursive: true });
const manifest: Record<string, unknown> = { createdAt: new Date().toISOString(), stateDir: config.stateDir };

// 1. Application database.
const db = new Database(config.dbPath);
db.backupTo(join(out, "workbench.sqlite"));
manifest.schemaVersion = db.get<{ user_version: number }>("PRAGMA user_version")!.user_version;

// 2. Codex provider state.
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const codexOut = join(out, "codex");
mkdirSync(codexOut, { recursive: true });
const codexFiles: string[] = [];
if (existsSync(codexHome)) {
  for (const name of readdirSync(codexHome)) {
    if (name.endsWith(".sqlite")) {
      const src = new DatabaseSync(join(codexHome, name), { readOnly: true });
      src.prepare("VACUUM INTO ?").run(join(codexOut, name));
      src.close();
      codexFiles.push(name);
    }
  }
  for (const dir of ["sessions", "archived_sessions"]) {
    if (existsSync(join(codexHome, dir))) {
      cpSync(join(codexHome, dir), join(codexOut, dir), { recursive: true });
      codexFiles.push(`${dir}/`);
    }
  }
  for (const f of ["session_index.jsonl", "config.toml"]) {
    if (existsSync(join(codexHome, f))) {
      cpSync(join(codexHome, f), join(codexOut, f));
      codexFiles.push(f);
    }
  }
}
manifest.codex = codexFiles;

// 3. Uncommitted work in every non-archived and archived worktree.
const worktrees: unknown[] = [];
for (const w of listWorkspaces(db)) {
  if (!existsSync(w.worktreePath)) {
    worktrees.push({ id: w.id, path: w.worktreePath, missing: true });
    continue;
  }
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", w.worktreePath, ...args], { maxBuffer: 512 * 1024 * 1024 });
  const head = git("rev-parse", "HEAD").toString().trim();
  const patch = git("diff", "HEAD", "--binary");
  writeFileSync(join(out, "worktrees", `${w.id}.patch`), patch);
  const untracked = git("ls-files", "--others", "--exclude-standard", "-z").toString().split("\0").filter(Boolean);
  if (untracked.length) {
    execFileSync("tar", ["-cf", join(out, "worktrees", `${w.id}.tar`), "--null", "-T", "-"], {
      cwd: w.worktreePath,
      input: untracked.join("\0"),
    });
  }
  worktrees.push({
    id: w.id,
    name: w.name,
    branch: w.branch,
    path: w.worktreePath,
    head,
    patchBytes: patch.length,
    untracked: untracked.length,
  });
}
manifest.worktrees = worktrees;
db.close();

// 4. Optional run logs and artifacts.
if (withRuns && existsSync(config.runsDir)) cpSync(config.runsDir, join(out, "runs"), { recursive: true });
manifest.runsIncluded = withRuns;

writeFileSync(join(out, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`);

// 5. Retention.
const all = readdirSync(config.backupsDir)
  .filter((d) => statSync(join(config.backupsDir, d)).isDirectory())
  .sort();
for (const old of all.slice(0, Math.max(0, all.length - keep)))
  rmSync(join(config.backupsDir, old), { recursive: true });

console.log(`Backup written to ${out}`);
