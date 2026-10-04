#!/usr/bin/env node
// A scripted stand-in for `codex app-server` implementing the subset of the
// protocol observed in probes/codex/samples. The prompt text selects behavior:
//   "approve"  -> asks for command approval, then completes
//   "ask"      -> asks a question (requestUserInput), then echoes the answer
//   "hang"     -> starts a command and never finishes until interrupted
//   "fail"     -> completes the turn with status failed
//   otherwise  -> streams a short agent message and completes
import { createInterface } from "node:readline";

if (process.argv[2] === "--version") {
  console.log(`codex-cli ${process.env.FAKE_CODEX_VERSION ?? "0.160.0"}`);
  process.exit(0);
}

let n = 0;
const id = (p) => `${p}-${process.pid}-${++n}`;
const threads = new Map();
const pending = new Map();
let nextReq = 0;
const send = (m) => process.stdout.write(`${JSON.stringify(m)}\n`);
const notify = (method, params) => send({ method, params });
const request = (method, params) =>
  new Promise((resolve) => {
    const rid = nextReq++;
    pending.set(rid, resolve);
    send({ id: rid, method, params });
  });

function finish(thread, turn, status, error = null) {
  if (turn.done) return;
  turn.done = true;
  turn.status = status;
  thread.active = null;
  notify("thread/status/changed", { threadId: thread.id, status: { type: "idle" } });
  notify("turn/completed", {
    threadId: thread.id,
    turn: {
      id: turn.id,
      items: [],
      itemsView: "notLoaded",
      status,
      error,
      startedAt: 0,
      completedAt: 1,
      durationMs: 1,
    },
  });
}

async function runTurn(thread, turn, text, clientId) {
  const t = { threadId: thread.id, turnId: turn.id };
  notify("turn/started", { threadId: thread.id, turn: { id: turn.id, items: [], status: "inProgress" } });
  notify("thread/status/changed", { threadId: thread.id, status: { type: "active", activeFlags: [] } });
  const user = { type: "userMessage", id: id("user"), clientId, content: [{ type: "text", text, text_elements: [] }] };
  notify("item/started", { ...t, item: user });
  notify("item/completed", { ...t, item: user });
  turn.items.push(user);

  if (text.includes("fail")) return finish(thread, turn, "failed", { message: "simulated failure" });
  if (text.includes("approve")) {
    const cmd = {
      type: "commandExecution",
      id: id("exec"),
      command: "/bin/bash -lc 'touch approved.txt'",
      cwd: thread.cwd,
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
      processId: null,
      source: "agent",
      pluginId: null,
      scriptPath: null,
    };
    notify("item/started", { ...t, item: cmd });
    notify("thread/status/changed", {
      threadId: thread.id,
      status: { type: "active", activeFlags: ["waitingOnApproval"] },
    });
    const res = await request("item/commandExecution/requestApproval", {
      ...t,
      itemId: cmd.id,
      kind: "command",
      command: cmd.command,
      cwd: thread.cwd,
      startedAtMs: Date.now(),
      environmentId: "local",
      availableDecisions: ["accept", "cancel"],
    });
    if (turn.done) return;
    notify("serverRequest/resolved", { threadId: thread.id, requestId: nextReq - 1 });
    notify("thread/status/changed", { threadId: thread.id, status: { type: "active", activeFlags: [] } });
    const accepted = res.decision === "accept";
    notify("item/completed", {
      ...t,
      item: {
        ...cmd,
        status: accepted ? "completed" : "declined",
        aggregatedOutput: accepted ? "" : null,
        exitCode: accepted ? 0 : null,
      },
    });
  }
  let reply = "Done.";
  if (text.includes("ask")) {
    const res = await request("item/tool/requestUserInput", {
      ...t,
      itemId: id("q"),
      isBlocking: true,
      autoResolutionMs: null,
      questions: [
        {
          id: "color",
          header: "Color",
          question: "Pick one",
          isOther: false,
          isSecret: false,
          options: [
            { label: "red", description: "" },
            { label: "blue", description: "" },
          ],
        },
      ],
    });
    if (turn.done) return;
    reply = `You chose ${res.answers.color.answers[0]}.`;
  }
  if (text.includes("hang")) {
    const cmd = {
      type: "commandExecution",
      id: id("exec"),
      command: "sleep 1000",
      cwd: thread.cwd,
      status: "inProgress",
      commandActions: [],
      aggregatedOutput: null,
      exitCode: null,
      durationMs: null,
      processId: null,
      source: "agent",
      pluginId: null,
      scriptPath: null,
    };
    notify("item/started", { ...t, item: cmd });
    notify("item/commandExecution/outputDelta", { ...t, itemId: cmd.id, delta: "working\n" });
    return; // waits for turn/interrupt
  }
  const msg = {
    type: "agentMessage",
    id: id("msg"),
    text: "",
    phase: "final_answer",
    memoryCitation: null,
    delivery: null,
    questions: null,
  };
  notify("item/started", { ...t, item: msg });
  for (const part of reply.match(/.{1,3}/g)) notify("item/agentMessage/delta", { ...t, itemId: msg.id, delta: part });
  const done = { ...msg, text: reply };
  notify("item/completed", { ...t, item: done });
  turn.items.push(done);
  finish(thread, turn, "completed");
}

createInterface({ input: process.stdin }).on("line", (line) => {
  const m = JSON.parse(line);
  if (m.method === undefined && m.id !== undefined) {
    const r = pending.get(m.id);
    pending.delete(m.id);
    r?.(m.result);
    return;
  }
  const p = m.params ?? {};
  const reply = (result) => send({ id: m.id, result });
  switch (m.method) {
    case "initialize":
      return reply({ userAgent: "fake-codex/0.160.0", codexHome: "/tmp", platformFamily: "unix", platformOs: "linux" });
    case "initialized":
      return;
    case "thread/start": {
      const th = { id: id("thread"), cwd: p.cwd, turns: [], active: null };
      threads.set(th.id, th);
      return reply({ thread: { id: th.id, turns: [] }, model: "fake-model", cwd: p.cwd });
    }
    case "thread/resume": {
      if (!threads.has(p.threadId)) threads.set(p.threadId, { id: p.threadId, cwd: p.cwd, turns: [], active: null });
      return reply({ thread: { id: p.threadId, turns: [], status: { type: "idle" } } });
    }
    case "thread/turns/list": {
      const th = threads.get(p.threadId);
      return reply({
        data: (th?.turns ?? []).map((t) => ({ id: t.id, items: t.items, status: t.status, error: null })),
        nextCursor: null,
      });
    }
    case "turn/start": {
      const th = threads.get(p.threadId);
      const turn = { id: id("turn"), items: [], status: "inProgress", done: false };
      th.turns.push(turn);
      th.active = turn;
      reply({ turn: { id: turn.id, items: [], status: "inProgress" } });
      void runTurn(th, turn, p.input[0].text, p.clientUserMessageId);
      return;
    }
    case "turn/interrupt": {
      const th = threads.get(p.threadId);
      const turn = th?.turns.find((t) => t.id === p.turnId);
      // Like the real server: no reply for a turn that is not active.
      if (!turn || turn.done) return;
      reply({});
      finish(th, turn, "interrupted");
      return;
    }
    default:
      return send({ id: m.id, error: { code: -32601, message: `fake: ${m.method} unsupported` } });
  }
});
