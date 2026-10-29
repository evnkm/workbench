import assert from "node:assert/strict";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, before, test } from "node:test";
import type { Options, SDKMessage } from "@anthropic-ai/claude-agent-sdk";
import { uuidv7 } from "@workbench/contracts";
import { getConversation, getInput, getRun, listItems, saveRun } from "@workbench/db";
import { agentHandlers } from "../src/agents.ts";
import { ClaudeProvider, type QueryFactory } from "../src/claude/provider.ts";
import { CodexProvider } from "../src/codex/provider.ts";
import { Workspaces } from "../src/workspaces.ts";
import { makeContext, makeRepo, waitFor } from "./helpers.ts";

const previousKey = process.env.ANTHROPIC_API_KEY;
before(() => {
  process.env.ANTHROPIC_API_KEY = "test-key-never-sent";
});
const cleanup: (() => Promise<void>)[] = [];
after(async () => {
  for (const stop of cleanup) await stop();
  if (previousKey === undefined) delete process.env.ANTHROPIC_API_KEY;
  else process.env.ANTHROPIC_API_KEY = previousKey;
});

// The SDK boundary is mocked, without contacting Anthropic. Fixtures include
// partial-message and completed-block duplication as well as tool results.
function fakeQuery(onOptions?: (options: Options, prompt: string) => void): QueryFactory {
  return ({ prompt, options }) => {
    if (prompt !== null) onOptions?.(options, prompt);
    let release: () => void = () => {};
    let closed = false;
    const signal = new AbortController();
    const hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    const msg = (value: object) => value as SDKMessage;
    const session = options.resume ?? uuidv7();
    const stream = (async function* () {
      yield msg({
        type: "system",
        subtype: "init",
        session_id: session,
        uuid: uuidv7(),
        model: options.model ?? "test-sonnet",
      });
      if (prompt === "hang") {
        await hold;
        return;
      }
      if (prompt === "crash") return;
      if (prompt === "background") {
        // The task's notification starts a second model turn within the same Workbench turn.
        const system = (subtype: string, fields: object) => msg({ type: "system", subtype, uuid: uuidv7(), ...fields });
        const task = { task_id: "agent-1", task_type: "local_agent", description: "Research" };
        yield system("session_state_changed", { state: "running" });
        yield system("task_started", { ...task, is_backgrounded: true });
        yield system("background_tasks_changed", { tasks: [task] });
        yield msg({ type: "result", subtype: "success", is_error: false, result: "Started." });
        yield system("session_state_changed", { state: "idle" });
        const usage = { total_tokens: 10, tool_uses: 2, duration_ms: 500 };
        yield system("task_progress", { ...task, usage, last_tool_name: "Grep", summary: "Reading sources" });
        yield system("background_tasks_changed", { tasks: [] });
        yield system("task_notification", { ...task, status: "completed", output_file: "/tmp/a", summary: "", usage });
        yield system("session_state_changed", { state: "running" });
        yield msg({
          type: "assistant",
          uuid: uuidv7(),
          parent_tool_use_id: null,
          message: { id: uuidv7(), content: [{ type: "text", text: "Research finished." }] },
        });
        yield msg({ type: "result", subtype: "success", is_error: false, result: "Research finished." });
        yield system("session_state_changed", { state: "idle" });
        await hold;
        return;
      }
      if (prompt === "throw") throw new Error("provider process exited");
      if (prompt === "approval" || prompt === "question") {
        const question = prompt === "question";
        const input = question
          ? {
              questions: [
                { header: "Choice", question: "Pick one", options: [{ label: "A", description: "Option A" }] },
              ],
            }
          : { command: "echo approved" };
        const result = await options.canUseTool!(question ? "AskUserQuestion" : "Bash", input, {
          signal: signal.signal,
          toolUseID: "tool-1",
          requestId: "request-1",
        });
        if (closed) return;
        yield msg({
          type: "assistant",
          uuid: uuidv7(),
          parent_tool_use_id: null,
          message: { id: uuidv7(), content: [{ type: "text", text: JSON.stringify(result) }] },
        });
      } else {
        const id = uuidv7();
        for (const event of [
          { type: "message_start", message: { id } },
          { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Hello " } },
          { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: "Claude." } },
          { type: "content_block_stop", index: 0 },
        ])
          yield msg({ type: "stream_event", parent_tool_use_id: null, event });
        yield msg({
          type: "assistant",
          uuid: uuidv7(),
          parent_tool_use_id: null,
          message: {
            id,
            content: [
              { type: "text", text: "Hello Claude." },
              { type: "tool_use", id: `${id}:tool`, name: "Bash", input: { command: "pwd" } },
            ],
          },
        });
        yield msg({
          type: "user",
          message: { content: [{ type: "tool_result", tool_use_id: `${id}:tool`, content: "/workspace" }] },
        });
      }
      yield msg({
        type: "result",
        subtype: prompt === "error" ? "error_during_execution" : "success",
        is_error: prompt === "error",
        errors: ["billing error"],
        result: "Done.",
      });
    })();
    return {
      [Symbol.asyncIterator]: () => stream,
      close: () => {
        closed = true;
        signal.abort();
        release();
      },
      stopTask: async () => {},
      supportedModels: async () => [
        {
          value: "default",
          resolvedModel: "test-opus-5",
          displayName: "Default",
          description: "Opus",
          supportedEffortLevels: ["low", "high"],
        },
        {
          value: "opus",
          resolvedModel: "test-opus-5",
          displayName: "Opus",
          description: "Opus",
          supportedEffortLevels: ["low", "high"],
        },
        { value: "test-haiku", displayName: "Haiku", description: "Haiku" },
      ],
      supportedCommands: async () => [
        { name: "compact", description: "Summarize context", argumentHint: "<instructions>" },
      ],
    };
  };
}

async function setup(factory = fakeQuery()) {
  const ctx = makeContext();
  const workspaces = new Workspaces(ctx);
  const { projectId } = await workspaces.registerProject({ path: makeRepo() });
  const { workspaceId } = await workspaces.createWorkspace({ projectId, name: "Claude tests" });
  const claude = new ClaudeProvider(ctx, factory);
  await claude.start();
  cleanup.push(async () => {
    await claude.stop();
    ctx.db.close();
  });
  const conversation = async (approvalPolicy: "never" | "untrusted" | "on-request" = "untrusted") =>
    (await claude.createConversation({ workspaceId, provider: "claude", approvalPolicy })).conversationId;
  const turn = (conversationId: string, text = "hello", mode: "default" | "plan" = "default") =>
    claude.submitTurn({ conversationId, text, mode });
  const done = (runId: string, state = "succeeded") => waitFor(() => getRun(ctx.db, runId)!.state === state);
  return { ctx, claude, workspaceId, conversation, turn, done };
}

test("Claude streams once, maps tool results, and resumes its own persisted session with project settings", async () => {
  const calls: { options: Options; prompt: string }[] = [];
  const { ctx, claude, conversation, turn, done } = await setup(
    fakeQuery((options, prompt) => calls.push({ options, prompt })),
  );
  const id = await conversation();
  const first = await turn(id);
  await done(first.runId);
  const items = listItems(ctx.db, id, null, 100).items;
  assert.deepEqual(
    items.map((i) => i.kind),
    ["user_message", "agent_message", "command"],
  );
  assert.equal(items[1]!.data.text, "Hello Claude.");
  assert.equal(items[2]!.data.output, "/workspace");
  assert.equal(items[2]!.status, "completed");
  const session = getConversation(ctx.db, id)!.providerThreadId;
  assert.ok(session);
  await assert.rejects(
    claude.configureConversation({ conversationId: id, reasoningEffort: "extreme" }),
    /must be one of/,
  );
  await claude.configureConversation({ conversationId: id, model: "test-opus-5", reasoningEffort: "high" });
  const menu = await claude.inspect({ conversationId: id, view: "models" });
  assert.equal(menu.kind, "models");
  if (menu.kind !== "models") return;
  assert.deepEqual(
    menu.models.map((m) => [m.model, m.isDefault, m.efforts.map((e) => e.effort)]),
    [
      ["default", true, ["low", "high"]],
      ["test-opus-5", false, ["low", "high"]],
      ["test-haiku", false, []],
    ],
  );
  assert.deepEqual(await claude.inspect({ conversationId: id, view: "commands" }), {
    kind: "commands",
    commands: [{ name: "compact", description: "Summarize context", argumentHint: "<instructions>" }],
  });
  await assert.rejects(claude.conversationAction({ conversationId: id, action: "compact" }), /own \/compact/);
  const second = await turn(id, "continue", "plan");
  await done(second.runId);
  assert.equal(calls[1]!.options.resume, session);
  assert.equal(calls[1]!.options.model, "test-opus-5");
  assert.equal(calls[1]!.options.effort, "high");
  assert.equal(calls[1]!.options.permissionMode, "plan");
  assert.deepEqual(calls[1]!.options.settingSources, ["user", "project", "local"]);
  assert.match(JSON.stringify(calls[1]!.options.systemPrompt), /session-status.ts/);
  assert.equal(calls[1]!.options.env!.CLAUDE_CODE_OAUTH_TOKEN, undefined);
  assert.equal(calls[1]!.options.env!.ANTHROPIC_API_KEY, undefined);
  assert.deepEqual(calls[1]!.options.settings, { forceLoginMethod: "claudeai" });
  assert.equal(calls[1]!.options.persistSession, true);
  const plannedEdit = await calls[1]!.options.canUseTool!(
    "Edit",
    { file_path: "foo.ts" },
    { signal: new AbortController().signal, toolUseID: "test", requestId: "test" },
  );
  assert.ok(plannedEdit);
  assert.equal(plannedEdit.behavior, "deny");
});

test("background tasks keep the turn open and their notifications continue it", async () => {
  const { ctx, conversation, turn, done } = await setup();
  const id = await conversation();
  const run = await turn(id, "background");
  await done(run.runId);
  const items = listItems(ctx.db, id, null, 100).items;
  assert.deepEqual(
    items.map((i) => i.kind),
    ["user_message", "task", "agent_message"],
  );
  assert.equal(items[1]!.status, "completed");
  assert.deepEqual(items[1]!.data.task, {
    id: "agent-1",
    type: "local_agent",
    description: "Research",
    state: "completed",
    backgrounded: true,
    summary: "Reading sources",
    lastTool: "Grep",
    usage: { totalTokens: 10, toolUses: 2, durationMs: 500 },
    outputFile: "/tmp/a",
    error: null,
  });
  assert.equal(items[2]!.data.text, "Research finished.");
});

test("Claude user messages retain uploaded image references", async () => {
  const { ctx, conversation, turn, done } = await setup();
  const id = await conversation();
  const path = join(ctx.config.stateDir, "photo.png");
  writeFileSync(
    path,
    Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
      "base64",
    ),
  );
  const { runId } = await turn(id, `![Photo](<${path}>)`);
  await done(runId);
  const user = listItems(ctx.db, id, null, 100).items.find((i) => i.kind === "user_message")!;
  assert.equal(user.data.images?.[0]?.source, path);
  assert.ok(user.data.images?.[0]?.mediaId);
});

test("approvals and questions persist, validate replies, and accept only the first answer", async () => {
  const { ctx, claude, conversation, turn, done } = await setup();
  const id = await conversation();
  for (const prompt of ["approval", "question"]) {
    const run = await turn(id, prompt);
    await done(run.runId, "waiting_for_input");
    const row = ctx.db.get<{ id: string }>("SELECT id FROM pending_inputs WHERE run_id = :r AND state = 'open'", {
      r: run.runId,
    })!;
    await assert.rejects(claude.respond({ inputId: row.id, response: { kind: "decision", decision: "invalid" } }));
    assert.equal(getInput(ctx.db, row.id)!.state, "open");
    const response =
      prompt === "question"
        ? { kind: "answers" as const, answers: { "0": ["A", "custom"] } }
        : { kind: "decision" as const, decision: "accept" };
    await claude.respond({ inputId: row.id, response });
    await assert.rejects(claude.respond({ inputId: row.id, response }), /already answered/);
    await done(run.runId);
    const reply = JSON.parse(
      listItems(ctx.db, id, null, 100).items.find((i) => i.runId === run.runId && i.kind === "agent_message")!.data
        .text!,
    );
    assert.equal(reply.behavior, "allow");
    if (prompt === "question") assert.deepEqual(reply.updatedInput.answers, { "Pick one": "A, custom" });
  }
});

test("Never ask permits tools but still asks questions; denial is sent back to Claude", async () => {
  const { ctx, claude, conversation, turn, done } = await setup();
  const id = await conversation("never");
  const approval = await turn(id, "approval");
  await done(approval.runId);
  const question = await turn(id, "question");
  await done(question.runId, "waiting_for_input");
  await claude.interrupt({ conversationId: id, runId: question.runId });
  await done(question.runId, "cancelled");
  assert.equal(
    ctx.db.get<{ state: string }>("SELECT state FROM pending_inputs WHERE run_id = :r", { r: question.runId })!.state,
    "cancelled",
  );
  const other = await conversation();
  const denied = await turn(other, "approval");
  await done(denied.runId, "waiting_for_input");
  const row = ctx.db.get<{ id: string }>("SELECT id FROM pending_inputs WHERE run_id = :r", { r: denied.runId })!;
  await claude.respond({ inputId: row.id, response: { kind: "decision", decision: "decline" } });
  await done(denied.runId);
  assert.equal(
    JSON.parse(listItems(ctx.db, other, null, 100).items.find((i) => i.kind === "agent_message")!.data.text!).behavior,
    "deny",
  );
});

test("process loss and explicit errors never claim success, and interruption stops an active query", async () => {
  const { ctx, claude, conversation, turn, done } = await setup();
  const id = await conversation();
  for (const [prompt, state] of [
    ["crash", "interrupted"],
    ["throw", "failed"],
    ["error", "failed"],
  ]) {
    const run = await turn(id, prompt);
    await done(run.runId, state);
    assert.ok(getRun(ctx.db, run.runId)!.error);
  }
  const run = await turn(id, "hang");
  await done(run.runId, "running");
  await assert.rejects(claude.deleteConversation({ conversationId: id }), /Stop the active/);
  await claude.interrupt({ conversationId: id, runId: run.runId });
  await done(run.runId, "cancelled");
  await claude.deleteConversation({ conversationId: id });
  assert.equal(getConversation(ctx.db, id), undefined);
});

test("mixed providers run concurrently while each conversation keeps its own queue", async () => {
  const { ctx, claude, workspaceId, conversation, turn, done } = await setup();
  const codex = new CodexProvider(ctx);
  const handlers = agentHandlers(ctx, codex, claude);
  await codex.start();
  cleanup.unshift(() => codex.stop());
  const claudeId = await conversation();
  const codexId = (await codex.createConversation({ workspaceId, provider: "codex", approvalPolicy: "never" }))
    .conversationId;
  const first = await codex.submitTurn({ conversationId: codexId, text: "hang", mode: "default" });
  await waitFor(() => getRun(ctx.db, first.runId)!.state === "running");
  const second = await turn(claudeId, "hang");
  assert.equal(second.queued, false);
  await done(second.runId, "running");
  const queued = await turn(claudeId, "continue");
  assert.equal(queued.queued, true);
  const anotherClaudeId = await conversation();
  const independent = await turn(anotherClaudeId);
  assert.equal(independent.queued, false);
  await done(independent.runId);
  await codex.reconcile();
  assert.equal(getRun(ctx.db, second.runId)!.state, "running");
  await claude.interrupt({ conversationId: claudeId, runId: second.runId });
  await done(queued.runId);
  assert.equal(getRun(ctx.db, first.runId)!.state, "running");
  const command = {} as Parameters<NonNullable<(typeof handlers)["conversation.inspect"]>["run"]>[1];
  await assert.rejects(
    handlers["conversation.inspect"]!.run({ conversationId: claudeId, view: "status" }, command),
    /slash menu/,
  );
  await codex.interrupt({ conversationId: codexId, runId: first.runId });
  await done(first.runId, "cancelled");
});

test("restart interrupts stale Claude turns, preserves sessions, and leaves Codex runs alone", async () => {
  const { ctx, claude, conversation, turn, done } = await setup();
  const id = await conversation();
  const run = await turn(id, "hang");
  await done(run.runId, "running");
  const session = getConversation(ctx.db, id)!.providerThreadId;
  await claude.stop();
  assert.equal(getRun(ctx.db, run.runId)!.state, "interrupted");
  const stale = { ...getRun(ctx.db, run.runId)!, id: uuidv7(), state: "running" as const, endedAt: null };
  saveRun(ctx.db, stale, "old-worker");
  const restarted = new ClaudeProvider(ctx, fakeQuery());
  await restarted.start();
  cleanup.unshift(() => restarted.stop());
  assert.equal(getRun(ctx.db, stale.id)!.state, "interrupted");
  const next = await restarted.submitTurn({ conversationId: id, text: "continue", mode: "default" });
  await done(next.runId);
  assert.equal(getConversation(ctx.db, id)!.providerThreadId, session);
});

test("missing subscription login disables Claude even when an API key is present", async () => {
  const { ctx, claude } = await setup();
  process.env.FAKE_CLAUDE_AUTH = "logged-out";
  try {
    const disabled = new ClaudeProvider(ctx, () => {
      throw new Error("must not start SDK");
    });
    await disabled.start();
    assert.equal(disabled.status.state, "unavailable");
    await assert.rejects(
      disabled.createConversation({ workspaceId: "any", provider: "claude", approvalPolicy: "never" }),
      /claude auth login/,
    );
  } finally {
    delete process.env.FAKE_CLAUDE_AUTH;
  }
  assert.equal(claude.status.state, "ready");
});
