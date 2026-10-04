// Typed queries for the core tables. Entity writes that browsers observe go
// through the `save*` helpers, which append the matching event in the same
// transaction so the event log never disagrees with table state.
import {
  type AppEvent,
  type Command,
  type CommandState,
  type Conversation,
  type ConversationItem,
  DETAIL_EVENT_TYPES,
  type EventBody,
  nowIso,
  type PendingInput,
  type ProcessSession,
  type Project,
  type Run,
  type RunState,
  uuidv7,
  type WorkerStatus,
  type Workspace,
} from "@workbench/contracts";
import type { Database } from "./database.ts";

type Row = Record<string, unknown>;
const json = <T>(v: unknown): T => (v == null ? (null as T) : (JSON.parse(String(v)) as T));
const str = (v: unknown) => (v == null ? null : String(v));
const num = (v: unknown) => (v == null ? null : Number(v));

// ---------------------------------------------------------------- mappers

export const toProject = (r: Row): Project => ({
  id: String(r.id),
  name: String(r.name),
  repoPath: String(r.repo_path),
  defaultBranch: String(r.default_branch),
  setupCommand: str(r.setup_command),
  runCommand: str(r.run_command),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

export const toWorkspace = (r: Row): Workspace => ({
  id: String(r.id),
  projectId: String(r.project_id),
  name: String(r.name),
  branch: String(r.branch),
  baseRef: String(r.base_ref),
  worktreePath: String(r.worktree_path),
  state: r.state as Workspace["state"],
  error: str(r.error),
  setupExitCode: num(r.setup_exit_code),
  portBase: num(r.port_base),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
  archivedAt: str(r.archived_at),
});

export const toConversation = (r: Row): Conversation => ({
  id: String(r.id),
  workspaceId: String(r.workspace_id),
  provider: r.provider as Conversation["provider"],
  providerThreadId: str(r.provider_thread_id),
  title: String(r.title),
  model: str(r.model),
  approvalPolicy: r.approval_policy as Conversation["approvalPolicy"],
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
  lastActivityAt: String(r.last_activity_at),
});

export const toRun = (r: Row): Run => ({
  id: String(r.id),
  kind: r.kind as Run["kind"],
  workspaceId: str(r.workspace_id),
  conversationId: str(r.conversation_id),
  jobId: str(r.job_id),
  state: r.state as RunState,
  providerTurnId: str(r.provider_turn_id),
  summary: String(r.summary),
  stopReason: str(r.stop_reason),
  error: str(r.error),
  attempt: Number(r.attempt),
  createdAt: String(r.created_at),
  startedAt: str(r.started_at),
  endedAt: str(r.ended_at),
});

export const toCommand = (r: Row): Command => ({
  id: String(r.id),
  idempotencyKey: String(r.idempotency_key),
  type: String(r.type),
  payload: json(r.payload),
  state: r.state as CommandState,
  result: json(r.result),
  error: str(r.error),
  createdAt: String(r.created_at),
  finishedAt: str(r.finished_at),
});

export const toItem = (r: Row): ConversationItem => ({
  id: String(r.id),
  conversationId: String(r.conversation_id),
  runId: str(r.run_id),
  providerItemId: str(r.provider_item_id),
  kind: r.kind as ConversationItem["kind"],
  status: (r.status ?? null) as ConversationItem["status"],
  data: json(r.data),
  position: Number(r.position),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
});

export const toInput = (r: Row): PendingInput => ({
  id: String(r.id),
  conversationId: String(r.conversation_id),
  runId: String(r.run_id),
  kind: r.kind as PendingInput["kind"],
  state: r.state as PendingInput["state"],
  request: json(r.request),
  response: json(r.response),
  createdAt: String(r.created_at),
  resolvedAt: str(r.resolved_at),
});

const toEvent = (r: Row): AppEvent => ({
  ...(json<EventBody>(r.body) as EventBody),
  seq: Number(r.seq),
  conversationId: str(r.conversation_id),
  createdAt: String(r.created_at),
});

// ---------------------------------------------------------------- events

export function appendEvent(db: Database, body: EventBody, conversationId: string | null = null): number {
  const detail = DETAIL_EVENT_TYPES.includes(body.type) ? 1 : 0;
  return db.run(
    "INSERT INTO events (type, conversation_id, detail, body, created_at) VALUES (:type, :c, :detail, :body, :at)",
    { type: body.type, c: conversationId, detail, body: JSON.stringify(body), at: nowIso() },
  ).lastInsertRowid;
}

export const latestSeq = (db: Database) => db.get<{ s: number | null }>("SELECT max(seq) s FROM events")!.s ?? 0;
export const oldestSeq = (db: Database) => db.get<{ s: number | null }>("SELECT min(seq) s FROM events")!.s ?? 0;

/**
 * Events after `after`. Global events are always included; detail events only
 * for `conversationId`.
 */
export function eventsAfter(db: Database, after: number, conversationId: string | null, limit = 500): AppEvent[] {
  return db
    .all<Row>(
      `SELECT * FROM events WHERE seq > :after AND (detail = 0 OR conversation_id = :c) ORDER BY seq LIMIT :limit`,
      { after, c: conversationId ?? "", limit },
    )
    .map(toEvent);
}

/** Drop detail events older than the cutoff; item rows keep the coherent state. */
export function pruneEvents(db: Database, olderThanIso: string): number {
  return db.run("DELETE FROM events WHERE created_at < :t AND seq < (SELECT max(seq) FROM events)", {
    t: olderThanIso,
  }).changes;
}

// ---------------------------------------------------------------- projects & workspaces

export const listProjects = (db: Database) => db.all<Row>("SELECT * FROM projects ORDER BY name").map(toProject);
export const getProject = (db: Database, id: string) => {
  const r = db.get<Row>("SELECT * FROM projects WHERE id = :id", { id });
  return r ? toProject(r) : undefined;
};

export function saveProject(db: Database, p: Project): Project {
  db.tx(() => {
    db.run(
      `INSERT INTO projects (id, name, repo_path, default_branch, setup_command, run_command, created_at, updated_at)
       VALUES (:id, :name, :repo, :branch, :setup, :run, :created, :updated)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, default_branch = excluded.default_branch,
         setup_command = excluded.setup_command, run_command = excluded.run_command, updated_at = excluded.updated_at`,
      {
        id: p.id,
        name: p.name,
        repo: p.repoPath,
        branch: p.defaultBranch,
        setup: p.setupCommand,
        run: p.runCommand,
        created: p.createdAt,
        updated: p.updatedAt,
      },
    );
    appendEvent(db, { type: "project.upserted", project: p });
  });
  return p;
}

export const listWorkspaces = (db: Database) =>
  db.all<Row>("SELECT * FROM workspaces ORDER BY created_at").map(toWorkspace);
export const getWorkspace = (db: Database, id: string) => {
  const r = db.get<Row>("SELECT * FROM workspaces WHERE id = :id", { id });
  return r ? toWorkspace(r) : undefined;
};

export function saveWorkspace(db: Database, w: Workspace): Workspace {
  db.tx(() => {
    db.run(
      `INSERT INTO workspaces (id, project_id, name, branch, base_ref, worktree_path, state, error, setup_exit_code,
         port_base, created_at, updated_at, archived_at)
       VALUES (:id, :project, :name, :branch, :base, :path, :state, :error, :exit, :port, :created, :updated, :archived)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, state = excluded.state, error = excluded.error,
         setup_exit_code = excluded.setup_exit_code, port_base = excluded.port_base,
         updated_at = excluded.updated_at, archived_at = excluded.archived_at`,
      {
        id: w.id,
        project: w.projectId,
        name: w.name,
        branch: w.branch,
        base: w.baseRef,
        path: w.worktreePath,
        state: w.state,
        error: w.error,
        exit: w.setupExitCode,
        port: w.portBase,
        created: w.createdAt,
        updated: w.updatedAt,
        archived: w.archivedAt,
      },
    );
    appendEvent(db, { type: "workspace.upserted", workspace: w });
  });
  return w;
}

export function updateWorkspace(db: Database, id: string, patch: Partial<Workspace>): Workspace {
  return db.tx(() => {
    const w = getWorkspace(db, id);
    if (!w) throw new Error(`workspace ${id} not found`);
    return saveWorkspace(db, { ...w, ...patch, updatedAt: nowIso() });
  });
}

// ---------------------------------------------------------------- conversations

export const listConversations = (db: Database) =>
  db.all<Row>("SELECT * FROM conversations ORDER BY created_at").map(toConversation);
export const getConversation = (db: Database, id: string) => {
  const r = db.get<Row>("SELECT * FROM conversations WHERE id = :id", { id });
  return r ? toConversation(r) : undefined;
};

export function saveConversation(db: Database, c: Conversation): Conversation {
  db.tx(() => {
    db.run(
      `INSERT INTO conversations (id, workspace_id, provider, provider_thread_id, title, model, approval_policy,
         created_at, updated_at, last_activity_at)
       VALUES (:id, :ws, :provider, :thread, :title, :model, :policy, :created, :updated, :activity)
       ON CONFLICT(id) DO UPDATE SET provider_thread_id = excluded.provider_thread_id, title = excluded.title,
         model = excluded.model, approval_policy = excluded.approval_policy, updated_at = excluded.updated_at,
         last_activity_at = excluded.last_activity_at`,
      {
        id: c.id,
        ws: c.workspaceId,
        provider: c.provider,
        thread: c.providerThreadId,
        title: c.title,
        model: c.model,
        policy: c.approvalPolicy,
        created: c.createdAt,
        updated: c.updatedAt,
        activity: c.lastActivityAt,
      },
    );
    appendEvent(db, { type: "conversation.upserted", conversation: c }, c.id);
  });
  return c;
}

export function updateConversation(db: Database, id: string, patch: Partial<Conversation>): Conversation {
  return db.tx(() => {
    const c = getConversation(db, id);
    if (!c) throw new Error(`conversation ${id} not found`);
    return saveConversation(db, { ...c, ...patch, updatedAt: nowIso() });
  });
}

// ---------------------------------------------------------------- runs

export const getRun = (db: Database, id: string) => {
  const r = db.get<Row>("SELECT * FROM runs WHERE id = :id", { id });
  return r ? toRun(r) : undefined;
};

export const listActiveRuns = (db: Database) =>
  db
    .all<Row>(
      "SELECT * FROM runs WHERE state NOT IN ('succeeded','failed','cancelled','interrupted') ORDER BY created_at",
    )
    .map(toRun);

export const listConversationRuns = (db: Database, conversationId: string, limit = 200) =>
  db
    .all<Row>("SELECT * FROM runs WHERE conversation_id = :c ORDER BY created_at DESC LIMIT :limit", {
      c: conversationId,
      limit,
    })
    .map(toRun)
    .reverse();

export function saveRun(db: Database, run: Run, owner: string | null = null): Run {
  db.tx(() => {
    db.run(
      `INSERT INTO runs (id, kind, workspace_id, conversation_id, job_id, state, provider_turn_id, summary, stop_reason,
         error, attempt, owner, created_at, started_at, ended_at)
       VALUES (:id, :kind, :ws, :conv, :job, :state, :turn, :summary, :stop, :error, :attempt, :owner, :created,
         :started, :ended)
       ON CONFLICT(id) DO UPDATE SET state = excluded.state, provider_turn_id = excluded.provider_turn_id,
         stop_reason = excluded.stop_reason, error = excluded.error, owner = coalesce(excluded.owner, runs.owner),
         started_at = excluded.started_at, ended_at = excluded.ended_at`,
      {
        id: run.id,
        kind: run.kind,
        ws: run.workspaceId,
        conv: run.conversationId,
        job: run.jobId,
        state: run.state,
        turn: run.providerTurnId,
        summary: run.summary,
        stop: run.stopReason,
        error: run.error,
        attempt: run.attempt,
        owner,
        created: run.createdAt,
        started: run.startedAt,
        ended: run.endedAt,
      },
    );
    appendEvent(db, { type: "run.upserted", run }, run.conversationId);
  });
  return run;
}

export function updateRun(db: Database, id: string, patch: Partial<Run>): Run {
  return db.tx(() => {
    const r = getRun(db, id);
    if (!r) throw new Error(`run ${id} not found`);
    return saveRun(db, { ...r, ...patch });
  });
}

export const runOwner = (db: Database, id: string) =>
  db.get<{ owner: string | null }>("SELECT owner FROM runs WHERE id = :id", { id })?.owner ?? null;

// ---------------------------------------------------------------- commands

export type InsertCommandResult = { command: Command; created: boolean; conflict: boolean };

/**
 * Persist a command once per idempotency key. A repeated key with the same
 * type and payload returns the original command; a different payload is a
 * conflict and is not executed.
 */
export function insertCommand(db: Database, key: string, type: string, payload: unknown): InsertCommandResult {
  return db.tx(() => {
    const existing = db.get<Row>("SELECT * FROM commands WHERE idempotency_key = :key", { key });
    if (existing) {
      const command = toCommand(existing);
      const same = command.type === type && JSON.stringify(command.payload) === JSON.stringify(payload);
      return { command, created: false, conflict: !same };
    }
    const command: Command = {
      id: uuidv7(),
      idempotencyKey: key,
      type,
      payload,
      state: "accepted",
      result: null,
      error: null,
      createdAt: nowIso(),
      finishedAt: null,
    };
    db.run(
      `INSERT INTO commands (id, idempotency_key, type, payload, state, created_at)
       VALUES (:id, :key, :type, :payload, 'accepted', :created)`,
      { id: command.id, key, type, payload: JSON.stringify(payload), created: command.createdAt },
    );
    appendEvent(db, { type: "command.upserted", command });
    return { command, created: true, conflict: false };
  });
}

export const getCommand = (db: Database, id: string) => {
  const r = db.get<Row>("SELECT * FROM commands WHERE id = :id", { id });
  return r ? toCommand(r) : undefined;
};

/** Atomically claim the oldest accepted command for this worker instance. */
export function claimCommand(db: Database, owner: string): Command | undefined {
  return db.tx(() => {
    const r = db.get<Row>(
      `UPDATE commands SET state = 'claimed', claimed_by = :owner, claimed_at = :at
       WHERE id = (SELECT id FROM commands WHERE state = 'accepted' ORDER BY created_at LIMIT 1)
       RETURNING *`,
      { owner, at: nowIso() },
    );
    return r ? toCommand(r) : undefined;
  });
}

export function finishCommand(db: Database, id: string, outcome: { result?: unknown; error?: string }): Command {
  return db.tx(() => {
    const r = db.get<Row>(
      `UPDATE commands SET state = :state, result = :result, error = :error, finished_at = :at
       WHERE id = :id RETURNING *`,
      {
        id,
        state: outcome.error ? "failed" : "succeeded",
        result: outcome.result === undefined ? null : JSON.stringify(outcome.result),
        error: outcome.error ?? null,
        at: nowIso(),
      },
    );
    const command = toCommand(r!);
    appendEvent(db, { type: "command.upserted", command });
    return command;
  });
}

/** Commands claimed by an instance that no longer exists cannot be resumed blindly. */
export function failOrphanedCommands(db: Database, currentOwner: string): Command[] {
  const rows = db.all<Row>("SELECT id FROM commands WHERE state = 'claimed' AND claimed_by != :owner", {
    owner: currentOwner,
  });
  return rows.map((r) =>
    finishCommand(db, String(r.id), {
      error: "The worker restarted while this command was executing; its outcome was not confirmed.",
    }),
  );
}

// ---------------------------------------------------------------- items

export const getItemByProviderId = (db: Database, conversationId: string, providerItemId: string) => {
  const r = db.get<Row>("SELECT * FROM items WHERE conversation_id = :c AND provider_item_id = :p", {
    c: conversationId,
    p: providerItemId,
  });
  return r ? toItem(r) : undefined;
};

export const getItem = (db: Database, id: string) => {
  const r = db.get<Row>("SELECT * FROM items WHERE id = :id", { id });
  return r ? toItem(r) : undefined;
};

/** Insert or replace an item and publish it. Position is fixed at first insert. */
export function saveItem(db: Database, item: Omit<ConversationItem, "position"> & { position?: number }) {
  return db.tx(() => {
    const existing = getItem(db, item.id);
    const position = existing?.position ?? item.position ?? latestSeq(db) + 1;
    const full: ConversationItem = { ...item, position };
    db.run(
      `INSERT INTO items (id, conversation_id, run_id, provider_item_id, kind, status, data, position, created_at, updated_at)
       VALUES (:id, :c, :run, :pid, :kind, :status, :data, :position, :created, :updated)
       ON CONFLICT(id) DO UPDATE SET status = excluded.status, data = excluded.data, kind = excluded.kind,
         updated_at = excluded.updated_at`,
      {
        id: full.id,
        c: full.conversationId,
        run: full.runId,
        pid: full.providerItemId,
        kind: full.kind,
        status: full.status,
        data: JSON.stringify(full.data),
        position,
        created: full.createdAt,
        updated: full.updatedAt,
      },
    );
    appendEvent(db, { type: "item.upserted", item: full }, full.conversationId);
    return full;
  });
}

/** Persist accumulated streaming text without re-sending the whole item. */
export function appendItemDelta(
  db: Database,
  item: ConversationItem,
  field: "text" | "output",
  delta: string,
  maxLength: number,
): void {
  db.tx(() => {
    const current = String(item.data[field] ?? "");
    let next = current + delta;
    let truncated = field === "output" ? Boolean(item.data.outputTruncated) : false;
    if (next.length > maxLength) {
      next = next.slice(next.length - maxLength);
      truncated = true;
    }
    item.data[field] = next;
    if (field === "output") item.data.outputTruncated = truncated;
    item.updatedAt = nowIso();
    db.run("UPDATE items SET data = :data, updated_at = :u WHERE id = :id", {
      id: item.id,
      data: JSON.stringify(item.data),
      u: item.updatedAt,
    });
    appendEvent(db, { type: "item.delta", itemId: item.id, field, delta }, item.conversationId);
  });
}

/** Page of items ordered by position, newest page first when `before` is null. */
export function listItems(db: Database, conversationId: string, before: number | null, limit: number) {
  const rows = db.all<Row>(
    `SELECT * FROM items WHERE conversation_id = :c AND position < :before ORDER BY position DESC LIMIT :limit`,
    { c: conversationId, before: before ?? Number.MAX_SAFE_INTEGER, limit: limit + 1 },
  );
  const hasMore = rows.length > limit;
  return { items: rows.slice(0, limit).map(toItem).reverse(), hasMore };
}

// ---------------------------------------------------------------- pending inputs

export const getInput = (db: Database, id: string) => {
  const r = db.get<Row>("SELECT * FROM pending_inputs WHERE id = :id", { id });
  return r ? toInput(r) : undefined;
};

export const getInputByProviderRequest = (db: Database, runId: string, providerRequestId: string) => {
  const r = db.get<Row>("SELECT * FROM pending_inputs WHERE run_id = :run AND provider_request_id = :p", {
    run: runId,
    p: providerRequestId,
  });
  return r ? toInput(r) : undefined;
};

export const listOpenInputs = (db: Database) =>
  db.all<Row>("SELECT * FROM pending_inputs WHERE state = 'open' ORDER BY created_at").map(toInput);

export const listConversationInputs = (db: Database, conversationId: string) =>
  db
    .all<Row>("SELECT * FROM pending_inputs WHERE conversation_id = :c ORDER BY created_at DESC LIMIT 50", {
      c: conversationId,
    })
    .map(toInput)
    .reverse();

export function createInput(db: Database, input: PendingInput, providerRequestId: string): PendingInput {
  db.tx(() => {
    db.run(
      `INSERT INTO pending_inputs (id, conversation_id, run_id, provider_request_id, kind, state, request, created_at)
       VALUES (:id, :c, :run, :p, :kind, 'open', :request, :created)`,
      {
        id: input.id,
        c: input.conversationId,
        run: input.runId,
        p: providerRequestId,
        kind: input.kind,
        request: JSON.stringify(input.request),
        created: input.createdAt,
      },
    );
    appendEvent(db, { type: "input.upserted", input }, input.conversationId);
  });
  return input;
}

/**
 * Resolve an open input. Returns the updated input, or undefined when it was
 * already resolved: the first response wins and later ones are stale.
 */
export function resolveInput(
  db: Database,
  id: string,
  state: "answered" | "cancelled",
  response: PendingInput["response"],
): PendingInput | undefined {
  return db.tx(() => {
    const r = db.get<Row>(
      `UPDATE pending_inputs SET state = :state, response = :response, resolved_at = :at
       WHERE id = :id AND state = 'open' RETURNING *`,
      { id, state, response: response ? JSON.stringify(response) : null, at: nowIso() },
    );
    if (!r) return undefined;
    const input = toInput(r);
    appendEvent(db, { type: "input.upserted", input }, input.conversationId);
    return input;
  });
}

export function cancelOpenInputsForRun(db: Database, runId: string): void {
  const rows = db.all<Row>("SELECT id FROM pending_inputs WHERE run_id = :run AND state = 'open'", { run: runId });
  for (const r of rows) resolveInput(db, String(r.id), "cancelled", null);
}

// ---------------------------------------------------------------- auth sessions

export function createAuthSession(db: Database, tokenHash: string, ttlMs: number, userAgent: string | null) {
  const now = new Date();
  db.run(
    `INSERT INTO auth_sessions (token_hash, created_at, expires_at, last_seen_at, user_agent)
     VALUES (:h, :now, :exp, :now, :ua)`,
    { h: tokenHash, now: now.toISOString(), exp: new Date(now.getTime() + ttlMs).toISOString(), ua: userAgent },
  );
}

export function validAuthSession(db: Database, tokenHash: string): boolean {
  const r = db.get<{ expires_at: string; last_seen_at: string }>(
    "SELECT expires_at, last_seen_at FROM auth_sessions WHERE token_hash = :h",
    { h: tokenHash },
  );
  if (!r || r.expires_at < nowIso()) return false;
  // Touch at most once a minute to avoid a write per request.
  if (Date.now() - Date.parse(r.last_seen_at) > 60_000) {
    db.run("UPDATE auth_sessions SET last_seen_at = :now WHERE token_hash = :h", { h: tokenHash, now: nowIso() });
  }
  return true;
}

export const deleteAuthSession = (db: Database, tokenHash: string) =>
  db.run("DELETE FROM auth_sessions WHERE token_hash = :h", { h: tokenHash });

export const pruneAuthSessions = (db: Database) =>
  db.run("DELETE FROM auth_sessions WHERE expires_at < :now", { now: nowIso() });

// ---------------------------------------------------------------- worker status

export function saveWorkerStatus(db: Database, status: WorkerStatus, publish: boolean): void {
  db.tx(() => {
    db.run(
      `INSERT INTO worker_status (id, body, heartbeat_at) VALUES (1, :body, :hb)
       ON CONFLICT(id) DO UPDATE SET body = excluded.body, heartbeat_at = excluded.heartbeat_at`,
      { body: JSON.stringify(status), hb: status.heartbeatAt },
    );
    if (publish) appendEvent(db, { type: "worker.status", status });
  });
}

export function getWorkerStatus(db: Database): WorkerStatus | null {
  const r = db.get<{ body: string }>("SELECT body FROM worker_status WHERE id = 1");
  return r ? (JSON.parse(r.body) as WorkerStatus) : null;
}

// ---------------------------------------------------------------- process sessions

export const toProcess = (r: Row): ProcessSession => ({
  id: String(r.id),
  workspaceId: String(r.workspace_id),
  kind: r.kind as ProcessSession["kind"],
  name: String(r.name),
  command: str(r.command),
  cwd: String(r.cwd),
  tmuxSession: String(r.tmux_session),
  state: r.state as ProcessSession["state"],
  exitCode: num(r.exit_code),
  port: num(r.port),
  createdAt: String(r.created_at),
  updatedAt: String(r.updated_at),
  endedAt: str(r.ended_at),
});

/** Running processes plus the most recent finished ones per workspace. */
export const listProcesses = (db: Database) =>
  db
    .all<Row>(
      `SELECT * FROM process_sessions WHERE state IN ('starting','running')
         OR id IN (SELECT id FROM process_sessions ORDER BY created_at DESC LIMIT 200)
       ORDER BY created_at`,
    )
    .map(toProcess);

export const getProcess = (db: Database, id: string) => {
  const r = db.get<Row>("SELECT * FROM process_sessions WHERE id = :id", { id });
  return r ? toProcess(r) : undefined;
};

export function saveProcess(db: Database, p: ProcessSession): ProcessSession {
  db.tx(() => {
    db.run(
      `INSERT INTO process_sessions (id, workspace_id, kind, name, command, cwd, tmux_session, state, exit_code, port,
         created_at, updated_at, ended_at)
       VALUES (:id, :ws, :kind, :name, :command, :cwd, :tmux, :state, :exit, :port, :created, :updated, :ended)
       ON CONFLICT(id) DO UPDATE SET name = excluded.name, state = excluded.state, exit_code = excluded.exit_code,
         updated_at = excluded.updated_at, ended_at = excluded.ended_at`,
      {
        id: p.id,
        ws: p.workspaceId,
        kind: p.kind,
        name: p.name,
        command: p.command,
        cwd: p.cwd,
        tmux: p.tmuxSession,
        state: p.state,
        exit: p.exitCode,
        port: p.port,
        created: p.createdAt,
        updated: p.updatedAt,
        ended: p.endedAt,
      },
    );
    appendEvent(db, { type: "process.upserted", process: p });
  });
  return p;
}
