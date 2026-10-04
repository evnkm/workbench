// Git working-tree status and diffs as served to the browser.

export type FileStatus = {
  path: string;
  origPath: string | null;
  /** Index (staged) status letter, or "." when unchanged. */
  staged: string;
  /** Worktree (unstaged) status letter, or "." when unchanged. */
  unstaged: string;
  untracked: boolean;
  binary: boolean;
  additions: number | null;
  deletions: number | null;
};

export type GitStatus = {
  branch: string | null;
  head: string | null;
  upstream: string | null;
  ahead: number;
  behind: number;
  files: FileStatus[];
  /** Hash of the status output, so clients can tell whether a diff is current. */
  version: string;
};

export type FileDiff = { path: string; diff: string; truncated: boolean; binary: boolean; bytes: number };
