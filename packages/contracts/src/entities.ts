// Durable entities as returned by the API and carried in events. Timestamps
// are ISO 8601 strings in UTC.
import type {
  ApprovalPolicy,
  CommandState,
  PendingInputState,
  ProcessState,
  Provider,
  RunState,
  WorkspaceState,
} from "./states.ts";

export type Project = {
  id: string;
  name: string;
  repoPath: string;
  defaultBranch: string;
  setupCommand: string | null;
  /** Development server command; overrides workbench.json `dev.command`. */
  runCommand: string | null;
  createdAt: string;
  updatedAt: string;
};

export type Workspace = {
  id: string;
  projectId: string;
  name: string;
  branch: string;
  baseRef: string;
  worktreePath: string;
  state: WorkspaceState;
  /** Human-readable reason for create_failed or setup_failed. */
  error: string | null;
  setupExitCode: number | null;
  /** Ports reserved for this workspace's application processes. */
  portBase: number | null;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
};

export type Conversation = {
  id: string;
  workspaceId: string;
  provider: Provider;
  providerThreadId: string | null;
  title: string;
  model: string | null;
  approvalPolicy: ApprovalPolicy;
  createdAt: string;
  updatedAt: string;
  lastActivityAt: string;
};

export type RunKind = "agent_turn" | "workspace_setup" | "job";

export type Run = {
  id: string;
  kind: RunKind;
  workspaceId: string | null;
  conversationId: string | null;
  jobId: string | null;
  state: RunState;
  /** Provider turn identifier for agent turns. */
  providerTurnId: string | null;
  /** Short description such as the first line of the prompt. */
  summary: string;
  stopReason: string | null;
  error: string | null;
  attempt: number;
  createdAt: string;
  startedAt: string | null;
  endedAt: string | null;
};

export type ItemKind =
  | "user_message"
  | "agent_message"
  | "reasoning"
  | "command"
  | "file_change"
  | "tool_call"
  | "plan"
  | "web_search"
  | "image"
  | "notice"
  | "other";

export type ItemStatus = "in_progress" | "completed" | "failed" | "declined" | null;

export type FileChange = { path: string; kind: "add" | "delete" | "update"; movePath: string | null; diff: string };

export type ConversationImage = {
  source: string;
  alt: string;
  /** Content-addressed file in Workbench's retained media directory. */
  mediaId?: string;
  error?: string;
};

/** Kind-specific item payload. Fields are optional because providers differ. */
export type ItemData = {
  images?: ConversationImage[];
  text?: string;
  /** agent_message phase, for example commentary or final_answer. */
  phase?: string | null;
  command?: string;
  cwd?: string;
  output?: string;
  outputTruncated?: boolean;
  exitCode?: number | null;
  durationMs?: number | null;
  changes?: FileChange[];
  tool?: string;
  server?: string | null;
  arguments?: unknown;
  result?: unknown;
  error?: string | null;
  query?: string;
  /** Provider item type when kind is "other". */
  providerType?: string;
};

export type ConversationItem = {
  id: string;
  conversationId: string;
  runId: string | null;
  providerItemId: string | null;
  kind: ItemKind;
  status: ItemStatus;
  data: ItemData;
  /** Event sequence at creation; stable display order. */
  position: number;
  createdAt: string;
  updatedAt: string;
};

export type InputKind = "command_approval" | "file_approval" | "question" | "permissions" | "elicitation";

export type InputQuestion = {
  id: string;
  header: string;
  question: string;
  options: { label: string; description: string }[] | null;
  allowOther: boolean;
  secret: boolean;
};

export type InputRequest = {
  title: string;
  command?: string | null;
  cwd?: string | null;
  reason?: string | null;
  questions?: InputQuestion[];
  /** Decisions the provider offers, in display order. */
  decisions?: { id: string; label: string }[];
};

export type InputResponse =
  | { kind: "decision"; decision: string }
  | { kind: "answers"; answers: Record<string, string[]> };

export type PendingInput = {
  id: string;
  conversationId: string;
  runId: string;
  kind: InputKind;
  state: PendingInputState;
  request: InputRequest;
  response: InputResponse | null;
  createdAt: string;
  resolvedAt: string | null;
};

export type Command = {
  id: string;
  idempotencyKey: string;
  type: string;
  payload: unknown;
  state: CommandState;
  result: unknown;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
};

export type ProcessSession = {
  id: string;
  workspaceId: string;
  kind: "shell" | "app";
  name: string;
  command: string | null;
  cwd: string;
  tmuxSession: string;
  state: ProcessState;
  exitCode: number | null;
  port: number | null;
  createdAt: string;
  updatedAt: string;
  endedAt: string | null;
};

export type WorkerStatus = {
  instanceId: string;
  pid: number;
  startedAt: string;
  heartbeatAt: string;
  codex: { state: "starting" | "ready" | "unavailable"; version: string | null; error: string | null };
  claude: { state: "unavailable"; reason: string };
  health: WorkerHealth;
};

export type WorkerHealth = {
  diskFreeBytes: number;
  diskTotalBytes: number;
  memFreeBytes: number;
  memTotalBytes: number;
  rssBytes: number;
  /** 99th percentile event-loop delay over the last interval, in ms. */
  eventLoopP99Ms: number;
  /** Age of the oldest queued job run, in seconds. */
  oldestQueuedJobSeconds: number | null;
  activeJobs: number;
  codexRestarts: number;
  /** Human-readable problems the app should surface. */
  warnings: string[];
};
