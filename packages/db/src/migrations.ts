// Versioned schema migrations. Append new entries; never edit an applied one.
// `PRAGMA user_version` records the highest applied version.

export const migrations: { version: number; name: string; sql: string }[] = [
  {
    version: 1,
    name: "initial",
    sql: `
CREATE TABLE projects (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  repo_path TEXT NOT NULL UNIQUE,
  default_branch TEXT NOT NULL,
  setup_command TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE workspaces (
  id TEXT PRIMARY KEY,
  project_id TEXT NOT NULL REFERENCES projects(id),
  name TEXT NOT NULL,
  branch TEXT NOT NULL,
  base_ref TEXT NOT NULL,
  worktree_path TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('creating','create_failed','setting_up','setup_failed','ready','archived')),
  error TEXT,
  setup_exit_code INTEGER,
  port_base INTEGER UNIQUE,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  archived_at TEXT,
  UNIQUE (project_id, branch)
);

CREATE TABLE conversations (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  provider TEXT NOT NULL CHECK (provider IN ('codex','claude')),
  provider_thread_id TEXT UNIQUE,
  title TEXT NOT NULL,
  model TEXT,
  approval_policy TEXT NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  last_activity_at TEXT NOT NULL
);
CREATE INDEX conversations_workspace ON conversations(workspace_id);

CREATE TABLE runs (
  id TEXT PRIMARY KEY,
  kind TEXT NOT NULL CHECK (kind IN ('agent_turn','workspace_setup','job')),
  workspace_id TEXT REFERENCES workspaces(id),
  conversation_id TEXT REFERENCES conversations(id),
  job_id TEXT,
  state TEXT NOT NULL CHECK (state IN ('queued','starting','running','waiting_for_input','stopping','succeeded','failed','cancelled','interrupted')),
  provider_turn_id TEXT,
  summary TEXT NOT NULL DEFAULT '',
  stop_reason TEXT,
  error TEXT,
  attempt INTEGER NOT NULL DEFAULT 1,
  owner TEXT,
  created_at TEXT NOT NULL,
  started_at TEXT,
  ended_at TEXT
);
CREATE INDEX runs_conversation ON runs(conversation_id, created_at);
CREATE INDEX runs_active ON runs(state) WHERE state NOT IN ('succeeded','failed','cancelled','interrupted');
-- One active agent turn per conversation, enforced by the database.
CREATE UNIQUE INDEX runs_one_active_turn ON runs(conversation_id)
  WHERE kind = 'agent_turn' AND state NOT IN ('succeeded','failed','cancelled','interrupted');

CREATE TABLE commands (
  id TEXT PRIMARY KEY,
  idempotency_key TEXT NOT NULL UNIQUE,
  type TEXT NOT NULL,
  payload TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('accepted','claimed','succeeded','failed')),
  result TEXT,
  error TEXT,
  claimed_by TEXT,
  created_at TEXT NOT NULL,
  claimed_at TEXT,
  finished_at TEXT
);
CREATE INDEX commands_accepted ON commands(created_at) WHERE state = 'accepted';

CREATE TABLE events (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL,
  conversation_id TEXT,
  detail INTEGER NOT NULL DEFAULT 0,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX events_conversation ON events(conversation_id, seq);

CREATE TABLE items (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  run_id TEXT REFERENCES runs(id),
  provider_item_id TEXT,
  kind TEXT NOT NULL,
  status TEXT,
  data TEXT NOT NULL,
  position INTEGER NOT NULL,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  UNIQUE (conversation_id, provider_item_id)
);
CREATE INDEX items_conversation_position ON items(conversation_id, position);

CREATE TABLE pending_inputs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  run_id TEXT NOT NULL REFERENCES runs(id),
  provider_request_id TEXT NOT NULL,
  kind TEXT NOT NULL,
  state TEXT NOT NULL CHECK (state IN ('open','answered','cancelled')),
  request TEXT NOT NULL,
  response TEXT,
  created_at TEXT NOT NULL,
  resolved_at TEXT
);
CREATE INDEX pending_inputs_open ON pending_inputs(conversation_id) WHERE state = 'open';

CREATE TABLE auth_sessions (
  token_hash TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  last_seen_at TEXT NOT NULL,
  user_agent TEXT
);

CREATE TABLE worker_status (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  body TEXT NOT NULL,
  heartbeat_at TEXT NOT NULL
);
`,
  },
  {
    version: 2,
    name: "process sessions",
    sql: `
CREATE TABLE process_sessions (
  id TEXT PRIMARY KEY,
  workspace_id TEXT NOT NULL REFERENCES workspaces(id),
  kind TEXT NOT NULL CHECK (kind IN ('shell','app')),
  name TEXT NOT NULL,
  command TEXT,
  cwd TEXT NOT NULL,
  tmux_session TEXT NOT NULL UNIQUE,
  state TEXT NOT NULL CHECK (state IN ('starting','running','exited','failed')),
  exit_code INTEGER,
  port INTEGER,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL,
  ended_at TEXT
);
CREATE INDEX process_sessions_workspace ON process_sessions(workspace_id);
`,
  },
  {
    version: 3,
    name: "jobs and schedules",
    sql: `
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  name TEXT NOT NULL,
  kind TEXT NOT NULL CHECK (kind IN ('shell','codex')),
  command TEXT NOT NULL,
  project_id TEXT REFERENCES projects(id),
  workspace_id TEXT REFERENCES workspaces(id),
  isolation TEXT NOT NULL CHECK (isolation IN ('workspace','worktree')),
  timeout_seconds INTEGER NOT NULL,
  max_attempts INTEGER NOT NULL,
  retry_unknown_outcome INTEGER NOT NULL DEFAULT 0,
  schedule_cron TEXT,
  schedule_timezone TEXT,
  schedule_overlap TEXT,
  paused INTEGER NOT NULL DEFAULT 0,
  next_run_at TEXT,
  deleted_at TEXT,
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE job_runs (
  run_id TEXT PRIMARY KEY REFERENCES runs(id),
  job_id TEXT NOT NULL REFERENCES jobs(id),
  occurrence_at TEXT,
  trigger TEXT NOT NULL CHECK (trigger IN ('manual','schedule','retry')),
  retry_of TEXT REFERENCES runs(id),
  exit_code INTEGER,
  pid INTEGER,
  pgid INTEGER,
  lease_expires_at TEXT,
  deadline_at TEXT,
  cancel_requested INTEGER NOT NULL DEFAULT 0,
  log_path TEXT,
  log_bytes INTEGER NOT NULL DEFAULT 0,
  worktree_path TEXT,
  final_message TEXT,
  unread INTEGER NOT NULL DEFAULT 1,
  -- A scheduled occurrence enqueues at most one run.
  UNIQUE (job_id, occurrence_at)
);
CREATE INDEX job_runs_job ON job_runs(job_id);

CREATE TABLE artifacts (
  id TEXT PRIMARY KEY,
  run_id TEXT NOT NULL REFERENCES runs(id),
  name TEXT NOT NULL,
  path TEXT NOT NULL,
  bytes INTEGER NOT NULL,
  pinned INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL
);
CREATE INDEX artifacts_run ON artifacts(run_id);
`,
  },
  {
    version: 4,
    name: "project run command",
    sql: `ALTER TABLE projects ADD COLUMN run_command TEXT;`,
  },
];
