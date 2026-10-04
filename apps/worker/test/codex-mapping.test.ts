// Provider event mapping, checked against the redacted transcripts recorded
// from the real Codex 0.160.0 app-server in Phase 0.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { test } from "node:test";
import { mapItem, mapServerRequest, replyFor, runStateForTurn, unwrapShell } from "../src/codex/mapping.ts";
import type { ThreadItem } from "../src/codex/protocol/v2/ThreadItem.ts";

const samples = join(import.meta.dirname, "../../../probes/codex/samples");
type Rec = { dir: string; msg: { method?: string; id?: number; params?: Record<string, unknown> } };
const load = (name: string): Rec[] =>
  readFileSync(join(samples, `${name}.jsonl`), "utf8")
    .trim()
    .split("\n")
    .map((l) => JSON.parse(l));

test("every completed item in the recorded sessions maps to a known kind", () => {
  for (const name of ["basic", "approval", "interrupt", "resume", "kill", "userinput"]) {
    for (const r of load(name)) {
      if (r.dir !== "in" || r.msg.method !== "item/completed") continue;
      const item = r.msg.params!.item as ThreadItem;
      const mapped = mapItem(item, true);
      assert.notEqual(mapped.kind, "other", `${name}: ${item.type} mapped to other`);
      if (item.type === "agentMessage") assert.equal(mapped.data.text, item.text);
    }
  }
});

test("file changes keep their path and diff", () => {
  const rec = load("basic").find(
    (r) => r.msg.method === "item/completed" && (r.msg.params!.item as ThreadItem).type === "fileChange",
  )!;
  const mapped = mapItem(rec.msg.params!.item as ThreadItem, true);
  assert.equal(mapped.kind, "file_change");
  assert.equal(mapped.status, "completed");
  assert.equal(typeof mapped.data.changes![0]!.path, "string");
  assert.match(mapped.data.changes![0]!.diff, /subtract/);
});

test("command approvals become decisions, offering decline even when not listed", () => {
  const rec = load("approval").find((r) => r.msg.method === "item/commandExecution/requestApproval")!;
  const mapped = mapServerRequest(rec.msg.method!, rec.msg.params!);
  assert.equal(mapped.supported, true);
  if (!mapped.supported) return;
  assert.equal(mapped.kind, "command_approval");
  assert.equal(mapped.request.command, "echo approved > approval.txt");
  assert.deepEqual(
    mapped.request.decisions!.map((d) => d.id),
    ["accept", "decline", "cancel"],
  );
});

test("plan-mode questions map to structured questions and answers", () => {
  const rec = load("userinput").find((r) => r.msg.method === "item/tool/requestUserInput")!;
  const mapped = mapServerRequest(rec.msg.method!, rec.msg.params!);
  assert.ok(mapped.supported);
  if (!mapped.supported) return;
  const q = mapped.request.questions![0]!;
  assert.equal(q.id, "preferred_colour");
  assert.deepEqual(
    q.options!.map((o) => o.label),
    ["Red", "Blue"],
  );
  assert.deepEqual(replyFor("question", { kind: "answers", answers: { preferred_colour: ["Red"] } }), {
    answers: { preferred_colour: { answers: ["Red"] } },
  });
});

test("unsupported requests are declined with an explanation", () => {
  const m = mapServerRequest("mcpServer/elicitation/request", { serverName: "notion" });
  assert.equal(m.supported, false);
  if (m.supported) return;
  assert.match(m.reason, /notion/);
  assert.deepEqual(m.reply, { action: "decline", content: null, _meta: null });
});

test("replies are validated against the request kind", () => {
  assert.throws(() => replyFor("command_approval", { kind: "answers", answers: {} }));
  assert.throws(() => replyFor("command_approval", { kind: "decision", decision: "rm -rf" }));
  assert.deepEqual(replyFor("file_approval", { kind: "decision", decision: "accept" }), { decision: "accept" });
});

test("turn status maps to run state, distinguishing requested cancellation", () => {
  assert.equal(runStateForTurn("completed", false), "succeeded");
  assert.equal(runStateForTurn("failed", false), "failed");
  assert.equal(runStateForTurn("interrupted", true), "cancelled");
  assert.equal(runStateForTurn("interrupted", false), "interrupted");
});

test("shell wrappers are removed for display", () => {
  assert.equal(unwrapShell("/bin/bash -lc 'sleep 60 && echo finished'"), "sleep 60 && echo finished");
  assert.equal(unwrapShell(`/bin/bash -lc "pwd && rg -g 'x'"`), "pwd && rg -g 'x'");
  assert.equal(unwrapShell("ls -la"), "ls -la");
});

test("Codex image views and function images keep their source and accompanying text", () => {
  const view = mapItem({ type: "imageView", id: "view", path: "file:///tmp/screen.png" }, true);
  assert.equal(view.kind, "image");
  assert.deepEqual(view.data.images, [{ source: "file:///tmp/screen.png", alt: "Viewed image" }]);
  const output = mapItem(
    {
      type: "functionCallOutput",
      id: "tool",
      name: "capture",
      namespace: null,
      output: [
        { type: "input_text", text: "Screenshot captured" },
        { type: "input_image", image_url: "data:image/png;base64,eA==" },
      ],
    },
    true,
  );
  assert.equal(output.kind, "tool_call");
  assert.equal(output.data.images?.[0]?.source, "data:image/png;base64,eA==");
  assert.deepEqual(output.data.result, [{ type: "input_text", text: "Screenshot captured" }]);
});

test("MCP and dynamic tool images are separated from bounded text results", () => {
  const mcp = mapItem(
    {
      type: "mcpToolCall",
      id: "mcp",
      server: "browser",
      tool: "capture",
      status: "completed",
      arguments: {},
      appContext: null,
      mcpAppUi: null,
      pluginId: null,
      readOnlyHint: true,
      error: null,
      durationMs: null,
      result: {
        content: [
          { type: "text", text: "Captured" },
          { type: "image", data: "eA==", mimeType: "image/png" },
        ],
        structuredContent: null,
        _meta: null,
      },
    },
    true,
  );
  assert.deepEqual(mcp.data.result, [{ type: "text", text: "Captured" }]);
  assert.equal(mcp.data.images?.[0]?.source, "data:image/png;base64,eA==");
  const dynamic = mapItem(
    {
      type: "dynamicToolCall",
      id: "dynamic",
      namespace: null,
      tool: "capture",
      arguments: {},
      status: "completed",
      success: true,
      durationMs: null,
      contentItems: [
        { type: "inputText", text: "Captured" },
        { type: "inputImage", imageUrl: "data:image/png;base64,eA==" },
      ],
    },
    true,
  );
  assert.equal(dynamic.data.images?.[0]?.source, "data:image/png;base64,eA==");
  assert.deepEqual(dynamic.data.result, [{ type: "inputText", text: "Captured" }]);
});
