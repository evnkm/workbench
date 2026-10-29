// B=http://127.0.0.1:5197 node e2e/claude.e2e.mjs
// Disposable browser/API fixtures; no user-state mutations or API spending.
import assert from "node:assert/strict";
import { chromium, devices } from "playwright";

const base = process.env.B ?? "http://127.0.0.1:5197";
const now = new Date().toISOString();
const workspace = {
  id: "w",
  projectId: "p",
  name: "Shared worktree",
  state: "ready",
  branch: "test",
  baseRef: "main",
  worktreePath: "/fixture",
  createdAt: now,
};
const conversation = {
  id: "c",
  workspaceId: "w",
  provider: "claude",
  title: "Claude fixture",
  model: null,
  reasoningEffort: null,
  serviceTier: null,
  approvalPolicy: "never",
  createdAt: now,
  lastActivityAt: now,
};
const peer = { ...conversation, id: "peer", provider: "codex", title: "Parallel Codex" };
const run = {
  id: "peer-run",
  conversationId: "peer",
  workspaceId: "w",
  kind: "agent_turn",
  state: "running",
  summary: "Edit other.ts",
  createdAt: now,
};
const input = {
  id: "question",
  conversationId: "c",
  runId: "own-run",
  kind: "question",
  state: "open",
  request: {
    title: "Claude needs your input",
    questions: [
      {
        id: "0",
        header: "Colors",
        question: "Which colors?",
        multiSelect: true,
        options: [
          { label: "Blue", description: "Blue color" },
          { label: "Red", description: "Red color" },
        ],
        allowOther: true,
        secret: false,
      },
    ],
  },
  createdAt: now,
};
const efforts = ["low", "high", "max"].map((effort) => ({ effort, description: "" }));
const defaultModel = {
  model: "default",
  name: "Default",
  description: "Opus",
  isDefault: true,
  efforts,
  defaultEffort: "",
  serviceTiers: [],
};
const opus = { ...defaultModel, model: "opus", name: "Opus", isDefault: false };
const browser = await chromium.launch();
try {
  for (const [name, options] of [
    ["desktop", { viewport: { width: 1440, height: 1000 } }],
    ["mobile", devices["iPhone 13"]],
  ]) {
    const context = await browser.newContext(options);
    const commands = [];
    const errors = [];
    await context.addInitScript(() => {
      window.EventSource = class extends EventTarget {
        constructor() {
          super();
          setTimeout(() => this.dispatchEvent(new Event("ready")), 5);
        }
        close() {}
      };
    });
    const page = await context.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    await context.route("**/api/**", async (route) => {
      const path = new URL(route.request().url()).pathname;
      if (path === "/api/state")
        return route.fulfill({
          json: {
            cursor: 100,
            projects: [],
            workspaces: [workspace],
            conversations: [conversation, peer],
            activeRuns: [run],
            openInputs: [input],
            processes: [],
            jobs: [],
            worker: {
              heartbeatAt: now,
              codex: { state: "unavailable", error: "Codex not installed" },
              claude: { state: "ready", reason: null },
            },
          },
        });
      if (path.endsWith("/snapshot"))
        return route.fulfill({
          json: { cursor: 100, conversation, items: [], runs: [], inputs: [input], hasMore: false },
        });
      if (path === "/api/commands") {
        const body = route.request().postDataJSON();
        commands.push(body);
        const result =
          body.type !== "conversation.inspect"
            ? { conversationId: "c" }
            : body.payload.view === "commands"
              ? {
                  kind: "commands",
                  commands: [{ name: "compact", description: "Summarize context", argumentHint: "<instructions>" }],
                }
              : { kind: "models", models: [defaultModel, opus] };
        return route.fulfill({ json: { command: { state: "succeeded", result } } });
      }
      return route.fulfill({ json: {} });
    });
    await page.goto(`${base}/w/w/c/c`);
    await page.getByText("1 other session shares this worktree.", { exact: false }).waitFor();
    await page.getByRole("checkbox", { name: "Blue Blue color" }).check();
    await page.getByRole("checkbox", { name: "Red Red color" }).check();
    await page.getByRole("button", { name: "Send answer" }).click();
    await page.waitForTimeout(100);
    assert.deepEqual(commands.find((c) => c.type === "input.respond").payload.response.answers, { 0: ["Blue", "Red"] });
    const message = page.getByRole("combobox", { name: "Message", exact: true });
    assert.equal(await message.isEnabled(), true);
    await message.fill("/");
    const menu = page.getByRole("listbox", { name: "Slash commands" });
    await menu.waitFor();
    assert.equal(await menu.getByRole("option").filter({ hasText: "/reasoning" }).count(), 0);
    assert.equal(await menu.getByRole("option").filter({ hasText: "/effort" }).count(), 1);
    assert.equal(await menu.getByRole("option").filter({ hasText: "/fast" }).count(), 1);
    await menu.getByRole("option").filter({ hasText: "/compact" }).getByText("Claude · <instructions>").waitFor();
    await menu.getByRole("option").filter({ hasText: "/model" }).click();
    const picker = page.getByRole("dialog");
    await picker.getByRole("combobox", { name: "Reasoning effort", exact: true }).waitFor();
    assert.equal(await picker.getByRole("combobox", { name: "Reasoning effort", exact: true }).inputValue(), "");
    await picker.getByRole("combobox").first().selectOption("opus");
    await picker.getByRole("combobox", { name: "Reasoning effort", exact: true }).selectOption("high");
    await page.getByRole("button", { name: "Apply", exact: true }).click();
    await page.waitForTimeout(100);
    assert.deepEqual(commands.find((c) => c.type === "conversation.configure").payload, {
      conversationId: "c",
      model: "opus",
      reasoningEffort: "high",
    });
    // A native command that takes arguments is filled in, then sent to Claude as text.
    await message.fill("/comp");
    await menu.getByRole("option").filter({ hasText: "/compact" }).click();
    assert.equal(await message.inputValue(), "/compact ");
    await message.fill("/compact keep the API notes");
    await page.getByRole("button", { name: "Send", exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(commands.find((c) => c.type === "turn.start").payload.text, "/compact keep the API notes");
    await page.getByRole("button", { name: "New conversation", exact: true }).click();
    const dialog = page.getByRole("dialog");
    const claude = dialog.getByRole("radio").nth(1);
    assert.equal(await claude.isEnabled(), true);
    await claude.check();
    await dialog.getByRole("button", { name: "Start", exact: true }).click();
    await page.waitForTimeout(100);
    assert.equal(commands.find((c) => c.type === "conversation.create").payload.provider, "claude");
    assert.deepEqual(errors, []);
    console.log(`${name}: Claude selection, model, multiple answers, and concurrent-session notice pass`);
    await context.close();
  }
} finally {
  await browser.close();
}
