#!/usr/bin/env node
import { randomUUID } from "node:crypto";
// Scripted Claude transport for the real SDK. No API calls or credentials.
import { createInterface } from "node:readline";

const send = (message) => process.stdout.write(`${JSON.stringify(message)}\n`);
const args = process.argv.slice(2);
if (args.includes("auth") && args.includes("status")) {
  const mode = process.env.FAKE_CLAUDE_AUTH ?? "subscription";
  if (mode === "malformed") console.log("invalid auth response");
  else
    console.log(
      JSON.stringify({
        loggedIn: mode !== "logged-out",
        authMethod: mode === "api-key" ? "api_key" : "claude.ai",
        apiProvider: "firstParty",
        subscriptionType: "max",
      }),
    );
  process.exit(mode === "logged-out" ? 1 : 0);
}
const session =
  args.find((arg) => arg.startsWith("--resume="))?.slice("--resume=".length) ??
  (args.includes("--resume") ? args[args.indexOf("--resume") + 1] : randomUUID());
let prompt = "";
const finish = (text) => {
  send({
    type: "assistant",
    session_id: session,
    uuid: randomUUID(),
    parent_tool_use_id: null,
    message: {
      id: randomUUID(),
      role: "assistant",
      model: "fake-sonnet",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
      usage: { input_tokens: 1, output_tokens: 1 },
    },
  });
  send({
    type: "result",
    subtype: "success",
    session_id: session,
    uuid: randomUUID(),
    is_error: false,
    result: text,
    duration_ms: 1,
    duration_api_ms: 1,
    num_turns: 1,
    total_cost_usd: 0,
    usage: { input_tokens: 1, output_tokens: 1 },
    modelUsage: {},
    permission_denials: [],
  });
};
const system = (subtype, fields) =>
  send({ type: "system", subtype, uuid: randomUUID(), session_id: session, ...fields });
createInterface({ input: process.stdin }).on("line", (line) => {
  const message = JSON.parse(line);
  if (message.type === "control_request" && message.request.subtype === "stop_task") {
    send({ type: "control_response", response: { subtype: "success", request_id: message.request_id, response: {} } });
    system("task_updated", { task_id: message.request.task_id, patch: { status: "killed" } });
    system("background_tasks_changed", { tasks: [] });
    system("task_notification", {
      task_id: message.request.task_id,
      status: "stopped",
      output_file: "/tmp/task.output",
      summary: "watch logs",
    });
    system("session_state_changed", { state: "idle" });
  } else if (message.type === "control_request") {
    send({
      type: "control_response",
      response: {
        subtype: "success",
        request_id: message.request_id,
        response: { commands: [], models: [], account: {} },
      },
    });
  } else if (message.type === "user") {
    prompt =
      typeof message.message.content === "string"
        ? message.message.content
        : message.message.content
            .filter((block) => block.type === "text")
            .map((block) => block.text)
            .join("\n");
    send({
      type: "system",
      subtype: "init",
      uuid: randomUUID(),
      session_id: session,
      model: "fake-sonnet",
      cwd: process.cwd(),
      tools: ["Bash", "AskUserQuestion"],
      mcp_servers: [],
      apiKeySource: "none",
      permissionMode: "default",
      slash_commands: [],
    });
    if (prompt === "hang") return;
    if (prompt === "background") {
      // A monitor outlives the reply; the turn waits until it is stopped.
      system("session_state_changed", { state: "running" });
      system("task_started", {
        task_id: "monitor-1",
        task_type: "monitor",
        description: "watch logs",
        is_backgrounded: true,
      });
      system("background_tasks_changed", {
        tasks: [{ task_id: "monitor-1", task_type: "monitor", description: "watch logs" }],
      });
      finish("Watching.");
      system("session_state_changed", { state: "idle" });
      return;
    }
    if (prompt === "crash") {
      process.exit(2);
      return;
    }
    if (prompt === "approval" || prompt === "question") {
      send({
        type: "control_request",
        request_id: "ask-1",
        request: {
          subtype: "can_use_tool",
          tool_name: prompt === "approval" ? "Bash" : "AskUserQuestion",
          input:
            prompt === "approval"
              ? { command: "pwd" }
              : {
                  questions: [
                    {
                      header: "Color",
                      question: "Which color?",
                      multiSelect: true,
                      options: [
                        { label: "Blue", description: "Blue" },
                        { label: "Red", description: "Red" },
                      ],
                    },
                  ],
                },
          tool_use_id: "tool-1",
        },
      });
    } else finish("SDK transport works.");
  } else if (message.type === "control_response" && message.response.request_id === "ask-1") {
    finish(JSON.stringify(message.response.response));
  }
});
