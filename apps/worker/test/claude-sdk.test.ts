// Exercise the pinned SDK's real subprocess transport and permission bridge
// against a scripted executable, without an Anthropic account or billable calls.
import assert from "node:assert/strict";
import { test } from "node:test";
import { getConversation, getRun, listItems } from "@workbench/db";
import { ClaudeProvider } from "../src/claude/provider.ts";
import { Workspaces } from "../src/workspaces.ts";
import { makeContext, makeRepo, waitFor } from "./helpers.ts";

test("real SDK starts, resumes, bridges approvals/questions, and terminates a subprocess", async () => {
  const ctx = makeContext();
  const key = process.env.ANTHROPIC_API_KEY;
  process.env.ANTHROPIC_API_KEY = "fake-key-not-sent";
  const provider = new ClaudeProvider(ctx);
  try {
    await provider.start();
    const workspaces = new Workspaces(ctx);
    const { projectId } = await workspaces.registerProject({ path: makeRepo() });
    const { workspaceId } = await workspaces.createWorkspace({ projectId, name: "SDK transport" });
    const { conversationId } = await provider.createConversation({
      workspaceId,
      provider: "claude",
      approvalPolicy: "untrusted",
    });
    const turn = async (text: string) => (await provider.submitTurn({ conversationId, text, mode: "default" })).runId;
    const first = await turn("hello");
    await waitFor(() => getRun(ctx.db, first)!.state === "succeeded");
    const session = getConversation(ctx.db, conversationId)!.providerThreadId;
    assert.ok(session);
    assert.equal(
      listItems(ctx.db, conversationId, null, 100).items.find((i) => i.kind === "agent_message")!.data.text,
      "SDK transport works.",
    );
    for (const text of ["approval", "question"]) {
      const runId = await turn(text);
      await waitFor(() => getRun(ctx.db, runId)!.state === "waiting_for_input");
      const row = ctx.db.get<{ id: string }>("SELECT id FROM pending_inputs WHERE run_id = :r", { r: runId })!;
      await provider.respond({
        inputId: row.id,
        response:
          text === "approval"
            ? { kind: "decision", decision: "accept" }
            : { kind: "answers", answers: { "0": ["Blue", "Red"] } },
      });
      await waitFor(() => getRun(ctx.db, runId)!.state === "succeeded");
      assert.equal(getConversation(ctx.db, conversationId)!.providerThreadId, session);
      const result = JSON.parse(
        listItems(ctx.db, conversationId, null, 100).items.find((i) => i.runId === runId && i.kind === "agent_message")!
          .data.text!,
      );
      assert.equal(result.behavior, "allow");
      if (text === "question") assert.deepEqual(result.updatedInput.answers, { "Which color?": "Blue, Red" });
    }
    const background = await turn("background");
    const task = () =>
      listItems(ctx.db, conversationId, null, 100).items.find((i) => i.runId === background && i.kind === "task");
    await waitFor(() => task()?.status === "in_progress");
    await waitFor(() =>
      listItems(ctx.db, conversationId, null, 100).items.some(
        (i) => i.runId === background && i.data.text === "Watching.",
      ),
    );
    // Idle with a live task is not the end of the turn.
    await new Promise((resolve) => setTimeout(resolve, 200));
    assert.equal(getRun(ctx.db, background)!.state, "running");
    await provider.stopTask({ conversationId, runId: background, taskId: "monitor-1" });
    await waitFor(() => getRun(ctx.db, background)!.state === "succeeded");
    assert.equal(task()!.status, "declined");
    assert.deepEqual(
      { state: task()!.data.task!.state, type: task()!.data.task!.type, outputFile: task()!.data.task!.outputFile },
      { state: "stopped", type: "monitor", outputFile: "/tmp/task.output" },
    );
    const hung = await turn("hang");
    await waitFor(() => getRun(ctx.db, hung)!.state === "running" && getRun(ctx.db, hung)!.providerTurnId);
    await provider.interrupt({ conversationId, runId: hung });
    await waitFor(() => getRun(ctx.db, hung)!.state === "cancelled");
    const crashed = await turn("crash");
    await waitFor(() => getRun(ctx.db, crashed)!.state === "failed");
  } finally {
    await provider.stop();
    ctx.db.close();
    if (key === undefined) delete process.env.ANTHROPIC_API_KEY;
    else process.env.ANTHROPIC_API_KEY = key;
  }
});
