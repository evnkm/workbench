// Provider lifecycle against the scripted fake app-server (fake-codex.mjs).
import assert from "node:assert/strict";
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { after, test } from "node:test";
import type { InspectResult } from "@workbench/contracts";
import {
  getCommand,
  getConversation,
  getRun,
  insertCommand,
  listItems,
  saveItem,
  updateConversation,
  updateRun,
} from "@workbench/db";
import { readRetainedImage } from "@workbench/runtime";
import { CodexProvider } from "../src/codex/provider.ts";
import { CommandLoop } from "../src/commands.ts";
import { Workspaces } from "../src/workspaces.ts";
import { makeContext, makeRepo, waitFor } from "./helpers.ts";

const providers: CodexProvider[] = [];
after(async () => {
  for (const p of providers) await p.stop();
});

async function setup() {
  const ctx = makeContext();
  const ws = new Workspaces(ctx);
  const codex = new CodexProvider(ctx);
  providers.push(codex);
  await codex.start();
  const { projectId } = await ws.registerProject({ path: makeRepo() });
  const { workspaceId } = await ws.createWorkspace({ projectId, name: "W" });
  const conv = async () =>
    (await codex.createConversation({ workspaceId, provider: "codex", approvalPolicy: "untrusted" })).conversationId;
  return { ctx, codex, workspaceId, conv };
}

const runState = (ctx: ReturnType<typeof makeContext>, id: string) => getRun(ctx.db, id)!.state;

test("a turn streams items and records success; the user message is not duplicated", async () => {
  const { ctx, codex, conv } = await setup();
  const c = await conv();
  const { runId } = await codex.submitTurn({ conversationId: c, text: "hello", mode: "default" });
  await waitFor(() => runState(ctx, runId) === "succeeded");
  const { items } = listItems(ctx.db, c, null, 100);
  assert.deepEqual(
    items.map((i) => i.kind),
    ["user_message", "agent_message"],
  );
  assert.equal(items[1]!.data.text, "Done.");
});

test("account model choices validate persistent inference settings and apply them at each turn boundary", async () => {
  const { ctx, codex, conv } = await setup();
  const conversationId = await conv();
  const loop = new CommandLoop(ctx);
  loop.register(codex.handlers());
  const { command } = insertCommand(ctx.db, "models", "conversation.inspect", { conversationId, view: "models" });
  loop.wake();
  await waitFor(() => getCommand(ctx.db, command.id)!.state === "succeeded");
  const menu = getCommand(ctx.db, command.id)!.result as InspectResult;
  assert.equal(menu.kind, "models");
  if (menu.kind !== "models") assert.fail("Expected model choices");
  assert.deepEqual(
    menu.models.map((m) => m.model),
    ["fake-model", "other-model"],
  );
  await codex.configureConversation({
    conversationId,
    model: "fake-model",
    reasoningEffort: "high",
    serviceTier: "priority",
  });
  for (const invalid of [{ model: "unknown" }, { reasoningEffort: "unsupported" }, { serviceTier: "unknown" }]) {
    await assert.rejects(
      codex.configureConversation({ conversationId, ...invalid }),
      /not available|does not support|does not offer/,
    );
  }
  const report = async (mode: "default" | "plan") => {
    const { runId } = await codex.submitTurn({ conversationId, text: "report settings", mode });
    await waitFor(() => runState(ctx, runId) === "succeeded");
    return JSON.parse(
      listItems(ctx.db, conversationId, null, 100).items.find((i) => i.runId === runId && i.kind === "agent_message")!
        .data.text!,
    );
  };
  const planned = await report("plan");
  assert.equal(planned.model, "fake-model");
  assert.equal(planned.effort, "high");
  assert.equal(planned.serviceTier, "priority");
  assert.equal(planned.collaborationMode.mode, "plan");
  assert.equal(planned.collaborationMode.settings.reasoning_effort, "high");
  assert.match(planned.collaborationMode.settings.developer_instructions, /session-status.ts/);
  assert.match(planned.collaborationMode.settings.developer_instructions, /Preserve edits made by other sessions/);
  const running = await codex.submitTurn({ conversationId, text: "hang", mode: "default" });
  await waitFor(() => runState(ctx, running.runId) === "running");
  await codex.configureConversation({ conversationId, approvalPolicy: "never", serviceTier: null });
  assert.equal(runState(ctx, running.runId), "running");
  await codex.interrupt({ conversationId, runId: running.runId });
  await waitFor(() => runState(ctx, running.runId) === "cancelled");
  await codex.stop();
  const restarted = new CodexProvider(ctx);
  providers.push(restarted);
  await restarted.start();
  const next = await restarted.submitTurn({ conversationId, text: "report settings", mode: "default" });
  await waitFor(() => runState(ctx, next.runId) === "succeeded");
  const applied = JSON.parse(
    listItems(ctx.db, conversationId, null, 100).items.find(
      (i) => i.runId === next.runId && i.kind === "agent_message",
    )!.data.text!,
  );
  assert.equal(applied.model, "fake-model");
  assert.equal(applied.effort, "high");
  assert.equal(applied.serviceTier, null);
  assert.equal(applied.approvalPolicy, "never");
  assert.equal(applied.collaborationMode.mode, "default");
  await restarted.configureConversation({ conversationId, model: "other-model" });
  assert.equal(getConversation(ctx.db, conversationId)!.reasoningEffort, "low");
  assert.equal(getConversation(ctx.db, conversationId)!.serviceTier, null);
  await assert.rejects(restarted.configureConversation({ conversationId, serviceTier: "priority" }), /does not offer/);
  await loop.stop();
});

test("slash inspections use the native inventory and usage endpoints", async () => {
  const { ctx, codex, conv } = await setup();
  const conversationId = await conv();
  const loop = new CommandLoop(ctx);
  loop.register(codex.handlers());
  for (const view of ["status", "skills", "apps", "mcp", "plugins", "hooks", "usage"]) {
    const { command } = insertCommand(ctx.db, `inspect-${view}`, "conversation.inspect", { conversationId, view });
    loop.wake();
    const finished = await waitFor(() => {
      const current = getCommand(ctx.db, command.id)!;
      return current.state === "succeeded" || current.state === "failed" ? current : false;
    });
    assert.equal(finished.state, "succeeded", finished.error ?? "Inspection failed");
    const result = finished.result as InspectResult;
    assert.equal(result.kind, view === "skills" || view === "apps" ? "choices" : "info");
    if (result.kind === "info") assert.ok(result.rows.length);
    if (result.kind === "choices") assert.ok(result.choices.length);
  }
  await loop.stop();
});

test("native review, compaction, and forks retain their provider and history contracts", async () => {
  const { ctx, codex, conv } = await setup();
  const conversationId = await conv();
  await codex.configureConversation({
    conversationId,
    model: "fake-model",
    reasoningEffort: "high",
    serviceTier: "priority",
  });
  const { runId } = await codex.submitTurn({
    conversationId,
    text: "Review against main",
    mode: "review",
    reviewTarget: { type: "baseBranch", branch: "main" },
  });
  await waitFor(() => runState(ctx, runId) === "succeeded");
  const review = JSON.parse(
    listItems(ctx.db, conversationId, null, 100).items.find((i) => i.kind === "agent_message")!.data.text!,
  );
  assert.deepEqual(review.target, { type: "baseBranch", branch: "main" });
  assert.equal(review.model, "fake-model");
  assert.equal(review.effort, "high");
  assert.equal(review.serviceTier, "priority");
  await codex.conversationAction({ conversationId, action: "compact" });
  await waitFor(() =>
    listItems(ctx.db, conversationId, null, 100).items.some(
      (i) => i.data.providerType === "contextCompaction" || i.data.text?.includes("compacted"),
    ),
  );
  updateConversation(ctx.db, conversationId, { title: "Original" });
  const before = listItems(ctx.db, conversationId, null, 200).items;
  const fork = await codex.conversationAction({ conversationId, action: "fork" });
  const saved = getConversation(ctx.db, fork.conversationId)!;
  assert.notEqual(saved.providerThreadId, getConversation(ctx.db, conversationId)!.providerThreadId);
  assert.equal(saved.title, "Fork of Original");
  assert.equal(saved.reasoningEffort, "high");
  assert.equal(saved.serviceTier, "priority");
  const after = listItems(ctx.db, fork.conversationId, null, 200).items;
  assert.deepEqual(
    after.map((i) => i.data),
    before.map((i) => i.data),
  );
  assert.ok(after.every((i) => i.runId === null && !before.some((old) => old.id === i.id)));
  const active = await codex.submitTurn({ conversationId, text: "hang", mode: "default" });
  await waitFor(() => runState(ctx, active.runId) === "running");
  for (const action of ["fork", "compact"] as const)
    await assert.rejects(codex.conversationAction({ conversationId, action }), /current turn/);
  await codex.conversationAction({ conversationId, action: "stop-background" });
  await codex.interrupt({ conversationId, runId: active.runId });
});

test("deleting a completed conversation is durable, idempotent, and rejects subsequent turns", async () => {
  const { ctx, codex, conv } = await setup();
  const conversationId = await conv();
  const { runId } = await codex.submitTurn({ conversationId, text: "hello", mode: "default" });
  await waitFor(() => runState(ctx, runId) === "succeeded");
  const loop = new CommandLoop(ctx);
  loop.register(codex.handlers());
  const { command } = insertCommand(ctx.db, "delete-conversation", "conversation.delete", { conversationId });
  loop.wake();
  await waitFor(() => getCommand(ctx.db, command.id)!.state === "succeeded");
  await loop.stop();
  assert.equal(getConversation(ctx.db, conversationId), undefined);
  assert.equal(getRun(ctx.db, runId), undefined);
  assert.deepEqual(listItems(ctx.db, conversationId, null, 100).items, []);
  await codex.deleteConversation({ conversationId });
  await assert.rejects(codex.submitTurn({ conversationId, text: "hello", mode: "default" }), /Conversation not found/);
});

test("independently active conversations cannot be deleted until stopped", async () => {
  const { ctx, codex, conv } = await setup();
  const [a, b] = [await conv(), await conv()];
  const first = await codex.submitTurn({ conversationId: a, text: "please approve", mode: "default" });
  await waitFor(() => runState(ctx, first.runId) === "waiting_for_input");
  const second = await codex.submitTurn({ conversationId: b, text: "hang", mode: "default" });
  assert.equal(second.queued, false);
  await waitFor(() => runState(ctx, second.runId) === "running");
  for (const conversationId of [a, b]) {
    await assert.rejects(codex.deleteConversation({ conversationId }), /Stop the active or queued run/);
    assert.ok(getConversation(ctx.db, conversationId));
    assert.ok(listItems(ctx.db, conversationId, null, 100).items.length);
  }
  await codex.interrupt({ conversationId: b, runId: second.runId });
  await waitFor(() => runState(ctx, second.runId) === "cancelled");
  await codex.deleteConversation({ conversationId: b });
  await codex.interrupt({ conversationId: a, runId: first.runId });
  await waitFor(() => runState(ctx, first.runId) === "cancelled");
  await codex.deleteConversation({ conversationId: a });
  assert.equal(getConversation(ctx.db, a), undefined);
  assert.equal(getConversation(ctx.db, b), undefined);
});

test("image completion replay preserves retained screenshots after their temporary file disappears", async () => {
  const { ctx, codex, conv } = await setup();
  const conversationId = await conv();
  const source = join(ctx.config.stateDir, "screenshot.png");
  const bytes = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==",
    "base64",
  );
  writeFileSync(source, bytes);
  const { runId } = await codex.submitTurn({ conversationId, text: `image:${source}`, mode: "default" });
  const first = await waitFor(() =>
    listItems(ctx.db, conversationId, null, 100).items.find(
      (item) => item.kind === "image" && item.data.images?.[0]?.mediaId,
    ),
  );
  rmSync(source);
  await waitFor(() => runState(ctx, runId) === "succeeded");
  const replay = listItems(ctx.db, conversationId, null, 100).items.find((item) => item.id === first.id)!;
  assert.equal(replay.data.images?.[0]?.mediaId, first.data.images?.[0]?.mediaId);
  assert.equal(replay.data.images?.[0]?.error, undefined);
  assert.deepEqual(readRetainedImage(ctx.config.stateDir, replay.data.images![0]!.mediaId!).bytes, bytes);
});

test("an approval is answered once; a second answer is rejected as stale", async () => {
  const { ctx, codex, conv } = await setup();
  const c = await conv();
  const { runId } = await codex.submitTurn({ conversationId: c, text: "please approve", mode: "default" });
  const input = await waitFor(() =>
    ctx.db.get<{ id: string }>("SELECT id FROM pending_inputs WHERE run_id = :r AND state = 'open'", { r: runId }),
  );
  assert.equal(runState(ctx, runId), "waiting_for_input");
  const results = await Promise.allSettled([
    codex.respond({ inputId: input.id, response: { kind: "decision", decision: "accept" } }),
    codex.respond({ inputId: input.id, response: { kind: "decision", decision: "decline" } }),
  ]);
  assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
  assert.match(String((results.find((r) => r.status === "rejected") as PromiseRejectedResult).reason), /already/);
  await waitFor(() => runState(ctx, runId) === "succeeded");
  const cmd = listItems(ctx.db, c, null, 100).items.find((i) => i.kind === "command")!;
  assert.equal(cmd.status, "completed");
});

test("questions receive structured answers", async () => {
  const { ctx, codex, conv } = await setup();
  const c = await conv();
  const { runId } = await codex.submitTurn({ conversationId: c, text: "ask me", mode: "plan" });
  const input = await waitFor(() =>
    ctx.db.get<{ id: string }>("SELECT id FROM pending_inputs WHERE run_id = :r AND state = 'open'", { r: runId }),
  );
  await codex.respond({ inputId: input.id, response: { kind: "answers", answers: { color: ["blue"] } } });
  await waitFor(() => runState(ctx, runId) === "succeeded");
  assert.ok(listItems(ctx.db, c, null, 100).items.some((i) => i.data.text === "You chose blue."));
});

test("interrupt reaches the intended turn and a follow-up continues the conversation", async () => {
  const { ctx, codex, conv } = await setup();
  const c = await conv();
  const { runId } = await codex.submitTurn({ conversationId: c, text: "hang", mode: "default" });
  await waitFor(() => runState(ctx, runId) === "running");
  await waitFor(() => listItems(ctx.db, c, null, 100).items.some((i) => i.kind === "command"));
  await codex.interrupt({ conversationId: c, runId });
  await waitFor(() => runState(ctx, runId) === "cancelled");
  await assert.rejects(codex.interrupt({ conversationId: c, runId }), /already ended/);
  const next = await codex.submitTurn({ conversationId: c, text: "hello again", mode: "default" });
  await waitFor(() => runState(ctx, next.runId) === "succeeded");
});

test("separate conversations share a workspace concurrently and queue only their own follow-ups", async () => {
  const { ctx, codex, conv } = await setup();
  const [a, b] = [await conv(), await conv()];
  const first = await codex.submitTurn({ conversationId: a, text: "hang", mode: "default" });
  await waitFor(() => runState(ctx, first.runId) === "running");
  const second = await codex.submitTurn({ conversationId: b, text: "hello", mode: "default" });
  assert.equal(second.queued, false);
  await waitFor(() => runState(ctx, second.runId) === "succeeded");
  assert.equal(runState(ctx, first.runId), "running");
  const third = await codex.submitTurn({ conversationId: a, text: "again", mode: "default" });
  assert.equal(third.queued, true);
  await codex.interrupt({ conversationId: a, runId: first.runId });
  await waitFor(() => runState(ctx, second.runId) === "succeeded");
  await waitFor(() => runState(ctx, third.runId) === "succeeded");
});

test("same-conversation follow-ups survive restart, can be removed, and preserve FIFO transcript order", async () => {
  const { ctx, codex, conv } = await setup();
  const conversationId = await conv();
  const active = await codex.submitTurn({ conversationId, text: "hang", mode: "default" });
  await waitFor(() => runState(ctx, active.runId) === "running");
  const second = await codex.submitTurn({ conversationId, text: "hello second", mode: "default" });
  const removed = await codex.submitTurn({ conversationId, text: "never send this", mode: "default" });
  const third = await codex.submitTurn({ conversationId, text: "hello third", mode: "plan" });
  assert.equal(second.queued, true);
  assert.equal(third.queued, true);
  await codex.interrupt({ conversationId, runId: removed.runId });
  assert.equal(runState(ctx, removed.runId), "cancelled");
  assert.equal(runState(ctx, active.runId), "running");
  await codex.stop();
  const restarted = new CodexProvider(ctx);
  providers.push(restarted);
  await restarted.start();
  await waitFor(() => runState(ctx, third.runId) === "succeeded");
  assert.equal(runState(ctx, second.runId), "succeeded");
  assert.equal(runState(ctx, active.runId), "interrupted");
  assert.equal(getRun(ctx.db, removed.runId)!.providerTurnId, null);
  const items = listItems(ctx.db, conversationId, null, 100).items;
  const secondOutput = items.find((i) => i.runId === second.runId && i.kind === "agent_message")!;
  const thirdInput = items.find((i) => i.runId === third.runId && i.kind === "user_message")!;
  assert.ok(secondOutput.position < thirdInput.position);
  assert.equal(thirdInput.data.phase, "plan");
  assert.equal(items.filter((i) => i.runId === second.runId && i.kind === "user_message").length, 1);
});

test("queued messages steer the same running turn after a tool completes, in order and without duplicates", async () => {
  const { ctx, codex, conv } = await setup();
  const conversationId = await conv();
  const active = await codex.submitTurn({ conversationId, text: "hang boundary parallel", mode: "default" });
  await waitFor(() => listItems(ctx.db, conversationId, null, 100).items.some((i) => i.kind === "command"));
  const a = await codex.submitTurn({ conversationId, text: "First live instruction", mode: "default" });
  const b = await codex.submitTurn({ conversationId, text: "Second live instruction", mode: "default" });
  assert.equal(runState(ctx, a.runId), "queued");
  assert.equal(runState(ctx, b.runId), "queued");
  await waitFor(() => runState(ctx, b.runId) === "succeeded");
  assert.equal(runState(ctx, active.runId), "running");
  assert.ok(
    listItems(ctx.db, conversationId, null, 100).items.some((i) => i.kind === "command" && i.status === "in_progress"),
  );
  assert.equal(getRun(ctx.db, a.runId)!.providerTurnId, null);
  const items = listItems(ctx.db, conversationId, null, 100).items;
  const messages = items.filter((i) => i.kind === "user_message");
  assert.deepEqual(
    messages.map((i) => i.data.text),
    ["hang boundary parallel", "First live instruction", "Second live instruction"],
  );
  assert.ok(messages.every((i) => i.runId === active.runId));
  assert.ok(items.find((i) => i.kind === "command")!.position < messages[1]!.position);
  assert.equal(getRun(ctx.db, b.runId)!.stopReason, "delivered to live turn");
  await codex.interrupt({ conversationId, runId: active.runId });
});

test("a turn ending at the tool boundary leaves the rejected steer for the next turn", async () => {
  const { ctx, codex, conv } = await setup();
  const conversationId = await conv();
  const active = await codex.submitTurn({ conversationId, text: "hang boundary finish before steer", mode: "default" });
  await waitFor(() => listItems(ctx.db, conversationId, null, 100).items.some((i) => i.kind === "command"));
  const next = await codex.submitTurn({ conversationId, text: "Next instruction", mode: "default" });
  await waitFor(() => runState(ctx, next.runId) === "succeeded");
  assert.equal(runState(ctx, active.runId), "succeeded");
  assert.notEqual(getRun(ctx.db, active.runId)!.providerTurnId, getRun(ctx.db, next.runId)!.providerTurnId);
  assert.equal(
    listItems(ctx.db, conversationId, null, 100).items.filter((i) => i.data.text === "Next instruction").length,
    1,
  );
});

test("live steering preserves a queued mode change instead of ignoring its settings", async () => {
  const { ctx, codex, conv } = await setup();
  const conversationId = await conv();
  const active = await codex.submitTurn({ conversationId, text: "hang boundary", mode: "default" });
  await waitFor(() => listItems(ctx.db, conversationId, null, 100).items.some((i) => i.kind === "command"));
  const next = await codex.submitTurn({ conversationId, text: "Plan next work", mode: "plan" });
  await waitFor(() =>
    listItems(ctx.db, conversationId, null, 100).items.some((i) => i.kind === "command" && i.status === "completed"),
  );
  assert.equal(runState(ctx, next.runId), "queued");
  await codex.interrupt({ conversationId, runId: active.runId });
  await waitFor(() => runState(ctx, next.runId) === "succeeded");
});

test("an unconfirmed live delivery survives restart visibly and is never automatically replayed", async () => {
  const { ctx, codex, conv } = await setup();
  const conversationId = await conv();
  const active = await codex.submitTurn({ conversationId, text: "hang", mode: "default" });
  await waitFor(() => listItems(ctx.db, conversationId, null, 100).items.some((i) => i.kind === "command"));
  const queued = await codex.submitTurn({ conversationId, text: "Unconfirmed instruction", mode: "default" });
  const item = listItems(ctx.db, conversationId, null, 100).items.find((i) => i.runId === queued.runId)!;
  saveItem(ctx.db, {
    ...item,
    data: { ...item.data, steering: { runId: active.runId, turnId: getRun(ctx.db, active.runId)!.providerTurnId! } },
  });
  await codex.stop();
  const restarted = new CodexProvider(ctx);
  providers.push(restarted);
  await restarted.start();
  assert.equal(runState(ctx, queued.runId), "failed");
  assert.match(getRun(ctx.db, queued.runId)!.error!, /could not be confirmed after restart/);
  assert.equal(getRun(ctx.db, queued.runId)!.providerTurnId, null);
  assert.equal(
    listItems(ctx.db, conversationId, null, 100).items.filter((i) => i.data.text === "Unconfirmed instruction").length,
    1,
  );
  const replay = () =>
    (
      restarted as unknown as { onNotification: (method: string, params: Record<string, unknown>) => void }
    ).onNotification("item/completed", {
      threadId: getConversation(ctx.db, conversationId)!.providerThreadId,
      turnId: getRun(ctx.db, active.runId)!.providerTurnId,
      item: {
        type: "userMessage",
        id: "late-confirmation",
        clientId: item.id,
        content: [{ type: "text", text: item.data.text, text_elements: [] }],
      },
    });
  replay();
  assert.equal(runState(ctx, queued.runId), "succeeded");
  assert.equal(getRun(ctx.db, queued.runId)!.error, null);
  assert.equal(listItems(ctx.db, conversationId, null, 100).items.find((i) => i.id === item.id)!.runId, active.runId);
  updateRun(ctx.db, active.runId, { state: "failed", error: "Provider failure" });
  replay();
  assert.equal(runState(ctx, active.runId), "failed");
});

test("a provider failure becomes a failed run with history retained", async () => {
  const { ctx, codex, conv } = await setup();
  const c = await conv();
  const { runId } = await codex.submitTurn({ conversationId: c, text: "fail please", mode: "default" });
  await waitFor(() => runState(ctx, runId) === "failed");
  assert.equal(getRun(ctx.db, runId)!.error, "simulated failure");
  assert.ok(listItems(ctx.db, c, null, 100).items.some((i) => i.kind === "user_message"));
});

test("a provider crash interrupts the active turn and cancels its pending inputs", async () => {
  const { ctx, codex, conv } = await setup();
  const c = await conv();
  const { runId } = await codex.submitTurn({ conversationId: c, text: "please approve", mode: "default" });
  const input = await waitFor(() =>
    ctx.db.get<{ id: string }>("SELECT id FROM pending_inputs WHERE run_id = :r AND state = 'open'", { r: runId }),
  );
  // Kill the app-server process the provider owns.
  (codex as unknown as { server: { stop: (s: string) => void } }).server.stop("SIGKILL");
  await waitFor(() => runState(ctx, runId) === "interrupted", 10_000);
  const row = ctx.db.get<{ state: string }>("SELECT state FROM pending_inputs WHERE id = :id", { id: input.id })!;
  assert.equal(row.state, "cancelled");
  await assert.rejects(
    codex.respond({ inputId: input.id, response: { kind: "decision", decision: "accept" } }),
    /already cancelled/,
  );
  // The provider restarts and the conversation continues.
  await waitFor(() => codex.status.state === "ready", 10_000);
  const next = await codex.submitTurn({ conversationId: c, text: "hello", mode: "default" });
  await waitFor(() => runState(ctx, next.runId) === "succeeded");
});

test("an untested Codex version is refused", async () => {
  const ctx = makeContext();
  process.env.FAKE_CODEX_VERSION = "9.9.9";
  try {
    const codex = new CodexProvider(ctx);
    await codex.start();
    assert.equal(codex.status.state, "unavailable");
    assert.match(codex.status.error!, /tested against 0\.160\.0/);
  } finally {
    delete process.env.FAKE_CODEX_VERSION;
  }
});

test("after a worker restart, unconfirmed turns are reconciled as interrupted, never succeeded", async () => {
  const { ctx, codex, conv, workspaceId } = await setup();
  const c = await conv();
  const { runId } = await codex.submitTurn({ conversationId: c, text: "hang", mode: "default" });
  await waitFor(() => runState(ctx, runId) === "running");
  // Simulate the worker dying: a new provider instance takes over the same database.
  await codex.stop();
  const restarted = new CodexProvider(ctx);
  providers.push(restarted);
  await restarted.start();
  await waitFor(() => runState(ctx, runId) === "interrupted");
  assert.match(getRun(ctx.db, runId)!.error!, /could not be confirmed/);
  void workspaceId;
});
