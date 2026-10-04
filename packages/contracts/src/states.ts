// Lifecycle states shared by the database, worker, server, and browser.

export const RUN_STATES = [
  "queued",
  "starting",
  "running",
  "waiting_for_input",
  "stopping",
  "succeeded",
  "failed",
  "cancelled",
  "interrupted",
] as const;
export type RunState = (typeof RUN_STATES)[number];

export const TERMINAL_RUN_STATES: readonly RunState[] = ["succeeded", "failed", "cancelled", "interrupted"];
export const isTerminalRunState = (s: RunState) => TERMINAL_RUN_STATES.includes(s);

export const WORKSPACE_STATES = [
  "creating",
  "create_failed",
  "setting_up",
  "setup_failed",
  "ready",
  "archived",
] as const;
export type WorkspaceState = (typeof WORKSPACE_STATES)[number];

export const COMMAND_STATES = ["accepted", "claimed", "succeeded", "failed"] as const;
export type CommandState = (typeof COMMAND_STATES)[number];

export const PENDING_INPUT_STATES = ["open", "answered", "cancelled"] as const;
export type PendingInputState = (typeof PENDING_INPUT_STATES)[number];

export const PROVIDERS = ["codex", "claude"] as const;
export type Provider = (typeof PROVIDERS)[number];

export const APPROVAL_POLICIES = ["never", "untrusted", "on-request"] as const;
export type ApprovalPolicy = (typeof APPROVAL_POLICIES)[number];

export const PROCESS_STATES = ["starting", "running", "exited", "failed"] as const;
export type ProcessState = (typeof PROCESS_STATES)[number];
