// Provider lifecycle against the scripted fake app-server (fake-codex.mjs).
import assert from "node:assert/strict";
import { after, test } from "node:test";
import { getRun, listItems } from "@workbench/db";
import { CodexProvider } from "../src/codex/provider.ts";
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

test("competing turns in one workspace queue and run in order", async () => {
  const { ctx, codex, conv } = await setup();
  const [a, b] = [await conv(), await conv()];
  const first = await codex.submitTurn({ conversationId: a, text: "hang", mode: "default" });
  await waitFor(() => runState(ctx, first.runId) === "running");
  const second = await codex.submitTurn({ conversationId: b, text: "hello", mode: "default" });
  assert.equal(second.queued, true);
  assert.equal(runState(ctx, second.runId), "queued");
  await assert.rejects(
    codex.submitTurn({ conversationId: a, text: "again", mode: "default" }),
    /already active in this conversation/,
  );
  await codex.interrupt({ conversationId: a, runId: first.runId });
  await waitFor(() => runState(ctx, second.runId) === "succeeded");
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
