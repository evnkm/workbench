// Phase 0 Codex app-server scenarios. Usage:
//   node scenarios.mjs <scenario> <repoDir> <outDir> [threadId]
// Scenarios: basic, approval, interrupt, resume, kill, userinput
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { startAppServer } from "./client.mjs";

const [scenario, repo, outDir, threadIdArg] = process.argv.slice(2);
mkdirSync(outDir, { recursive: true });
const transcript = join(outDir, `${scenario}-${Date.now()}.jsonl`);
const s = startAppServer({ transcript });
const log = (...a) => console.log(`[${scenario}]`, ...a);

// Summarize notifications as they arrive.
s.onMessage((m) => {
  if (m.method === "item/agentMessage/delta" || m.method?.endsWith("Delta")) return;
  const p = m.params ?? {};
  const item = p.item ? `${p.item.type}:${p.item.status ?? ""}` : "";
  log(m.id !== undefined ? `REQ#${m.id}` : "NOTE", m.method, item, p.turn?.status ?? "");
});

const text = (t) => [{ type: "text", text: t, text_elements: [] }];
const turnDone = (threadId) => (m) => m.method === "turn/completed" && m.params.threadId === threadId;

async function main() {
  const init = await s.initialize();
  log("initialize ->", init.userAgent);

  if (scenario === "basic") {
    const { thread, model } = await s.request("thread/start", {
      cwd: repo,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    log("thread", thread.id, "model", model);
    const done = s.waitFor(turnDone(thread.id));
    const { turn } = await s.request("turn/start", {
      threadId: thread.id,
      input: text(
        "Add a `subtract(a, b)` export to math.js. Keep it minimal. Then run `node -e \"import('./math.js').then(m=>console.log(m.subtract(5,3)))\"` to verify.",
      ),
    });
    log("turn started", turn.id, turn.status);
    const c = await done;
    log("turn completed", c.params.turn.status, c.params.turn.error?.message ?? "");
  }

  if (scenario === "approval") {
    // Ask for approval on every command and file change.
    const { thread } = await s.request("thread/start", {
      cwd: repo,
      approvalPolicy: "untrusted",
      sandbox: "danger-full-access",
    });
    log("thread", thread.id);
    let answered = 0;
    s.onMessage((m) => {
      if (m.id === undefined || !m.method) return;
      if (m.method.endsWith("requestApproval")) {
        log(
          "approval request",
          JSON.stringify({
            method: m.method,
            command: m.params.command,
            reason: m.params.reason,
            itemId: m.params.itemId,
          }),
        );
        // Decline the first request, accept later ones to see both outcomes.
        const decision = answered++ === 0 ? "decline" : "accept";
        log("responding", decision);
        s.respond(m.id, { decision });
        // A second response to the same request id should be ignored or rejected.
        setTimeout(() => s.respond(m.id, { decision: "accept" }), 200);
      }
    });
    const done = s.waitFor(turnDone(thread.id));
    await s.request("turn/start", {
      threadId: thread.id,
      input: text(
        "Create a file named approval.txt containing the word approved, using a shell command such as `echo approved > approval.txt`. If a command is declined, try once more.",
      ),
    });
    const c = await done;
    log("turn completed", c.params.turn.status);
  }

  if (scenario === "interrupt") {
    const { thread } = await s.request("thread/start", {
      cwd: repo,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    const done = s.waitFor(turnDone(thread.id));
    const { turn } = await s.request("turn/start", {
      threadId: thread.id,
      input: text("Run the shell command `sleep 60 && echo finished` and report its output."),
    });
    await s.waitFor((m) => m.method === "item/started" && m.params.item.type === "commandExecution");
    log("command started; interrupting turn", turn.id);
    const t0 = Date.now();
    const r = await s.request("turn/interrupt", { threadId: thread.id, turnId: turn.id });
    log("interrupt response", JSON.stringify(r));
    const c = await done;
    log("turn completed", c.params.turn.status, "after", Date.now() - t0, "ms");
    // A stale interrupt for the finished turn.
    try {
      const timeout = new Promise((r) => setTimeout(() => r("NO RESPONSE within 5s"), 5000));
      log(
        "stale interrupt",
        JSON.stringify(
          await Promise.race([s.request("turn/interrupt", { threadId: thread.id, turnId: turn.id }), timeout]),
        ),
      );
    } catch (e) {
      log("stale interrupt error", JSON.stringify(e.rpc));
    }
    // Follow-up in the same thread.
    const done2 = s.waitFor(turnDone(thread.id));
    await s.request("turn/start", { threadId: thread.id, input: text("Reply with only the word ready.") });
    log("follow-up", (await done2).params.turn.status);
    console.log("THREAD_ID", thread.id);
  }

  if (scenario === "resume") {
    const r = await s.request("thread/resume", { threadId: threadIdArg, cwd: repo, excludeTurns: true });
    log("resumed", r.thread.id, "status", JSON.stringify(r.thread.status));
    const turns = await s.request("thread/turns/list", {
      threadId: threadIdArg,
      limit: 10,
      sortDirection: "asc",
      itemsView: "full",
    });
    for (const t of turns.data) log("history turn", t.id, t.status, t.items.map((i) => i.type).join(","));
    const done = s.waitFor(turnDone(threadIdArg));
    await s.request("turn/start", {
      threadId: threadIdArg,
      input: text("In one sentence, what did I ask you to do in my first message in this conversation?"),
    });
    const c = await done;
    log("turn completed", c.params.turn.status);
  }

  if (scenario === "kill") {
    // Kill the app-server mid-command, then inspect the thread from a fresh process.
    const { thread } = await s.request("thread/start", {
      cwd: repo,
      approvalPolicy: "never",
      sandbox: "danger-full-access",
    });
    await s.request("turn/start", {
      threadId: thread.id,
      input: text("Run `sleep 45 && echo survived > killed.txt` and report."),
    });
    await s.waitFor((m) => m.method === "item/started" && m.params.item.type === "commandExecution");
    log("killing app-server with SIGKILL");
    s.child.kill("SIGKILL");
    log("exit", JSON.stringify(await s.exited));
    const s2 = startAppServer({ transcript });
    await s2.initialize();
    const r = await s2.request("thread/resume", { threadId: thread.id, cwd: repo, excludeTurns: true });
    log("after kill: thread status", JSON.stringify(r.thread.status));
    const turns = await s2.request("thread/turns/list", { threadId: thread.id, limit: 10, itemsView: "full" });
    for (const t of turns.data)
      log(
        "after kill: turn",
        t.id,
        t.status,
        JSON.stringify(t.error),
        t.items.map((i) => `${i.type}:${i.status ?? ""}`).join(","),
      );
    s2.close();
    await s2.exited;
    console.log("THREAD_ID", thread.id);
    return;
  }

  if (scenario === "userinput") {
    const { thread } = await s.request("thread/start", { cwd: repo, approvalPolicy: "never", sandbox: "read-only" });
    s.onMessage((m) => {
      if (m.id !== undefined && m.method === "item/tool/requestUserInput") {
        log("user input request", JSON.stringify(m.params.questions));
        const answers = {};
        for (const q of m.params.questions) answers[q.id] = { answers: [q.options?.[0]?.label ?? "blue"] };
        s.respond(m.id, { answers });
      }
    });
    const done = s.waitFor(turnDone(thread.id));
    const { model } = await s
      .request("thread/read", { threadId: thread.id })
      .then(() => ({ model: process.env.PROBE_MODEL ?? "gpt-6.1-sol" }));
    await s.request("turn/start", {
      threadId: thread.id,
      collaborationMode: { mode: "plan", settings: { model, reasoning_effort: null, developer_instructions: null } },
      input: text(
        "Before answering, use your request_user_input tool (if you have one) to ask me which colour I prefer, offering red and blue. Then tell me my answer. If you have no such tool, say NO_TOOL.",
      ),
    });
    const c = await done;
    const msg = c.params.turn.items
      ?.filter((i) => i.type === "agentMessage")
      .map((i) => i.text)
      .join(" ");
    log("turn completed", c.params.turn.status, msg);
  }

  s.close();
  await s.exited;
}

main().catch((e) => {
  console.error(e);
  s.child.kill();
  process.exit(1);
});
