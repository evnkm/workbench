// Restore a backup made by scripts/backup.ts into a state directory.
//
//   node scripts/restore.ts <backupDir> <targetStateDir> [--codex-home DIR] [--worktrees]
//
// Refuses to write into a directory that already holds a database, so it
// cannot overwrite live state by accident. Stop the services and move the old
// state aside before restoring over the production path.
//
// --worktrees recreates each workspace worktree from its branch (which must
// exist in the project repository) and reapplies the saved patch and
// untracked files. --codex-home restores Codex databases and sessions there.
import { execFileSync } from "node:child_process";
import { cpSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { Database, getProject, listWorkspaces } from "@workbench/db";

const [src, target] = process.argv.slice(2);
const flag = (name: string) => {
  const i = process.argv.indexOf(name);
  return i > 0 ? (process.argv[i + 1] ?? "") : null;
};
if (!src || !target) {
  console.error("usage: node scripts/restore.ts <backupDir> <targetStateDir> [--codex-home DIR] [--worktrees]");
  process.exit(2);
}
const manifest = JSON.parse(readFileSync(join(src, "manifest.json"), "utf8")) as {
  worktrees: { id: string; path: string; head?: string; missing?: boolean }[];
  stateDir: string;
};
const dbTarget = join(target, "workbench.sqlite");
if (existsSync(dbTarget)) {
  console.error(`${dbTarget} already exists; refusing to overwrite.`);
  process.exit(1);
}
mkdirSync(target, { recursive: true });
cpSync(join(src, "workbench.sqlite"), dbTarget);
if (existsSync(join(src, "media"))) cpSync(join(src, "media"), join(target, "media"), { recursive: true });
const db = new Database(dbTarget);
console.log(`Database restored (schema ${db.migrate()}).`);

const codexHome = flag("--codex-home");
if (codexHome) {
  mkdirSync(codexHome, { recursive: true });
  for (const name of readdirSync(join(src, "codex"))) {
    const dest = join(codexHome, name);
    if (existsSync(dest) && !name.endsWith("sessions")) {
      console.log(`  codex: keeping existing ${name}`);
      continue;
    }
    cpSync(join(src, "codex", name), dest, { recursive: true });
  }
  console.log(`Codex state restored to ${codexHome}. Run \`codex login\` if credentials are missing.`);
}

if (process.argv.includes("--worktrees")) {
  // Worktree paths are rewritten under the new state directory.
  for (const w of listWorkspaces(db)) {
    const project = getProject(db, w.projectId);
    const saved = manifest.worktrees.find((x) => x.id === w.id);
    if (!project || !saved || saved.missing) {
      console.log(`  ${w.name}: skipped (no saved worktree)`);
      continue;
    }
    const path = w.worktreePath.startsWith(manifest.stateDir)
      ? join(target, w.worktreePath.slice(manifest.stateDir.length))
      : w.worktreePath;
    if (existsSync(path)) {
      console.log(`  ${w.name}: ${path} exists; leaving it alone`);
      continue;
    }
    try {
      execFileSync("git", ["-C", project.repoPath, "worktree", "add", path, w.branch], { stdio: "pipe" });
    } catch (e) {
      console.log(`  ${w.name}: could not add worktree for ${w.branch}: ${(e as Error).message.split("\n")[0]}`);
      continue;
    }
    const patch = join(src, "worktrees", `${w.id}.patch`);
    if (readFileSync(patch).length) execFileSync("git", ["-C", path, "apply", "--binary", patch]);
    const tar = join(src, "worktrees", `${w.id}.tar`);
    if (existsSync(tar)) execFileSync("tar", ["-xf", tar, "-C", path]);
    db.run("UPDATE workspaces SET worktree_path = :p WHERE id = :id", { p: path, id: w.id });
    console.log(`  ${w.name}: restored at ${path}`);
  }
}
db.close();
console.log(`Restore complete in ${target}.`);
