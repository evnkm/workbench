import assert from "node:assert/strict";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { nowIso, type PendingInput, type Run, uuidv7 } from "@workbench/contracts";
import {
  appendEvent,
  claimCommand,
  createInput,
  Database,
  eventsAfter,
  failOrphanedCommands,
  insertCommand,
  latestSeq,
  listProjects,
  resolveInput,
  saveConversation,
  saveItem,
  saveProject,
  saveRun,
  saveWorkspace,
} from "../src/index.ts";

const tempDb = () => {
  const db = new Database(join(mkdtempSync(join(tmpdir(), "wb-db-")), "t.sqlite"));
  db.migrate();
  return db;
};

function seed(db: Database) {
  const now = nowIso();
  const project = saveProject(db, {
    id: uuidv7(),
    name: "p",
    repoPath: `/r/${uuidv7()}`,
    defaultBranch: "main",
    setupCommand: null,
    runCommand: null,
    createdAt: now,
    updatedAt: now,
  });
  const workspace = saveWorkspace(db, {
    id: uuidv7(),
    projectId: project.id,
    name: "w",
    branch: `b-${uuidv7()}`,
    baseRef: "main",
    worktreePath: `/wt/${uuidv7()}`,
    state: "ready",
    error: null,
    setupExitCode: null,
    portBase: null,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  const conversation = saveConversation(db, {
    id: uuidv7(),
    workspaceId: workspace.id,
    provider: "codex",
    providerThreadId: null,
    title: "c",
    model: null,
    approvalPolicy: "never",
    createdAt: now,
    updatedAt: now,
    lastActivityAt: now,
  });
  return { project, workspace, conversation };
}

const run = (conversationId: string, workspaceId: string, state: Run["state"] = "running"): Run => ({
  id: uuidv7(),
  kind: "agent_turn",
  workspaceId,
  conversationId,
  jobId: null,
  state,
  providerTurnId: null,
  summary: "",
  stopReason: null,
  error: null,
  attempt: 1,
  createdAt: nowIso(),
  startedAt: null,
  endedAt: null,
});

test("an empty database migrates to the latest version and is idempotent", () => {
  const db = tempDb();
  assert.equal(db.migrate(), 4);
  assert.deepEqual(listProjects(db), []);
});

test("one idempotency key produces one durable command", () => {
  const db = tempDb();
  const a = insertCommand(db, "key-1", "project.register", { path: "/x" });
  const b = insertCommand(db, "key-1", "project.register", { path: "/x" });
  assert.equal(a.created, true);
  assert.equal(b.created, false);
  assert.equal(b.command.id, a.command.id);
  const c = insertCommand(db, "key-1", "project.register", { path: "/other" });
  assert.equal(c.conflict, true);
  assert.equal(db.get<{ n: number }>("SELECT count(*) n FROM commands")!.n, 1);
});

test("two connections never claim the same command", () => {
  const db1 = tempDb();
  const db2 = new Database(db1.path);
  for (let i = 0; i < 50; i++) insertCommand(db1, `k${i}`, "workspace.rename", { i });
  const claimed: string[] = [];
  for (;;) {
    const a = claimCommand(db1, "w1");
    const b = claimCommand(db2, "w2");
    if (a) claimed.push(a.id);
    if (b) claimed.push(b.id);
    if (!a && !b) break;
  }
  assert.equal(claimed.length, 50);
  assert.equal(new Set(claimed).size, 50);
});

test("commands claimed by a previous worker instance fail instead of re-running", () => {
  const db = tempDb();
  insertCommand(db, "k", "workspace.rename", {});
  claimCommand(db, "old-instance");
  const failed = failOrphanedCommands(db, "new-instance");
  assert.equal(failed.length, 1);
  assert.equal(failed[0]!.state, "failed");
  assert.equal(claimCommand(db, "new-instance"), undefined);
});

test("event replay is ordered and filters detail events by conversation", () => {
  const db = tempDb();
  const { conversation, workspace } = seed(db);
  const start = latestSeq(db);
  const other = saveConversation(db, { ...conversation, id: uuidv7(), providerThreadId: null });
  for (const c of [conversation, other]) {
    saveItem(db, {
      id: uuidv7(),
      conversationId: c.id,
      runId: null,
      providerItemId: null,
      kind: "agent_message",
      status: "completed",
      data: { text: c.id },
      createdAt: nowIso(),
      updatedAt: nowIso(),
    });
  }
  appendEvent(db, { type: "workspace.upserted", workspace });
  const events = eventsAfter(db, start, conversation.id);
  const seqs = events.map((e) => e.seq);
  assert.deepEqual(
    seqs,
    [...seqs].sort((a, b) => a - b),
  );
  const items = events.filter((e) => e.type === "item.upserted");
  assert.equal(items.length, 1);
  assert.equal(items[0]!.conversationId, conversation.id);
  assert.ok(events.some((e) => e.type === "workspace.upserted"));
  // Resuming from a later cursor returns only newer events.
  assert.deepEqual(
    eventsAfter(db, seqs[1]!, conversation.id).map((e) => e.seq),
    seqs.slice(2),
  );
});

test("an item's position equals the sequence of the event that created it", () => {
  const db = tempDb();
  const { conversation } = seed(db);
  const item = saveItem(db, {
    id: uuidv7(),
    conversationId: conversation.id,
    runId: null,
    providerItemId: "p1",
    kind: "agent_message",
    status: "in_progress",
    data: { text: "" },
    createdAt: nowIso(),
    updatedAt: nowIso(),
  });
  assert.equal(item.position, latestSeq(db));
  const again = saveItem(db, { ...item, status: "completed", data: { text: "x" } });
  assert.equal(again.position, item.position);
});

test("the first response to a pending input wins; later responses are stale", () => {
  const db = tempDb();
  const { conversation, workspace } = seed(db);
  const r = saveRun(db, run(conversation.id, workspace.id));
  const input: PendingInput = {
    id: uuidv7(),
    conversationId: conversation.id,
    runId: r.id,
    kind: "command_approval",
    state: "open",
    request: { title: "Run?" },
    response: null,
    createdAt: nowIso(),
    resolvedAt: null,
  };
  createInput(db, input, "1:0");
  const db2 = new Database(db.path);
  const first = resolveInput(db, input.id, "answered", { kind: "decision", decision: "accept" });
  const second = resolveInput(db2, input.id, "answered", { kind: "decision", decision: "decline" });
  assert.equal(first?.state, "answered");
  assert.equal(second, undefined);
});

test("only one active agent turn may exist per conversation", () => {
  const db = tempDb();
  const { conversation, workspace } = seed(db);
  saveRun(db, run(conversation.id, workspace.id, "running"));
  assert.throws(() => saveRun(db, run(conversation.id, workspace.id, "queued")), /UNIQUE/);
  saveRun(db, run(conversation.id, workspace.id, "succeeded"));
});

test("a backup restores into a separate location", () => {
  const db = tempDb();
  seed(db);
  const target = join(mkdtempSync(join(tmpdir(), "wb-backup-")), "copy.sqlite");
  db.backupTo(target);
  const restored = new Database(target);
  assert.equal(restored.migrate(), 4);
  assert.equal(listProjects(restored).length, 1);
});
