import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { test } from "node:test";
import { nowIso, uuidv7 } from "@workbench/contracts";
import { saveConversation, saveItem, saveRun, updateRun } from "@workbench/db";
import { sessionInstructions } from "../src/session-context.ts";
import { Workspaces } from "../src/workspaces.ts";
import { makeContext, makeRepo } from "./helpers.ts";

test("live session discovery scopes concurrent activity to a worktree and observes completed turns", async () => {
  const ctx = makeContext();
  try {
    const workspaces = new Workspaces(ctx);
    const { projectId } = await workspaces.registerProject({ path: makeRepo() });
    const { workspaceId } = await workspaces.createWorkspace({ projectId, name: "shared" });
    const otherWorkspace = (await workspaces.createWorkspace({ projectId, name: "isolated" })).workspaceId;
    const now = nowIso();
    const conversation = (workspaceId: string, provider: "claude" | "codex") =>
      saveConversation(ctx.db, {
        id: uuidv7(),
        workspaceId,
        provider,
        providerThreadId: null,
        title: provider,
        model: null,
        reasoningEffort: null,
        serviceTier: null,
        approvalPolicy: "never",
        createdAt: now,
        updatedAt: now,
        lastActivityAt: now,
      });
    const own = conversation(workspaceId, "claude");
    const peer = conversation(workspaceId, "codex");
    const isolated = conversation(otherWorkspace, "codex");
    const run = (conversationId: string, workspaceId: string) =>
      saveRun(
        ctx.db,
        {
          id: uuidv7(),
          conversationId,
          workspaceId,
          kind: "agent_turn",
          jobId: null,
          state: "running",
          providerTurnId: null,
          summary: "Update foo.ts",
          stopReason: null,
          error: null,
          attempt: 1,
          createdAt: now,
          startedAt: now,
          endedAt: null,
        },
        ctx.instanceId,
      );
    run(own.id, workspaceId);
    const other = run(peer.id, workspaceId);
    run(isolated.id, otherWorkspace);
    saveItem(ctx.db, {
      id: uuidv7(),
      conversationId: peer.id,
      runId: other.id,
      providerItemId: null,
      kind: "tool_call",
      status: "in_progress",
      data: { tool: "Edit", arguments: { file_path: "foo.ts" } },
      createdAt: now,
      updatedAt: now,
    });
    const read = () =>
      JSON.parse(
        execFileSync(
          process.execPath,
          [join(import.meta.dirname, "../src/session-status.ts"), ctx.config.dbPath, workspaceId, own.id],
          { encoding: "utf8" },
        ),
      );
    assert.deepEqual(
      read().sessions.map((s: { conversationId: string }) => s.conversationId),
      [peer.id],
    );
    assert.equal(read().sessions[0].recentActivity[0].tool, "Edit");
    updateRun(ctx.db, other.id, { state: "succeeded", endedAt: nowIso() });
    assert.equal(read().sessions[0].state, "succeeded");
    const instructions = sessionInstructions(ctx, workspaceId, own.id);
    assert.match(instructions, /session-status.ts/);
    assert.match(instructions, /Stage and commit only your own changes/);
    assert.match(instructions, /pause only the overlapping edits/);
  } finally {
    ctx.db.close();
  }
});
