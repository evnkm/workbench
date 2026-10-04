import { createHash } from "node:crypto";
import type { FileDiff, FileStatus, GitStatus } from "@workbench/contracts";
import { exec, execOk } from "./exec.ts";

const git = (cwd: string, args: string[], timeoutMs = 60_000) => exec("git", ["-C", cwd, ...args], { timeoutMs });
const gitOk = (cwd: string, args: string[], timeoutMs = 60_000) => execOk("git", ["-C", cwd, ...args], { timeoutMs });

export async function repoToplevel(path: string): Promise<string | null> {
  const r = await git(path, ["rev-parse", "--show-toplevel"]);
  return r.code === 0 ? r.stdout.trim() : null;
}

/** True when `path` is a linked worktree rather than a main checkout. */
export async function isLinkedWorktree(path: string): Promise<boolean> {
  const common = (await gitOk(path, ["rev-parse", "--path-format=absolute", "--git-common-dir"])).trim();
  const own = (await gitOk(path, ["rev-parse", "--path-format=absolute", "--git-dir"])).trim();
  return common !== own;
}

export async function refExists(repo: string, ref: string): Promise<boolean> {
  return (await git(repo, ["rev-parse", "--verify", "--quiet", `${ref}^{commit}`])).code === 0;
}

export async function branchExists(repo: string, branch: string): Promise<boolean> {
  return (await git(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`])).code === 0;
}

export async function validBranchName(repo: string, branch: string): Promise<boolean> {
  return (await git(repo, ["check-ref-format", "--branch", branch])).code === 0;
}

/**
 * Discover the default base branch: origin's HEAD if known, otherwise a
 * single local `main` or `master`. Returns null when ambiguous.
 */
export async function discoverDefaultBranch(repo: string): Promise<string | null> {
  const head = await git(repo, ["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"]);
  if (head.code === 0) {
    const name = head.stdout.trim().replace(/^origin\//, "");
    if (name && (await branchExists(repo, name))) return name;
  }
  const candidates = [];
  for (const b of ["main", "master"]) if (await branchExists(repo, b)) candidates.push(b);
  return candidates.length === 1 ? candidates[0]! : null;
}

export type WorktreeEntry = { path: string; branch: string | null; head: string | null };

export async function listWorktrees(repo: string): Promise<WorktreeEntry[]> {
  const out = await gitOk(repo, ["worktree", "list", "--porcelain"]);
  const entries: WorktreeEntry[] = [];
  let cur: WorktreeEntry | null = null;
  for (const line of out.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), branch: null, head: null };
      entries.push(cur);
    } else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5);
  }
  return entries;
}

export async function addWorktree(repo: string, path: string, branch: string, baseRef: string, createBranch: boolean) {
  const args = createBranch ? ["worktree", "add", "-b", branch, path, baseRef] : ["worktree", "add", path, branch];
  await gitOk(repo, args, 300_000);
}

export async function removeWorktree(repo: string, path: string) {
  await gitOk(repo, ["worktree", "remove", "--force", path]);
}

export async function deleteBranchIfUnchanged(repo: string, branch: string, baseRef: string): Promise<boolean> {
  const tip = await git(repo, ["rev-parse", `refs/heads/${branch}`]);
  const base = await git(repo, ["rev-parse", `${baseRef}^{commit}`]);
  if (tip.code !== 0 || base.code !== 0 || tip.stdout.trim() !== base.stdout.trim()) return false;
  return (await git(repo, ["branch", "-D", branch])).code === 0;
}

export async function pruneWorktrees(repo: string) {
  await git(repo, ["worktree", "prune"]);
}

// ---------------------------------------------------------------- status and diffs

export async function status(cwd: string, baseRef: string | null): Promise<GitStatus> {
  const out = await gitOk(cwd, ["status", "--porcelain=v2", "--branch", "-z", "--untracked-files=all"]);
  const st: GitStatus = { branch: null, head: null, upstream: null, ahead: 0, behind: 0, files: [], version: "" };
  const parts = out.split("\0");
  for (let i = 0; i < parts.length; i++) {
    const p = parts[i]!;
    if (p.startsWith("# branch.oid ")) st.head = p.slice(13);
    else if (p.startsWith("# branch.head ")) st.branch = p.slice(14) === "(detached)" ? null : p.slice(14);
    else if (p.startsWith("# branch.upstream ")) st.upstream = p.slice(18);
    else if (p.startsWith("# branch.ab ")) {
      const m = /\+(\d+) -(\d+)/.exec(p);
      if (m) [st.ahead, st.behind] = [Number(m[1]), Number(m[2])];
    } else if (p.startsWith("1 ")) {
      const f = p.split(" ");
      st.files.push(fileStatus(f.slice(8).join(" "), null, f[1]!));
    } else if (p.startsWith("2 ")) {
      const f = p.split(" ");
      st.files.push(fileStatus(f.slice(9).join(" "), parts[++i] ?? null, f[1]!));
    } else if (p.startsWith("u ")) {
      const f = p.split(" ");
      st.files.push(fileStatus(f.slice(10).join(" "), null, "UU"));
    } else if (p.startsWith("? ")) {
      st.files.push({ ...fileStatus(p.slice(2), null, ".?"), untracked: true });
    }
  }
  // Line counts against HEAD for tracked files; binary files report "-".
  const numstat = await git(cwd, ["diff", "HEAD", "--numstat", "-z", "--no-renames"]);
  if (numstat.code === 0) {
    const counts = new Map<string, [number | null, number | null]>();
    for (const rec of numstat.stdout.split("\0")) {
      const m = /^(-|\d+)\t(-|\d+)\t(.*)$/s.exec(rec);
      if (m) counts.set(m[3]!, [m[1] === "-" ? null : Number(m[1]), m[2] === "-" ? null : Number(m[2])]);
    }
    for (const f of st.files) {
      const c = counts.get(f.path);
      if (c) {
        [f.additions, f.deletions] = c;
        f.binary = c[0] === null;
      }
    }
  }
  st.version = createHash("sha256")
    .update(out)
    .update(numstat.stdout)
    .update(baseRef ?? "")
    .digest("hex")
    .slice(0, 16);
  return st;
}

function fileStatus(path: string, origPath: string | null, xy: string): FileStatus {
  return {
    path,
    origPath,
    staged: xy[0] ?? ".",
    unstaged: xy[1] ?? ".",
    untracked: false,
    binary: false,
    additions: null,
    deletions: null,
  };
}

/**
 * Unified diff of one file against HEAD (staged and unstaged together), or
 * the full content for an untracked file. Bounded to `maxBytes`.
 */
export async function fileDiff(cwd: string, path: string, untracked: boolean, maxBytes: number): Promise<FileDiff> {
  const r = untracked
    ? await git(cwd, ["diff", "--no-index", "--no-color", "--", "/dev/null", path])
    : await git(cwd, ["diff", "HEAD", "--no-color", "--find-renames", "--", path]);
  const diff = r.stdout;
  const binary = /^Binary files /m.test(diff);
  const bytes = Buffer.byteLength(diff);
  if (bytes > maxBytes) {
    return { path, diff: diff.slice(0, maxBytes), truncated: true, binary, bytes };
  }
  return { path, diff, truncated: false, binary, bytes };
}
