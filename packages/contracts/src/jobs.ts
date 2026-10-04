// Background jobs, schedules, and artifacts.

export type JobSchedule = {
  cron: string;
  timezone: string;
  /** What to do when an occurrence is due while a previous run is active. */
  overlap: "skip" | "queue";
};

export type Job = {
  id: string;
  name: string;
  kind: "shell" | "codex";
  /** Shell command line, or the prompt for an agent job. */
  command: string;
  projectId: string | null;
  workspaceId: string | null;
  /** "workspace" runs in the workspace directory; "worktree" creates a disposable worktree. */
  isolation: "workspace" | "worktree";
  timeoutSeconds: number;
  maxAttempts: number;
  /** Retry automatically even when a previous attempt's outcome is unknown. */
  retryUnknownOutcome: boolean;
  schedule: JobSchedule | null;
  paused: boolean;
  nextRunAt: string | null;
  createdAt: string;
  updatedAt: string;
};

export type JobRunDetail = {
  runId: string;
  jobId: string;
  /** Scheduled occurrence time, or null for manual launches. */
  occurrenceAt: string | null;
  trigger: "manual" | "schedule" | "retry";
  exitCode: number | null;
  logPath: string | null;
  logBytes: number;
  finalMessage: string | null;
  unread: boolean;
};

export type Artifact = {
  id: string;
  runId: string;
  name: string;
  path: string;
  bytes: number;
  pinned: boolean;
  createdAt: string;
};
